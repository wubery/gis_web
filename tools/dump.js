/**
 * Скачивает тайлы с работающего сервера в файлы — для глазной проверки
 * ориентации и склейки уровней.
 *
 *   node tools/dump.js <каталог> <z/x/y> [<z/x/y> ...]
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const [outDir, ...specs] = process.argv.slice(2);

if (!outDir || specs.length === 0) {
  console.error('использование: node tools/dump.js <каталог> <z/x/y> ...');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

for (const spec of specs) {
  const [z, x, y] = spec.split('/').map(Number);
  const res = await fetch(`${BASE}/tiles/${z}/${x}/${y}`);
  if (res.status !== 200) {
    console.log(`${spec}: ${res.status} (нет тайла)`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(outDir, `${z}_${x}_${y}.jpg`);
  fs.writeFileSync(file, buf);
  console.log(`${spec}: ${buf.length} Б -> ${file}`);
}
