/**
 * Замер времени отклика на случайных тайлах.
 *
 * Смысл в первом проходе: это стоимость настоящего попадания на диск.
 * Второй проход по тем же тайлам показывает, что даёт кэш.
 *
 *   node tools/bench.js [зум] [сколько] [параллельно]
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8080';

const zoom = Number(process.argv[2] || 17);
const count = Number(process.argv[3] || 200);
const concurrency = Number(process.argv[4] || 6);

const info = await (await fetch(`${BASE}/api/info`)).json();

// Берём случайные тайлы внутри покрытой области.
const [w, s, e, n] = info.bounds;
const N = 2 ** zoom;
const lon2x = (lon) => Math.floor(((lon + 180) / 360) * N);
const lat2y = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N);
};

const xMin = lon2x(w);
const xMax = lon2x(e);
const yMin = lat2y(n);
const yMax = lat2y(s);

const targets = [];
for (let i = 0; i < count; i++) {
  targets.push([
    zoom,
    xMin + Math.floor(Math.random() * (xMax - xMin)),
    yMin + Math.floor(Math.random() * (yMax - yMin)),
  ]);
}

async function pass(label, list) {
  const times = [];
  let bytes = 0;
  let empty = 0;
  let i = 0;
  const t0 = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < list.length) {
        const [z, x, y] = list[i++];
        const start = performance.now();
        const res = await fetch(`${BASE}/tiles/${z}/${x}/${y}`);
        const buf = await res.arrayBuffer();
        times.push(performance.now() - start);
        if (res.status === 204 || buf.byteLength === 0) empty++;
        else bytes += buf.byteLength;
      }
    })
  );

  const wall = performance.now() - t0;
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];

  console.log(
    `${label.padEnd(16)} p50 ${q(0.5).toFixed(1).padStart(7)} мс   ` +
      `p95 ${q(0.95).toFixed(1).padStart(7)} мс   ` +
      `max ${q(1).toFixed(1).padStart(7)} мс   ` +
      `${(list.length / (wall / 1000)).toFixed(0).padStart(5)} тайл/с   ` +
      `${(bytes / 2 ** 20).toFixed(1)} МБ   пусто: ${empty}`
  );
}

console.log(
  `\nзум ${zoom}, тайлов ${count}, параллельно ${concurrency}, ` +
    `файлов готово ${info.filesReady}/${info.filesReady + info.filesPending}\n`
);

await pass('холодный', targets);
await pass('повторный', targets);

const stats = await (await fetch(`${BASE}/api/stats`)).json();
console.log('\nкэш сервера:', JSON.stringify(stats.cache), '\nRSS:', stats.rssMb, 'МБ\n');
