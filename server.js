/**
 * Локальный тайл-сервер поверх набора .mbtiles.
 *
 * Данные лежат на HDD, поэтому вся конструкция крутится вокруг одной цифры:
 * случайное чтение с этого диска стоит около 10 мс, а на экран нужно ~40 тайлов.
 * Отсюда три меры: пул потоков (диск обслуживает несколько запросов сразу),
 * LRU в памяти (повторное чтение бесплатно) и immutable-кэш в браузере
 * (просмотренный район больше не трогает диск вообще).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { ByteLRU } from './lib/lru.js';
import { loadIndex, fingerprint, routeTile } from './lib/index-builder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  mapsDir: process.env.MAPS_DIR || path.resolve(HERE, '..'),
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  // На HDD больше шести параллельных читателей начинают мешать друг другу:
  // головка мечется, суммарная пропускная способность падает.
  workers: Number(process.env.WORKERS || Math.min(5, Math.max(2, os.cpus().length - 1))),
  // Свободной памяти на машине немного, и страничному кэшу ОС её тоже надо
  // оставить — иначе выигрыш от LRU съедается проигрышем на уровне файловой системы.
  cacheMb: Number(process.env.CACHE_MB || 256),
  rescanMs: Number(process.env.RESCAN_MS || 60_000),
};

const CACHE_FILE = path.join(HERE, 'cache', 'index.json');
const PUBLIC_DIR = path.join(HERE, 'public');

// ── Индекс ────────────────────────────────────────────────────────────────

let index;
let indexFingerprint;

function reloadIndex(reason) {
  const t0 = Date.now();
  const { index: idx, fromCache } = loadIndex(CONFIG.mapsDir, CACHE_FILE);
  index = idx;
  indexFingerprint = fingerprint(CONFIG.mapsDir);

  const ms = Date.now() - t0;
  console.log(
    `\n[индекс] ${reason}: ${idx.files.length} файлов готово, ` +
      `${idx.skipped.length} пропущено ` +
      `(${fromCache ? 'из кэша' : 'собран за ' + ms + ' мс'})`
  );
  console.log(
    `[индекс] зумы ${idx.minzoom}–${idx.maxzoom}, формат ${idx.format}, ` +
      `границы ${idx.bounds.map((v) => v.toFixed(3)).join(', ')}`
  );
  for (const s of idx.skipped) {
    const pct = s.progress ? ` (${(s.progress * 100).toFixed(1)}%)` : '';
    console.log(`[индекс]   пропущен ${path.basename(s.file)} — ${s.reason}${pct}`);
  }
  return idx;
}

// ── Пул воркеров ──────────────────────────────────────────────────────────

class WorkerPool {
  constructor(files, size) {
    this.workers = [];
    this.seq = 0;
    for (let i = 0; i < size; i++) this.workers.push(this.spawn(files, i));
  }

  spawn(files, i) {
    const w = new Worker(new URL('./lib/tile-worker.js', import.meta.url), {
      workerData: { files: [...files] },
    });
    w.unref();
    const state = { worker: w, pending: new Map(), outstanding: 0, index: i };
    w.on('message', (msg) => {
      if (msg.type === 'refreshed') return;
      const resolve = state.pending.get(msg.id);
      if (!resolve) return;
      state.pending.delete(msg.id);
      state.outstanding--;
      resolve(msg.buf ? Buffer.from(msg.buf) : null);
    });
    w.on('error', (err) => {
      console.error(`[воркер ${i}] ошибка:`, err.message);
      for (const resolve of state.pending.values()) resolve(null);
      state.pending.clear();
      state.outstanding = 0;
    });
    return state;
  }

  /**
   * Выбираем наименее загруженный воркер, а не по кругу. Разброс времени
   * чтения огромен — от долей миллисекунды при попадании в кэш ОС до
   * полутора десятков миллисекунд при промахе, — и круговая раздача
   * регулярно ставит запрос в очередь за чужим seek'ом.
   */
  pick() {
    let best = this.workers[0];
    for (const w of this.workers) {
      if (w.outstanding < best.outstanding) best = w;
    }
    return best;
  }

  read(fi, z, col, row) {
    const w = this.pick();
    const id = ++this.seq;
    w.outstanding++;
    return new Promise((resolve) => {
      w.pending.set(id, resolve);
      w.worker.postMessage({ id, fi, z, col, row });
    });
  }

  refresh(files) {
    for (const w of this.workers) w.worker.postMessage({ type: 'refresh', files });
  }

  stats() {
    return this.workers.map((w) => w.outstanding);
  }
}

// ── Кэш и склейка одинаковых запросов ─────────────────────────────────────

const cache = new ByteLRU(CONFIG.cacheMb * 2 ** 20);
/** Тайлы, читаемые прямо сейчас: второй запрос за тем же тайлом ждёт первый. */
const inflight = new Map();
let pool;

