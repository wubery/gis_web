/**
 * Пусковой скрипт автономного комплекта.
 *
 * Сервер сам по себе ничего не знает о том, как его запустили, и ждёт путь
 * к картам в переменной MAPS_DIR. Здесь этот путь подбирается сам, чтобы на
 * целевом ПК не нужно было ничего настраивать: положил .mbtiles в папку
 * «карты», запустил ЗАПУСТИТЬ.bat — работает.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Папка комплекта — та, где лежит ЗАПУСТИТЬ.bat. */
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8080);

function countMbtiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mbtiles')).length;
  } catch {
    return 0;
  }
}

// Порядок неслучаен: сначала то, что задали руками, затем своя папка «карты»,
// и только потом соседние — чтобы не подцепить чужой набор раньше своего.
const places = [
  process.env.MAPS_DIR,
  path.join(ROOT, 'карты'),
  ROOT,
  path.resolve(ROOT, '..'),
].filter(Boolean);

const mapsDir = places.find((dir) => countMbtiles(dir) > 0);

if (!mapsDir) {
  console.error('\n  Не нашёл ни одного файла .mbtiles.\n');
  console.error('  Скопируйте карты в эту папку:\n');
  console.error('      ' + path.join(ROOT, 'карты') + '\n');
  console.error('  и запустите ЗАПУСТИТЬ.bat снова.\n');
  process.exit(1);
}

const found = countMbtiles(mapsDir);
console.log(`\n[карты] найдено файлов: ${found}`);
console.log(`[карты] папка: ${mapsDir}`);

// Указателя ещё нет — значит сейчас будет долгий проход по всем файлам.
// Лучше назвать срок заранее, чем оставить человека перед молчащим окном.
// Замер на HDD: 345 секунд на 18 файлов, то есть около 19 секунд на файл.
if (!fs.existsSync(path.join(HERE, 'cache', 'index.json'))) {
  const min = Math.max(1, Math.round((found * 19) / 60));
  console.log(`\n  Первый запуск: строю указатель по картам.`);
  console.log(`  Это займёт около ${min} ${plural(min, 'минуты', 'минут', 'минут')}`);
  console.log('  и делается один раз — дальше запуск будет меньше секунды.');
  console.log('  Окно не закрывайте, ход работы виден ниже.\n');
}

/** Русское склонение после числительного. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

process.env.MAPS_DIR = mapsDir;

await import('./server.js');

/** Один опрос сервера: отвечает ли он уже. */
function ping() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/info', timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Браузер открываем только после того, как сервер начал отвечать. Откроем
// раньше — вкладка встретит «не удалось подключиться», и человек решит,
// что ничего не заработало.
for (let i = 0; i < 200; i++) {
  if (await ping()) {
    spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}/`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    break;
  }
  await new Promise((r) => setTimeout(r, 150));
}
