/**
 * Просмотрщик растровых тайлов на canvas. Без зависимостей.
 *
 * Данные лежат на HDD: каждый несчитанный тайл — это примерно 10 мс ожидания,
 * а на экран их нужно несколько десятков. Поэтому главный приём здесь —
 * никогда не показывать пустоту: если нужного тайла ещё нет, на его место
 * рисуется кусок уже загруженного тайла-предка, растянутый до нужного размера.
 * Картинка появляется мгновенно и «дорезкается» по мере подгрузки, вместо того
 * чтобы моргать серыми квадратами.
 */
'use strict';

const TILE = 256;

/** Сколько готовых картинок держим в памяти. 600 × 256² × 4Б ≈ 150 МБ. */
const MAX_TILES = 600;
/** Браузер всё равно не даёт больше 6 соединений на хост по HTTP/1.1. */
const MAX_ACTIVE = 6;
/** На сколько уровней вверх ищем предка для подмены. */
const FALLBACK_DEPTH = 6;
/** Насколько глубже родных тайлов разрешаем увеличивать (просто растяжением). */
const OVERZOOM = 2;

// ── Состояние ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d', { alpha: false });

let cfg = null;
/** Центр вида в нормализованных координатах Меркатора + дробный зум. */
const view = { wx: 0.5, wy: 0.5, zoom: 2 };

let cssW = 0;
let cssH = 0;
let dpr = 1;
let dirty = true;
/** Пока размер холста неизвестен, вид считать не из чего и хэш писать нельзя. */
let sized = false;

const tiles = new Map(); // ключ -> ImageBitmap, порядок вставки = LRU
const missing = new Set(); // тайлы, которых на сервере нет
const inflight = new Map(); // ключ -> AbortController
let queue = [];
let active = 0;

let anim = null; // анимация зума
let inertia = null; // инерция после броска
let prefetchOn = false;
let prefetchTimer = 0;

const debug = new URLSearchParams(location.search).has('debug');

// ── Проекция ──────────────────────────────────────────────────────────────

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Русское склонение после числительного: 1 файл, 2 файла, 5 файлов. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const lon2wx = (lon) => (lon + 180) / 360;

