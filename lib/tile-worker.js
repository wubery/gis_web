/**
 * Рабочий поток: держит соединения со всеми .mbtiles и достаёт тайлы.
 *
 * Зачем поток. better-sqlite3 синхронный, а чтение тайла с HDD — это seek
 * примерно на 10 мс. В главном потоке такой вызов блокирует event loop
 * целиком, и сервер обрабатывает тайлы строго по одному. Вынеся чтение
 * в пул потоков, мы позволяем диску держать несколько запросов в очереди
 * одновременно — NCQ переупорядочивает их по положению головки.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openTileDb } from './db-open.js';

const files = workerData.files;

/** Соединения открываются лениво: воркер трогает только те базы, что нужны. */
const dbs = new Map(); // индекс файла -> {db, stmt}

function handleFor(fi) {
  let h = dbs.get(fi);
  if (h !== undefined) return h;

  try {
    const db = openTileDb(files[fi]);
    const stmt = db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    );
    // Отдаём сырой Buffer вместо объекта — на порядок меньше работы для V8
    // на каждом тайле.
    stmt.raw(true);
    h = { db, stmt };
  } catch {
    h = null; // база недоступна — запоминаем это, чтобы не пробовать снова
  }
  dbs.set(fi, h);
  return h;
}

/**
 * Blob из SQLite может лежать во внутреннем пуле Buffer'ов Node. Передавать
 * такой ArrayBuffer как transferable нельзя: отсоединится весь пул вместе
 * с чужими данными. Копируем, если буфер не владеет своей памятью целиком.
 */
function toTransferable(buf) {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer;
  }
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

function closeAll() {
  for (const h of dbs.values()) {
    if (h) {
      try {
        h.db.close();
      } catch {
        /* закрываем как получится */
      }
    }
  }
  dbs.clear();
}

parentPort.on('message', (msg) => {
  if (msg.type === 'refresh') {
    // Появились докопированные файлы — сбрасываем соединения, откроются заново.
    closeAll();
    if (msg.files) files.splice(0, files.length, ...msg.files);
    parentPort.postMessage({ type: 'refreshed' });
    return;
  }

  if (msg.type === 'close') {
    closeAll();
    process.exit(0);
  }

  const { id, fi, z, col, row } = msg;
  const h = handleFor(fi);
  if (h === null) {
    parentPort.postMessage({ id, buf: null });
    return;
  }

  let row0;
  try {
    row0 = h.stmt.get(z, col, row);
  } catch (err) {
    // Повреждённая или ещё дописываемая база: не роняем воркер, отвечаем «нет».
    parentPort.postMessage({ id, buf: null, err: err.message });
    return;
  }

  if (!row0 || !row0[0]) {
    parentPort.postMessage({ id, buf: null });
    return;
  }

  const ab = toTransferable(row0[0]);
  parentPort.postMessage({ id, buf: ab }, [ab]);
});
