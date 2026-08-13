/**
 * Таблица маршрутизации: какой из .mbtiles содержит данный тайл.
 *
 * Идея. Каждый файл в этом наборе — полная пирамида под одной клеткой z9
 * (имена вида «305х172» это и есть z9 XYZ). Значит для любого тайла глубже z9
 * достаточно сдвинуть координаты до z9 и посмотреть в готовую карту — ноль
 * обращений к диску на маршрутизацию.
 *
 * Но полагаться на имена файлов мы не будем: карта строится по фактическому
 * содержимому баз. Тайлов на z0..z9 в каждом файле по одному, так что построение
 * читает считанные килобайты.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspectFile, openTileDb, describeDb } from './db-open.js';

/** До этого зума маршрут ищется в карте, глубже — вычисляется сдвигом. */
export const ROUTE_ZOOM = 9;

const INDEX_VERSION = 3;

export function listMapFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mbtiles'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Строит индекс по всем пригодным файлам каталога.
 * Недокопированные и битые файлы не роняют сборку, а попадают в `skipped`.
 */
export function buildIndex(dir) {
  const files = listMapFiles(dir);
  const ready = [];
  const skipped = [];

  for (const file of files) {
    const probe = inspectFile(file);
    if (!probe.ok) {
      skipped.push({ file, ...probe });
      continue;
    }
    try {
      const db = openTileDb(file);
      try {
        const info = describeDb(db);
        ready.push({ file, db, info, size: probe.size, mtimeMs: probe.mtimeMs });
      } catch (err) {
        db.close();
        skipped.push({ file, ok: false, reason: err.message });
      }
    } catch (err) {
      skipped.push({ file, ok: false, reason: err.message });
    }
  }

  if (ready.length === 0) {
    for (const r of ready) r.db.close();
    return {
      version: INDEX_VERSION,
      files: [],
      skipped,
      routes: {},
      routeZoom: ROUTE_ZOOM,
      minzoom: 0,
      maxzoom: 0,
      format: 'jpg',
      mime: 'image/jpeg',
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 2],
    };
  }

  const minzoom = Math.min(...ready.map((r) => r.info.minzoom));
  const maxzoom = Math.max(...ready.map((r) => r.info.maxzoom));
  const routeZoom = Math.min(ROUTE_ZOOM, maxzoom);

  const routes = {};
  const routeCells = []; // клетки уровня routeZoom — из них считаем границы

  ready.forEach((entry, fileIndex) => {
    for (let z = entry.info.minzoom; z <= Math.min(routeZoom, entry.info.maxzoom); z++) {
      let rows;
      try {
        rows = entry.db
          .prepare(
            'SELECT DISTINCT tile_column AS col, tile_row AS row FROM tiles WHERE zoom_level = ?'
          )
          .all(z);
      } catch {
        continue; // повреждённый участок базы — просто не маршрутизируем через неё
      }
      const n = 1 << z;
      for (const { col, row } of rows) {
        // MBTiles хранит строки в TMS (снизу вверх), а схема XYZ считает сверху.
        const y = n - 1 - row;
        const key = `${z}/${col}/${y}`;
        // Пирамиды малых зумов у файлов пересекаются — побеждает первый.
        if (routes[key] === undefined) routes[key] = fileIndex;
        if (z === routeZoom) routeCells.push([col, y]);
      }
    }
  });

  const bounds = boundsOfCells(routeCells, routeZoom);

  const result = {
    version: INDEX_VERSION,
    routeZoom,
    minzoom,
    maxzoom,
    format: ready[0].info.format,
    mime: ready[0].info.mime,
    bounds,
    center: [
      (bounds[0] + bounds[2]) / 2,
      (bounds[1] + bounds[3]) / 2,
      Math.min(maxzoom, routeZoom + 1),
    ],
    routes,
    files: ready.map((r) => ({
      file: r.file,
      size: r.size,
      mtimeMs: r.mtimeMs,
      minzoom: r.info.minzoom,
      maxzoom: r.info.maxzoom,
      format: r.info.format,
    })),
    skipped: skipped.map((s) => ({
      file: s.file,
      reason: s.reason,
      progress: s.progress,
      size: s.size,
      expected: s.expected,
    })),
  };

  for (const r of ready) r.db.close();
  return result;
}

/** Границы объединения клеток заданного зума, в градусах [w, s, e, n]. */
function boundsOfCells(cells, z) {
  if (cells.length === 0) return [-180, -85.05112878, 180, 85.05112878];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const n = 1 << z;
  return [
    (minX / n) * 360 - 180,
    tileYToLat(maxY + 1, n), // юг — это нижняя граница самой южной клетки
    ((maxX + 1) / n) * 360 - 180,
    tileYToLat(minY, n),
  ];
}

function tileYToLat(y, n) {
  const t = Math.PI * (1 - (2 * y) / n);
  return (180 / Math.PI) * Math.atan(Math.sinh(t));
}

/** Ключ, по которому понятно, что кэш индекса устарел. */
export function fingerprint(dir) {
  return listMapFiles(dir)
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${path.basename(f)}:${st.size}:${Math.round(st.mtimeMs)}`;
      } catch {
        return `${path.basename(f)}:missing`;
      }
    })
    .join('|');
}

/**
 * Строит индекс или поднимает его из кэша.
 * На HDD полная сборка по 18 файлам занимает секунды; кэш делает перезапуск
 * сервера мгновенным.
 */
export function loadIndex(dir, cacheFile) {
  const fp = fingerprint(dir);

  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.version === INDEX_VERSION && cached.fingerprint === fp) {
        return { index: cached.index, fromCache: true };
      }
    } catch {
      // повреждённый кэш — просто пересобираем
    }
  }

  const index = buildIndex(dir);

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ version: INDEX_VERSION, fingerprint: fp, index })
      );
    } catch {
      // кэш не обязателен
    }
  }

  return { index, fromCache: false };
}

/**
 * Находит номер файла, содержащего тайл.
 * Для z > routeZoom координаты сдвигаются к предку — это чистая арифметика.
 */
export function routeTile(index, z, x, y) {
  const rz = index.routeZoom;
  if (z <= rz) {
    const fi = index.routes[`${z}/${x}/${y}`];
    return fi === undefined ? -1 : fi;
  }
  const dz = z - rz;
  const fi = index.routes[`${rz}/${x >> dz}/${y >> dz}`];
  return fi === undefined ? -1 : fi;
}