function lat2wy(lat) {
  const s = Math.sin((clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

const wx2lon = (wx) => wx * 360 - 180;

function wy2lat(wy) {
  const n = Math.PI * (1 - 2 * wy);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** CSS-пикселей на единицу мира при текущем зуме. */
const worldScale = () => TILE * Math.pow(2, view.zoom);

function screenToWorld(px, py) {
  const s = worldScale();
  return {
    wx: view.wx + (px - cssW / 2) / s,
    wy: view.wy + (py - cssH / 2) / s,
  };
}

/** Двигает вид так, чтобы точка мира оказалась под указанной точкой экрана. */
function setWorldAt(world, px, py) {
  const s = worldScale();
  view.wx = world.wx - (px - cssW / 2) / s;
  view.wy = world.wy - (py - cssH / 2) / s;
  clampView();
}

function clampView() {
  if (!cfg) return;
  view.zoom = clamp(view.zoom, cfg.minViewZoom, cfg.maxViewZoom);
  view.wx = clamp(view.wx, cfg.wxMin, cfg.wxMax);
  view.wy = clamp(view.wy, cfg.wyMin, cfg.wyMax);
}

// ── Кэш картинок ──────────────────────────────────────────────────────────

const key = (z, x, y) => z + '/' + x + '/' + y;

function cacheGet(k) {
  const b = tiles.get(k);
  if (b !== undefined) {
    // Обращение делает тайл самым свежим — так вытесняется то, на что
    // давно не смотрели, а не то, что прямо сейчас на экране.
    tiles.delete(k);
    tiles.set(k, b);
  }
  return b;
}

function cachePut(k, bmp) {
  const old = tiles.get(k);
  if (old) {
    old.close();
    tiles.delete(k);
  }
  tiles.set(k, bmp);
  while (tiles.size > MAX_TILES) {
    const oldest = tiles.keys().next().value;
    // close() обязателен: без него память из-под ImageBitmap не возвращается
    // до сборки мусора, и вкладка растёт неограниченно.
    tiles.get(oldest).close();
    tiles.delete(oldest);
  }
}

// ── Загрузка ──────────────────────────────────────────────────────────────

function pump() {
  if (queue.length === 0) return;
  // Ближе к центру экрана — раньше: пользователь смотрит именно туда.
  queue.sort((a, b) => a.pri - b.pri);
  while (active < MAX_ACTIVE && queue.length > 0) {
    const t = queue.shift();
    if (tiles.has(t.k) || missing.has(t.k) || inflight.has(t.k)) continue;
    load(t);
  }
}

async function load(t) {
  active++;
  const ctrl = new AbortController();
  inflight.set(t.k, ctrl);
  try {
    const res = await fetch('/tiles/' + t.z + '/' + t.x + '/' + t.y, {
      signal: ctrl.signal,
    });
    if (res.status === 204) {
      missing.add(t.k);
      return;
    }
    if (!res.ok) return;
    const blob = await res.blob();
    if (blob.size === 0) {
      missing.add(t.k);
      return;
    }
    // createImageBitmap декодирует вне главного потока и отдаёт объект,
    // который drawImage рисует без повторного декодирования.
    const bmp = await createImageBitmap(blob);
    cachePut(t.k, bmp);
    dirty = true;
  } catch (err) {
    // AbortError — штатная отмена ушедшего с экрана тайла.
    if (err.name !== 'AbortError' && debug) console.warn(t.k, err);
  } finally {
    active--;
    inflight.delete(t.k);
    schedule();
    pump();
  }
}

// ── Отрисовка ─────────────────────────────────────────────────────────────

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = canvas.clientWidth;
  cssH = canvas.clientHeight;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  dirty = true;
  if (!cfg) return;

  // Отдалять дальше «вся область плюс запас» бессмысленно: регион
  // превращается в точку посреди пустого мира. Заодно это делает лестницу
  // зумов осмысленной — иначе половина её шкалы ушла бы на z0–z7,
  // где от данных не видно ничего.
  const fz = fitZoomFor();
  if (isFinite(fz)) cfg.minViewZoom = Math.max(cfg.absMinZoom, Math.floor(fz) - 1);
  buildLadder();

  // Холст может стартовать нулевым — например, если страницу открыли
  // в фоновой вкладке. Начальный вид тогда считать не из чего (fitBounds
  // получил бы log2(0) = -Infinity), поэтому ждём первого ненулевого размера.
  if (!sized && cssW > 0 && cssH > 0) {
    sized = true;
    if (!readHash()) fitBounds();
    interacted();
  }
}

/**
 * Рисует тайл, а если его нет — лучшую доступную замену.
 * Возвращает true, если удалось нарисовать хоть что-то.
 */
function drawBest(z, x, y, sx, sy, size) {
  const b = cacheGet(key(z, x, y));
  if (b !== undefined) {
    ctx.drawImage(b, sx, sy, size, size);
    return true;
  }

  // Вверх по пирамиде: у предка берём тот кусок, который соответствует
  // нашему тайлу, и растягиваем. Чем выше поднялись — тем мыльнее, но это
  // всегда лучше пустого места.
  for (let dz = 1; dz <= FALLBACK_DEPTH; dz++) {
    const az = z - dz;
    if (az < cfg.minzoom) break;
    const ab = cacheGet(key(az, x >> dz, y >> dz));
    if (ab === undefined) continue;
    const f = 1 << dz;
    const sub = TILE / f;
    const ox = (x - ((x >> dz) << dz)) * sub;
    const oy = (y - ((y >> dz) << dz)) * sub;
    ctx.drawImage(ab, ox, oy, sub, sub, sx, sy, size, size);
    return true;
  }

  // Вниз: при отдалении уже загруженные детальные тайлы складываются
  // в четвертинки — картинка остаётся резкой там, где данные есть.
  let any = false;
  const half = size / 2;
  for (let i = 0; i < 4; i++) {
    const cb = cacheGet(key(z + 1, x * 2 + (i & 1), y * 2 + (i >> 1)));
    if (cb === undefined) continue;
    ctx.drawImage(cb, sx + (i & 1) * half, sy + (i >> 1) * half, half, half);
    any = true;
  }
  return any;
}

function render() {
  if (!cfg || !sized) return;

  // Анимация зума: пересчитываем вид так, чтобы точка под курсором стояла.
  if (anim) {
    const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
    const e = 1 - (1 - t) * (1 - t);
    view.zoom = anim.from + (anim.to - anim.from) * e;
    setWorldAt(anim.world, anim.px, anim.py);
    if (t >= 1) anim = null;
    else dirty = true;
  }

  if (inertia) {
    view.wx += inertia.x;
    view.wy += inertia.y;
    inertia.x *= 0.9;
    inertia.y *= 0.9;
    clampView();
    if (Math.hypot(inertia.x, inertia.y) * worldScale() < 0.25) inertia = null;
    else dirty = true;
  }

  const W = canvas.width;
  const H = canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1c1c1e';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';

  // Родной зум тайлов: округляем, а за пределами данных упираемся в maxzoom
  // и просто растягиваем — это и есть overzoom.
  const z = clamp(Math.round(view.zoom), cfg.minzoom, cfg.maxzoom);
  const n = 1 << z;
  const size = TILE * Math.pow(2, view.zoom - z) * dpr; // размер тайла на экране
  const originX = view.wx * n * size;
  const originY = view.wy * n * size;

  const margin = prefetchOn ? 1 : 0;
  const x0 = Math.floor((originX - W / 2) / size) - margin;
  const x1 = Math.floor((originX + W / 2) / size) + margin;
  const y0 = Math.floor((originY - H / 2) / size) - margin;
  const y1 = Math.floor((originY + H / 2) / size) + margin;

  queue = [];
  const wanted = new Set();

  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = x0; tx <= x1; tx++) {
      if (tx < 0 || tx >= n) continue;

      const sx = tx * size - originX + W / 2;
      const sy = ty * size - originY + H / 2;
      const visible = sx < W && sy < H && sx + size > 0 && sy + size > 0;

      // Округление к целым пикселям убирает щели между тайлами, которые
      // иначе вылезают из-за дробного масштаба.
      if (visible) {
        const rx = Math.round(sx);
        const ry = Math.round(sy);
        const rw = Math.round(sx + size) - rx;
        drawBest(z, tx, ty, rx, ry, rw);
      }

      const k = key(z, tx, ty);
      wanted.add(k);
      if (!tiles.has(k) && !missing.has(k)) {
        const dx = sx + size / 2 - W / 2;
        const dy = sy + size / 2 - H / 2;
        queue.push({ k, z, x: tx, y: ty, pri: Math.hypot(dx, dy) });
      }
    }
  }

  // На простое подтягиваем ещё и уровень выше: это страховка для подмены —
  // при следующем рывке зума или панорамирования будет чем закрыть дыру.
  if (prefetchOn && z - 1 >= cfg.minzoom) {
    for (let ty = y0 >> 1; ty <= y1 >> 1; ty++) {
      for (let tx = x0 >> 1; tx <= x1 >> 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= n >> 1 || ty >= n >> 1) continue;
        const k = key(z - 1, tx, ty);
        wanted.add(k);
        if (!tiles.has(k) && !missing.has(k)) {
          queue.push({ k, z: z - 1, x: tx, y: ty, pri: 1e6 });
        }
      }
    }
  }

  // Отменяем то, что уехало за экран. Серверу это не вредит: он всё равно
  // положит дочитанный тайл в свой кэш, так что работа диска не пропадает.
  for (const [k, ctrl] of inflight) {
    if (!wanted.has(k)) ctrl.abort();
  }

  if (debug) drawDebugGrid(z, n, size, originX, originY, W, H);

  // Пользовательские объекты рисуются поверх тайлов (см. objects.js).
  if (typeof drawOverlay === 'function') drawOverlay();

  pump();
  updateHud();
}