async function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;

  const hit = cache.get(key);
  if (hit !== undefined) return hit.value;

  const running = inflight.get(key);
  if (running) return running;

  const fi = routeTile(index, z, x, y);
  if (fi < 0) {
    cache.set(key, null, 64); // отрицательный результат тоже стоит помнить
    return null;
  }

  // MBTiles нумерует строки снизу вверх (TMS), тайловые URL — сверху вниз (XYZ).
  const row = (1 << z) - 1 - y;

  const p = pool
    .read(fi, z, x, row)
    .then((buf) => {
      cache.set(key, buf, buf ? buf.length : 64);
      inflight.delete(key);
      return buf;
    })
    .catch((err) => {
      inflight.delete(key);
      console.error(`[тайл] ${key}:`, err.message);
      return null;
    });

  inflight.set(key, p);
  return p;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

const TILE_RE = /^\/tiles\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})(?:\.\w+)?$/;

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  const m = TILE_RE.exec(pathname);
  if (m) return serveTile(req, res, +m[1], +m[2], +m[3]);

  if (pathname === '/api/info') return serveJson(res, info());
  if (pathname === '/api/stats') return serveJson(res, stats());

  return serveStatic(req, res, pathname);
});

async function serveTile(req, res, z, x, y) {
  if (z < index.minzoom || z > index.maxzoom) {
    return res.writeHead(204, { 'Cache-Control': 'public, max-age=300' }).end();
  }
  const n = 1 << z;
  if (x < 0 || y < 0 || x >= n || y >= n) {
    return res.writeHead(204, { 'Cache-Control': 'public, max-age=300' }).end();
  }

  let buf;
  try {
    buf = await getTile(z, x, y);
  } catch (err) {
    console.error('[тайл] сбой:', err.message);
    return res.writeHead(500).end();
  }

  if (!buf) {
    // Пока идёт копирование, «дырка» может позже стать настоящим тайлом,
    // поэтому промах кэшируется ненадолго.
    return res.writeHead(204, { 'Cache-Control': 'public, max-age=300' }).end();
  }

  const etag = `"${z}.${x}.${y}.${buf.length}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.writeHead(304, { ETag: etag }).end();
  }

  res.writeHead(200, {
    'Content-Type': index.mime,
    'Content-Length': buf.length,
    // Тайл с данными координатами не меняется никогда. immutable избавляет
    // браузер даже от условных запросов — просмотренный район больше
    // не создаёт сетевого трафика вообще.
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
  });
  // Никакого gzip: JPEG уже сжат, повторное сжатие только жжёт процессор.
  if (req.method === 'HEAD') return res.end();
  res.end(buf);
}

function info() {
  return {
    minzoom: index.minzoom,
    maxzoom: index.maxzoom,
    format: index.format,
    mime: index.mime,
    tileSize: 256,
    bounds: index.bounds,
    center: index.center,
    filesReady: index.files.length,
    filesPending: index.skipped.length,
    pending: index.skipped.map((s) => ({
      name: path.basename(s.file),
      reason: s.reason,
      progress: s.progress ?? null,
    })),
  };
}

function stats() {
  return {
    cache: cache.stats(),
    inflight: inflight.size,
    workers: pool.stats(),
    rssMb: +(process.memoryUsage().rss / 2 ** 20).toFixed(1),
    uptimeSec: Math.round(process.uptime()),
  };
}

function serveJson(res, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);

  // Не выпускаем запрос за пределы public/.
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();

  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
}

// ── Запуск ────────────────────────────────────────────────────────────────

reloadIndex('старт');

if (index.files.length === 0) {
  console.error(
    `\nНи одного пригодного .mbtiles в ${CONFIG.mapsDir}.\n` +
      'Если копирование ещё идёт — дождитесь его окончания и запустите снова.\n'
  );
  process.exit(1);
}

pool = new WorkerPool(
  index.files.map((f) => f.file),
  CONFIG.workers
);

// Файлы ещё копируются: периодически проверяем, не появились ли новые целые.
if (index.skipped.length > 0 && CONFIG.rescanMs > 0) {
  const timer = setInterval(() => {
    if (fingerprint(CONFIG.mapsDir) === indexFingerprint) return;
    const before = index.files.length;
    reloadIndex('пересканирование');
    if (index.files.length !== before) {
      pool.refresh(index.files.map((f) => f.file));
      cache.clear(); // могли закэшироваться промахи по тайлам, которые уже есть
      console.log('[индекс] подключены новые файлы, кэш сброшен');
    }
    if (index.skipped.length === 0) {
      clearInterval(timer);
      console.log('[индекс] все файлы на месте, пересканирование выключено');
    }
  }, CONFIG.rescanMs);
  timer.unref();
}

// Держим соединения открытыми: тайлы идут пачками по 6, переустановка TCP
// на каждую пачку — заметная доля времени отклика в локальной сети.
server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;

server.listen(CONFIG.port, CONFIG.host, () => {
  const addrs = ['localhost'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log(`\n[сервер] воркеров: ${CONFIG.workers}, кэш: ${CONFIG.cacheMb} МБ`);
  console.log('[сервер] открывайте:');
  for (const a of addrs) console.log(`           http://${a}:${CONFIG.port}/`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nостановка…');
    server.close();
    process.exit(0);
  });
}
