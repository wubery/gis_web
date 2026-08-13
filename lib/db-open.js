/**
 * Единственное место, где проект знает о конкретном движке SQLite.
 *
 * Если better-sqlite3 когда-нибудь не соберётся под новый Node, заменить
 * реализацию openTileDb на встроенный `node:sqlite` нужно будет только здесь —
 * остальной код работает через возвращаемый интерфейс {prepare, close}.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';

/** Формат тайла -> MIME. Определяется по metadata или по магическим байтам. */
const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Проверка, что файл скопирован целиком.
 *
 * Заголовок SQLite хранит размер страницы (смещение 16, 2 байта BE) и число
 * страниц в базе (смещение 28, 4 байта BE). Их произведение — настоящий размер
 * базы. Пока копирование идёт, файл на диске меньше, и любой запрос к нему
 * упадёт с SQLITE_CORRUPT. Дешевле отсеять такие файлы заранее, чем ловить
 * исключения на каждом тайле.
 */
export function inspectFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'нет доступа к файлу' };
  }
  if (st.size < 100) {
    return { ok: false, reason: 'пустой файл', size: st.size, expected: 0 };
  }

  const head = Buffer.alloc(100);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 100, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (head.toString('latin1', 0, 15) !== 'SQLite format 3') {
    return { ok: false, reason: 'не база SQLite', size: st.size, expected: 0 };
  }

  let pageSize = head.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const pageCount = head.readUInt32BE(28);
  const expected = pageSize * pageCount;

  // pageCount == 0 бывает у баз, записанных очень старым SQLite; тогда
  // проверить нечем и остаётся довериться файлу.
  if (pageCount > 0 && st.size < expected) {
    return {
      ok: false,
      reason: 'копирование не завершено',
      size: st.size,
      expected,
      progress: st.size / expected,
    };
  }

  return { ok: true, size: st.size, expected, mtimeMs: st.mtimeMs };
}

/** Открывает базу только на чтение и настраивает её под наш профиль нагрузки. */
export function openTileDb(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });

  // Запрещаем любые записи на уровне соединения — защита от опечатки в SQL.
  db.pragma('query_only = 1');
  // 32 МБ страничного кэша на соединение. Держит в памяти верхние уровни
  // B-дерева индекса, так что поиск тайла почти никогда не читает их с диска.
  db.pragma('cache_size = -32000');
  // 256 МБ окна mmap: чтение идёт через страничный кэш ОС без копирования
  // в пользовательский буфер.
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');

  return db;
}

/**
 * Разбирает структуру базы: как называется таблица тайлов, в каком формате
 * лежат картинки, какие зумы есть.
 *
 * Ничего не принимает на веру: metadata в файлах SAS.Planet врёт (bounds там
 * стоит на весь мир), поэтому всё, что можно посчитать по данным, считается
 * по данным.
 */
export function describeDb(db) {
  const objects = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')")
    .all();
  const names = new Set(objects.map((o) => o.name));

  if (!names.has('tiles')) {
    throw new Error('в базе нет tiles — это не MBTiles');
  }

  const cols = db.prepare('PRAGMA table_info(tiles)').all().map((c) => c.name);
  for (const need of ['zoom_level', 'tile_column', 'tile_row', 'tile_data']) {
    if (!cols.includes(need)) {
      throw new Error(`в tiles нет колонки ${need}`);
    }
  }

  // Формат: сначала спрашиваем metadata...
  let format = null;
  if (names.has('metadata')) {
    const row = db
      .prepare("SELECT value FROM metadata WHERE name = 'format'")
      .get();
    if (row?.value) format = String(row.value).toLowerCase();
  }

  // ...а если её нет или она врёт — нюхаем магические байты первого тайла.
  const sample = db
    .prepare('SELECT tile_data FROM tiles LIMIT 1')
    .get()?.tile_data;
  const sniffed = sample ? sniffFormat(sample) : null;
  if (sniffed) format = sniffed;
  if (!format) format = 'jpg';

  const zooms = db
    .prepare('SELECT DISTINCT zoom_level AS z FROM tiles ORDER BY z')
    .all()
    .map((r) => r.z);

  return {
    format,
    mime: MIME[format] ?? 'application/octet-stream',
    minzoom: zooms.length ? zooms[0] : 0,
    maxzoom: zooms.length ? zooms[zooms.length - 1] : 0,
    zooms,
  };
}

function sniffFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export { MIME };