/** Мировые координаты -> пиксели холста. Нужно objects.js для отрисовки. */
function worldToCanvas(wx, wy) {
  const s = TILE * Math.pow(2, view.zoom) * dpr;
  return {
    x: (wx - view.wx) * s + canvas.width / 2,
    y: (wy - view.wy) * s + canvas.height / 2,
  };
}

function drawDebugGrid(z, n, size, originX, originY, W, H) {
  ctx.strokeStyle = 'rgba(0,255,180,0.35)';
  ctx.fillStyle = 'rgba(0,255,180,0.9)';
  ctx.font = 11 * dpr + 'px monospace';
  ctx.lineWidth = 1;
  const x0 = Math.floor((originX - W / 2) / size);
  const x1 = Math.floor((originX + W / 2) / size);
  const y0 = Math.floor((originY - H / 2) / size);
  const y1 = Math.floor((originY + H / 2) / size);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const sx = tx * size - originX + W / 2;
      const sy = ty * size - originY + H / 2;
      ctx.strokeRect(sx + 0.5, sy + 0.5, size - 1, size - 1);
      ctx.fillText(z + '/' + tx + '/' + ty, sx + 6 * dpr, sy + 16 * dpr);
    }
  }
}

function frame() {
  if (dirty) {
    dirty = false;
    render();
  }
  requestAnimationFrame(frame);
}

function schedule() {
  dirty = true;
}

/** Любое действие пользователя откладывает предзагрузку. */
function interacted() {
  prefetchOn = false;
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchOn = true;
    dirty = true;
  }, 180);
  dirty = true;
  saveHashSoon();
}

// ── HUD ───────────────────────────────────────────────────────────────────

const coordsVal = document.getElementById('coordsVal');
const zoomVal = document.getElementById('zoomVal');
const progressEl = document.getElementById('progress');
const scalebarLine = document.getElementById('scalebarLine');
const scalebarText = document.getElementById('scalebarText');

let cursorLL = null;

function updateHud() {
  const ll = cursorLL ?? { lat: wy2lat(view.wy), lon: wx2lon(view.wx) };
  const text = ll.lat.toFixed(5) + ', ' + ll.lon.toFixed(5);
  if (coordsVal.textContent !== text) coordsVal.textContent = text;

  const z = 'зум ' + view.zoom.toFixed(1);
  if (zoomVal.textContent !== z) zoomVal.textContent = z;

  // Счётчик оставшихся тайлов был бы шумом: на HDD он почти не замолкает.
  // Достаточно знать, идёт загрузка или нет.
  progressEl.classList.toggle('active', queue.length + active > 0);

  updateScalebar();
  updateLadder();
}

// ── Лестница зумов ────────────────────────────────────────────────────────
//
// Зум растровой карты — не плавная величина, а лестница готовых пирамид.
// Штрих на уровень: сплошной там, где тайлы есть, полый выше cfg.maxzoom,
// где картинки уже нет и она просто растягивается. Эту границу иначе
// никак не видно, а знать про неё важно — за ней подробностей не прибавится.

const ladderEl = document.getElementById('ladder');
const ladderTicks = document.getElementById('ladderTicks');
const ladderValue = document.getElementById('ladderValue');

let ladderLevels = [];
let ladderRange = '';
let ladderMark = '';
let ladderDrag = false;

function buildLadder() {
  const lo = Math.ceil(cfg.minViewZoom);
  const hi = Math.floor(cfg.maxViewZoom);
  const range = lo + ':' + hi + ':' + cfg.maxzoom;
  if (range === ladderRange) return;
  ladderRange = range;

  ladderLevels = [];
  ladderTicks.textContent = '';
  for (let z = lo; z <= hi; z++) {
    const el = document.createElement('div');
    // column-reverse у трека: первый добавленный штрих оказывается внизу.
    el.className = z > cfg.maxzoom ? 'tick over' : 'tick';
    ladderTicks.appendChild(el);
    ladderLevels.push(z);
  }
  ladderMark = '';
}

function updateLadder() {
  if (ladderLevels.length === 0) return;

  // Классы трогаем, только когда зум действительно изменился: иначе
  // каждое движение мыши гоняло бы пересчёт стилей на всех штрихах.
  const mark = view.zoom.toFixed(2);
  if (mark === ladderMark) return;
  ladderMark = mark;

  const now = Math.round(view.zoom);
  const nodes = ladderTicks.children;
  for (let i = 0; i < nodes.length; i++) {
    const z = ladderLevels[i];
    nodes[i].classList.toggle('reached', z <= view.zoom + 0.001);
    nodes[i].classList.toggle('now', z === now);
  }
  ladderValue.textContent = 'зум ' + view.zoom.toFixed(1);
}

/** Тянем лестницу — зумим относительно центра экрана. */
function ladderSeek(clientY) {
  const r = ladderTicks.parentElement.getBoundingClientRect();
  if (r.height === 0) return;
  const lo = ladderLevels[0];
  const hi = ladderLevels[ladderLevels.length - 1];
  const t = clamp(1 - (clientY - r.top) / r.height, 0, 1);
  anim = null;
  inertia = null;
  view.zoom = clamp(lo + t * (hi - lo), cfg.minViewZoom, cfg.maxViewZoom);
  clampView();
  interacted();
}

ladderEl.addEventListener('pointerdown', (e) => {
  if (!cfg) return;
  ladderEl.setPointerCapture(e.pointerId);
  ladderDrag = true;
  ladderValue.classList.add('on');
  ladderSeek(e.clientY);
  e.preventDefault();
});

ladderEl.addEventListener('pointermove', (e) => {
  if (ladderDrag) ladderSeek(e.clientY);
});

for (const ev of ['pointerup', 'pointercancel']) {
  ladderEl.addEventListener(ev, () => {
    ladderDrag = false;
    ladderValue.classList.remove('on');
  });
}

function updateScalebar() {
  const lat = wy2lat(view.wy);
  const mPerPx =
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, view.zoom);
  const target = 90 * mPerPx; // хотим полоску примерно в 90 пикселей
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].find((f) => f * pow >= target) * pow;
  scalebarLine.style.width = Math.round(nice / mPerPx) + 'px';
  scalebarText.textContent = nice >= 1000 ? nice / 1000 + ' км' : nice + ' м';
}

// ── Управление ────────────────────────────────────────────────────────────

const pointers = new Map();
let pinch = null;
let vel = null;
/**
 * Сколько палец проехал с момента нажатия. Нужно, чтобы отличить клик
 * (постановка точки) от перетаскивания карты: в режиме рисования должно
 * работать и то, и другое.
 */
let press = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add('dragging');
  anim = null;
  inertia = null;
  vel = { x: 0, y: 0, t: performance.now() };
  pinch = pointers.size === 2 ? pinchState() : null;
  press = pointers.size === 1 ? { x: e.clientX, y: e.clientY, moved: 0 } : null;
  interacted();
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  cursorLL = null;

  if (!pointers.has(e.pointerId)) {
    // Просто наведение — показываем координаты под курсором.
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    cursorLL = { lat: wy2lat(w.wy), lon: wx2lon(w.wx) };
    if (typeof overlayHover === 'function') {
      overlayHover(e.clientX - rect.left, e.clientY - rect.top);
    }
    updateHud();
    return;
  }

  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (press) {
    press.moved = Math.max(
      press.moved,
      Math.hypot(e.clientX - press.x, e.clientY - press.y)
    );
  }

  if (pointers.size >= 2) {
    const now = pinchState();
    if (pinch) {
      // Точку мира под старой серединой пальцев ставим под новую середину
      // и одновременно меняем зум — так пинч тянет и масштабирует разом.
      const world = screenToWorld(pinch.mx - rect.left, pinch.my - rect.top);
      view.zoom = clamp(
        view.zoom + Math.log2(now.dist / pinch.dist),
        cfg.minViewZoom,
        cfg.maxViewZoom
      );
      setWorldAt(world, now.mx - rect.left, now.my - rect.top);
    }
    pinch = now;
    interacted();
    return;
  }

  const s = worldScale();
  const dx = (e.clientX - prev.x) / s;
  const dy = (e.clientY - prev.y) / s;
  view.wx -= dx;
  view.wy -= dy;
  clampView();

  const t = performance.now();
  const dt = Math.max(1, t - vel.t);
  // Сглаживаем скорость, иначе последний дёрганый кадр задаёт всю инерцию.
  vel.x = vel.x * 0.7 - (dx / dt) * 0.3 * 16;
  vel.y = vel.y * 0.7 - (dy / dt) * 0.3 * 16;
  vel.t = t;

  interacted();
});

function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

function endPointer(e) {
  const wasClick = press !== null && press.moved < 6 && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    canvas.classList.remove('dragging');
    if (vel && Math.hypot(vel.x, vel.y) * worldScale() > 1.5) {
      inertia = { x: vel.x, y: vel.y };
      dirty = true;
    }
    vel = null;
    press = null;
  }
  // Карту не тащили — значит это клик по объекту или постановка точки.
  if (wasClick && e.type === 'pointerup' && typeof overlayClick === 'function') {
    const rect = canvas.getBoundingClientRect();
    overlayClick(e.clientX - rect.left, e.clientY - rect.top);
  }
  interacted();
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  cursorLL = null;
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    let d = -e.deltaY;
    if (e.deltaMode === 1) d *= 16; // строки
    else if (e.deltaMode === 2) d *= 100; // страницы
    // ctrlKey — это пинч на тачпаде, он приходит мелкими дельтами.
    const step = clamp(d / (e.ctrlKey ? 100 : 320), -1.2, 1.2);
    zoomTo((anim ? anim.to : view.zoom) + step, e.clientX - rect.left, e.clientY - rect.top);
  },
  { passive: false }
);

canvas.addEventListener('dblclick', (e) => {
  // В режиме рисования двойной клик завершает фигуру, а не зумит.
  if (typeof overlayDblClick === 'function' && overlayDblClick()) return;
  const rect = canvas.getBoundingClientRect();
  const step = e.shiftKey ? -1 : 1;
  zoomTo((anim ? anim.to : view.zoom) + step, e.clientX - rect.left, e.clientY - rect.top);
});

function zoomTo(target, px, py) {
  anim = {
    from: view.zoom,
    to: clamp(target, cfg.minViewZoom, cfg.maxViewZoom),
    px,
    py,
    world: screenToWorld(px, py),
    t0: performance.now(),
    dur: 140,
  };
  inertia = null;
  interacted();
}

const zoomCenter = (d) => zoomTo((anim ? anim.to : view.zoom) + d, cssW / 2, cssH / 2);

document.getElementById('zoomIn').onclick = () => zoomCenter(1);
document.getElementById('zoomOut').onclick = () => zoomCenter(-1);
document.getElementById('home').onclick = () => {
  fitBounds();
  interacted();
};

window.addEventListener('keydown', (e) => {
  if (e.target !== document.body && e.target !== canvas) return;
  if (typeof overlayKey === 'function' && overlayKey(e)) {
    e.preventDefault();
    return;
  }
  const pan = 120 / worldScale();
  switch (e.key) {
    case '+': case '=': zoomCenter(1); break;
    case '-': case '_': zoomCenter(-1); break;
    case 'ArrowLeft':  view.wx -= pan; break;
    case 'ArrowRight': view.wx += pan; break;
    case 'ArrowUp':    view.wy -= pan; break;
    case 'ArrowDown':  view.wy += pan; break;
    default: return;
  }
  e.preventDefault();
  clampView();
  interacted();
});

window.addEventListener('resize', resize);
// Ловит и то, чего не даёт window.resize: разворот телефона, появление
// адресной строки, переход из фоновой вкладки с нулевым размером.
new ResizeObserver(resize).observe(canvas);

// ── Ссылка на текущий вид ─────────────────────────────────────────────────

let hashTimer = 0;

function saveHashSoon() {
  if (!sized) return; // иначе затрём валидную ссылку недосчитанным видом
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h =
      '#' +
      view.zoom.toFixed(2) +
      '/' +
      wy2lat(view.wy).toFixed(6) +
      '/' +
      wx2lon(view.wx).toFixed(6);
    // replaceState, а не location.hash — иначе каждый сдвиг карты
    // засоряет историю браузера.
    history.replaceState(null, '', h);
  }, 400);
}

function readHash() {
  const m = /^#(-?[\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)$/.exec(location.hash);
  if (!m) return false;
  const [z, lat, lon] = [+m[1], +m[2], +m[3]];
  if (!isFinite(z) || !isFinite(lat) || !isFinite(lon)) return false;
  view.zoom = z;
  view.wx = lon2wx(lon);
  view.wy = lat2wy(lat);
  clampView();
  return true;
}

/** Зум, при котором вся покрытая область помещается в окно. NaN, если рано. */
function fitZoomFor() {
  const b = cfg.bounds;
  const w = Math.abs(lon2wx(b[2]) - lon2wx(b[0]));
  const h = Math.abs(lat2wy(b[1]) - lat2wy(b[3]));
  if (!(cssW > 0 && cssH > 0 && w > 0 && h > 0)) return NaN;
  return Math.min(Math.log2(cssW / (TILE * w)), Math.log2(cssH / (TILE * h)));
}

function fitBounds() {
  const b = cfg.bounds;
  view.wx = (lon2wx(b[0]) + lon2wx(b[2])) / 2;
  view.wy = (lat2wy(b[1]) + lat2wy(b[3])) / 2;
  const fz = fitZoomFor();
  if (isFinite(fz)) view.zoom = fz;
  clampView();
}

// ── Старт ─────────────────────────────────────────────────────────────────

async function main() {
  const res = await fetch('/api/info');
  const info = await res.json();

  const b = info.bounds;
  cfg = {
    minzoom: info.minzoom,
    maxzoom: info.maxzoom,
    bounds: b,
    wxMin: lon2wx(b[0]),
    wxMax: lon2wx(b[2]),
    wyMin: lat2wy(b[3]),
    wyMax: lat2wy(b[1]),
    // Дальше maxzoom тайлов нет, но растянуть их ещё вдвое-вчетверо полезно:
    // на спутниковом снимке так удобнее разглядывать мелкие детали.
    maxViewZoom: info.maxzoom + OVERZOOM,
    // minViewZoom подтягивается под размер окна в resize(); absMinZoom —
    // жёсткий пол, ниже которого не опускаемся никогда.
    minViewZoom: info.minzoom,
    absMinZoom: info.minzoom,
  };

  // resize() сам выставит начальный вид, как только узнает размер холста.
  resize();

  if (info.filesPending > 0) {
    const warn = document.getElementById('warn');
    const n = info.filesPending;
    // Говорим, что происходит и что делать не нужно. Список имён файлов
    // тут ничего не решает — счётчика достаточно.
    warn.textContent =
      `Копируется ещё ${n} ${plural(n, 'файл', 'файла', 'файлов')}. ` +
      'Часть области пока без снимков — они появятся сами, перезагружать не нужно.';
    warn.hidden = false;
    setTimeout(() => (warn.hidden = true), 12000);
  }

  document.getElementById('boot').classList.add('gone');
  window.addEventListener('hashchange', () => {
    if (sized && readHash()) interacted();
  });

  requestAnimationFrame(frame);

  if (debug) {
    setInterval(async () => {
      const s = await (await fetch('/api/stats')).json();
      console.log('сервер:', s);
    }, 5000);
  }
}

main().catch((err) => {
  // Текст ошибки от браузера пришёл бы по-английски — его в консоль,
  // пользователю остаётся то, что можно сделать.
  console.error(err);
  document.getElementById('boot').textContent =
    'Сервер карт не отвечает. Проверьте, запущен ли он, и обновите страницу.';
});
