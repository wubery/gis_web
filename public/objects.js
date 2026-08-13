/**
 * Объекты на карте: метки, линии и полигоны.
 *
 * Рисуются поверх тайлов на том же холсте — отдельный слой DOM не нужен,
 * а значит нет и рассинхрона между картинкой и разметкой при зуме.
 *
 * Координаты хранятся в градусах [долгота, широта] — в том же порядке,
 * что и в GeoJSON, чтобы экспорт был перекладыванием без пересчёта.
 *
 * Модуль опирается на app.js: view, worldToCanvas, lon2wx/lat2wy,
 * screenToWorld, schedule. Подключать строго после него.
 */
'use strict';

const STORE_KEY = 'mbtiles-viewer.objects';

/** Радиус попадания по объекту, в CSS-пикселях. */
const HIT_PX = 11;

/** На сколько кружок метки поднят над точкой привязки, в CSS-пикселях.
 *  Одно значение на отрисовку и на попадание курсора — иначе разъедутся. */
const PIN_LIFT = 14;

/*
 * Системные цвета Apple, но без зелёного: над полями и лесом он сливается
 * со снимком и перестаёт читаться. Синий, оранжевый, розовый, фиолетовый
 * и бирюзовый в природном ландшафте почти не встречаются.
 */
const PALETTE = ['#0071e3', '#ff9500', '#ff375f', '#af52de', '#30b0c7'];

/** Подписи набираем интерфейсным шрифтом, а не моноширинным: это текст. */
const LABEL_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

let objects = [];
let tool = 'select';
let selectedId = null;
let hoverId = null;
let draft = null; // {type, coords: [[lon,lat], ...]}
let draftCursor = null; // [lon, lat] — куда указывает курсор сейчас
let nextId = 1;

// ── Геометрия ─────────────────────────────────────────────────────────────

const toRad = (d) => (d * Math.PI) / 180;

/** Расстояние по большому кругу, метры. */
function distance(a, b) {
  const R = 6371008.8;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += distance(coords[i - 1], coords[i]);
  return sum;
}

/**
 * Площадь сферического многоугольника, м².
 * Плоская формула на Меркаторе завышала бы результат тем сильнее, чем
 * дальше от экватора — на широте 50° это уже больше полутора раз.
 */
function polygonArea(coords) {
  if (coords.length < 3) return 0;
  const R = 6378137;
  let sum = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % coords.length];
    sum += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * R * R) / 2);
}

const fmtLen = (m) =>
  m < 1000 ? m.toFixed(0) + ' м' : (m / 1000).toFixed(m < 100000 ? 2 : 1) + ' км';

const fmtArea = (m2) =>
  m2 < 1e6 ? (m2 / 1e4).toFixed(2) + ' га' : (m2 / 1e6).toFixed(2) + ' км²';

// ── Хранилище ─────────────────────────────────────────────────────────────

// Имена намеренно не save/load: app.js держит в глобальной области свой
// load() — загрузчик тайлов, и объявление с тем же именем перезаписало бы его.
function saveObjects() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(objects));
  } catch {
    // Приватный режим или переполнение — работаем без сохранения.
  }
}

function loadObjects() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    /* хранилище недоступно */
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) objects = parsed;
    } catch {
      objects = [];
    }
  }

  if (objects.length === 0) objects = testObjects();
  nextId = objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;
}

/** Пять демонстрационных объектов — по одному на каждый тип и разброс по региону. */
function testObjects() {
  return [
    {
      id: 1,
      type: 'marker',
      name: 'Харьков',
      color: PALETTE[0],
      coords: [[36.2304, 49.9935]],
    },
    {
      id: 2,
      type: 'marker',
      name: 'Тростянец',
      color: PALETTE[1],
      coords: [[34.97, 50.482]],
    },
    {
      id: 3,
      type: 'marker',
      name: 'Ахтырка',
      color: PALETTE[2],
      coords: [[34.899, 50.31]],
    },
    {
      id: 4,
      type: 'line',
      name: 'Маршрут Харьков — Богодухов',
      color: PALETTE[3],
      coords: [
        [36.2304, 49.9935],
        [35.92, 50.06],
        [35.5222, 50.1636],
      ],
    },
    {
      id: 5,
      type: 'polygon',
      name: 'Тестовый полигон',
      color: PALETTE[4],
      coords: [
        [36.05, 50.08],
        [36.42, 50.08],
        [36.42, 49.9],
        [36.05, 49.9],
      ],
    },
  ];
}

// ── Проекция ──────────────────────────────────────────────────────────────

/** [долгота, широта] -> пиксели холста. */
const ll2px = (ll) => worldToCanvas(lon2wx(ll[0]), lat2wy(ll[1]));

/** Пиксели CSS -> [долгота, широта]. */
function px2ll(px, py) {
  const w = screenToWorld(px, py);
  return [wx2lon(w.wx), wy2lat(w.wy)];
}

// ── Отрисовка ─────────────────────────────────────────────────────────────

function drawOverlay() {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const o of objects) drawObject(o, o.id === selectedId, o.id === hoverId);
  if (draft) drawDraft();

  ctx.restore();
  updateObjInfo();
}

function drawObject(o, selected, hovered) {
  const pts = o.coords.map(ll2px);
  const w = (n) => n * dpr;

  if (o.type === 'polygon' && pts.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = hexA(o.color, selected ? 0.3 : 0.16);
    ctx.fill();
    ctx.strokeStyle = o.color;
    ctx.lineWidth = w(selected ? 3.5 : 2.5);
    ctx.stroke();
  }

  if (o.type === 'line' && pts.length >= 2) {
    // Тёмная подложка под линией: на пёстром спутниковом снимке без неё
    // тонкая цветная линия местами теряется.
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = w(selected ? 7 : 6);
    ctx.stroke();
    ctx.strokeStyle = o.color;
    ctx.lineWidth = w(selected ? 4 : 3);
    ctx.stroke();
  }

  if (o.type !== 'marker' && (selected || hovered)) {
    for (const p of pts) dot(p, w(selected ? 4.5 : 3.5), o.color);
  }

  if (o.type === 'marker') {
    drawPin(pts[0], o.color, selected, hovered);
  }

  const anchor = labelAnchor(o, pts);
  if (anchor) {
    const dy = o.type === 'marker' ? -w(PIN_LIFT + 9) : -w(8);
    label(o.name, anchor.x, anchor.y + dy, selected);
  }
}

function drawPin(p, color, selected, hovered) {
  const r = (selected ? 7.5 : hovered ? 7 : 6.5) * dpr;
  const head = { x: p.x, y: p.y - PIN_LIFT * dpr };

  // Ножка: показывает, какая именно точка на земле отмечена.
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(head.x, head.y);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3.5 * dpr;
  shadowOn();
  ctx.stroke();
  shadowOff();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75 * dpr;
  ctx.stroke();

  dot(head, r, color, true);

  ctx.beginPath();
  ctx.arc(p.x, p.y, 1.75 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

/** Мягкая тень — то, чем интерфейс Apple отделяет объект от фона. */
function shadowOn() {
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6 * dpr;
  ctx.shadowOffsetY = 1 * dpr;
}

function shadowOff() {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function dot(p, r, color, ring) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  // Белое кольцо вместо чёрного: над тёмным снимком оно отделяет метку
  // от фона, а не растворяется в нём.
  ctx.fillStyle = '#fff';
  shadowOn();
  ctx.fill();
  shadowOff();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r - (ring ? 2.25 : 1.5) * dpr, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function label(text, x, y, selected) {
  if (!text) return;
  ctx.font = `${selected ? 600 : 500} ${(selected ? 13 : 12.5) * dpr}px ${LABEL_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  // Обводка вместо плашки: не закрывает снимок и читается на любом фоне.
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 3.5 * dpr;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function labelAnchor(o, pts) {
  if (pts.length === 0) return null;
  if (o.type === 'marker') return pts[0];
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function drawDraft() {
  const live = draftCursor ? [...draft.coords, draftCursor] : draft.coords;
  const pts = live.map(ll2px);
  if (pts.length === 0) return;

  const color = PALETTE[(nextId - 1) % PALETTE.length];

  if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (draft.type === 'polygon' && pts.length >= 3) ctx.closePath();

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 6 * dpr;
    ctx.stroke();
    ctx.setLineDash([8 * dpr, 6 * dpr]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < draft.coords.length; i++) dot(pts[i], 4.5 * dpr, color);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ── Попадание курсора ─────────────────────────────────────────────────────

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ищем объект под курсором. Порядок важен: сверху лежат метки. */
function hitTest(cssX, cssY) {
  const p = { x: cssX * dpr, y: cssY * dpr };
  const r = HIT_PX * dpr;

  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type !== 'marker') continue;
    const q = ll2px(o.coords[0]);
    // Попасть можно и по кружку, и по точке привязки на земле.
    if (Math.hypot(p.x - q.x, p.y - q.y + PIN_LIFT * dpr) <= r) return o;
    if (Math.hypot(p.x - q.x, p.y - q.y) <= r) return o;
  }

  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type === 'marker') continue;
    const pts = o.coords.map(ll2px);
    for (let j = 1; j < pts.length; j++) {
      if (distToSegment(p, pts[j - 1], pts[j]) <= r) return o;
    }
    if (o.type === 'polygon' && pts.length >= 3) {
      if (distToSegment(p, pts[pts.length - 1], pts[0]) <= r) return o;
      if (pointInPolygon(p, pts)) return o;
    }
  }
  return null;
}

// ── События от app.js ─────────────────────────────────────────────────────

function overlayHover(cssX, cssY) {
  if (draft) {
    draftCursor = px2ll(cssX, cssY);
    schedule();
    return;
  }
  if (tool !== 'select') return;
  const hit = hitTest(cssX, cssY);
  const id = hit ? hit.id : null;
  if (id !== hoverId) {
    hoverId = id;
    canvas.style.cursor = id ? 'pointer' : '';
    schedule();
  }
}

function overlayClick(cssX, cssY) {
  const ll = px2ll(cssX, cssY);

  if (tool === 'marker') {
    const id = nextId++;
    const o = {
      id,
      type: 'marker',
      name: 'Метка ' + id,
      color: PALETTE[(id - 1) % PALETTE.length],
      coords: [ll],
    };
    objects.push(o);
    selectedId = o.id;
    saveObjects();
    setTool('select');
    schedule();
    return;
  }

  if (tool === 'line' || tool === 'polygon') {
    if (!draft) draft = { type: tool, coords: [] };
    draft.coords.push(ll);
    draftCursor = ll;
    schedule();
    return;
  }

  const hit = hitTest(cssX, cssY);
  selectedId = hit ? hit.id : null;
  schedule();
}

/** Двойной клик завершает фигуру. Возвращает true, если событие поглощено. */
function overlayDblClick() {
  if (!draft) return false;
  finishDraft();
  return true;
}

function overlayKey(e) {
  if (e.key === 'Escape') {
    if (draft) {
      draft = null;
      draftCursor = null;
    }
    setTool('select');
    selectedId = null;
    schedule();
    return true;
  }
  if (e.key === 'Enter' && draft) {
    finishDraft();
    return true;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null) {
    removeSelected();
    return true;
  }
  if (e.key === 'F2' && selectedId !== null) {
    renameSelected();
    return true;
  }
  const byKey = { m: 'marker', l: 'line', p: 'polygon', s: 'select' };
  const t = byKey[e.key.toLowerCase()];
  if (t) {
    setTool(t);
    return true;
  }
  return false;
}

// ── Действия ──────────────────────────────────────────────────────────────

function finishDraft() {
  const min = draft.type === 'polygon' ? 3 : 2;
  if (draft.coords.length >= min) {
    const id = nextId++;
    const o = {
      id,
      type: draft.type,
      name: (draft.type === 'polygon' ? 'Полигон ' : 'Линия ') + id,
      color: PALETTE[(id - 1) % PALETTE.length],
      coords: draft.coords,
    };
    objects.push(o);
    selectedId = o.id;
    saveObjects();
  }
  draft = null;
  draftCursor = null;
  setTool('select');
  schedule();
}

function removeSelected() {
  objects = objects.filter((o) => o.id !== selectedId);
  selectedId = null;
  hoverId = null;
  saveObjects();
  schedule();
}

function renameSelected() {
  const o = objects.find((x) => x.id === selectedId);
  if (!o) return;
  const name = prompt('Название объекта:', o.name);
  if (name !== null) {
    o.name = name.trim();
    saveObjects();
    schedule();
  }
}

function setTool(t) {
  tool = t;
  if (t !== 'line' && t !== 'polygon') {
    draft = null;
    draftCursor = null;
  }
  hoverId = null;
  canvas.style.cursor = t === 'select' ? '' : 'crosshair';
  for (const b of document.querySelectorAll('#tools button[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === t);
  }
  schedule();
}

// ── GeoJSON ───────────────────────────────────────────────────────────────

function toGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: objects.map((o) => ({
      type: 'Feature',
      properties: { name: o.name, color: o.color },
      geometry:
        o.type === 'marker'
          ? { type: 'Point', coordinates: o.coords[0] }
          : o.type === 'line'
            ? { type: 'LineString', coordinates: o.coords }
            : // В GeoJSON кольцо полигона обязано быть замкнутым.
              { type: 'Polygon', coordinates: [[...o.coords, o.coords[0]]] },
    })),
  };
}

function fromGeoJSON(gj) {
  const out = [];
  let id = 1;
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const name = f.properties?.name ?? '';
    const color = f.properties?.color ?? PALETTE[(id - 1) % PALETTE.length];
    if (g.type === 'Point') {
      out.push({ id: id++, type: 'marker', name, color, coords: [g.coordinates] });
    } else if (g.type === 'LineString') {
      out.push({ id: id++, type: 'line', name, color, coords: g.coordinates });
    } else if (g.type === 'Polygon') {
      const ring = g.coordinates[0].slice();
      // Замыкающую точку убираем — внутри мы держим кольцо незамкнутым.
      if (
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
      ) {
        ring.pop();
      }
      out.push({ id: id++, type: 'polygon', name, color, coords: ring });
    }
  }
  return out;
}

function exportGeoJSON() {
  const blob = new Blob([JSON.stringify(toGeoJSON(), null, 2)], {
    type: 'application/geo+json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'объекты.geojson';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importGeoJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = fromGeoJSON(JSON.parse(reader.result));
      if (parsed.length === 0) {
        alert('В файле нет ни точек, ни линий, ни полигонов.');
        return;
      }
      objects = parsed;
      nextId = objects.length + 1;
      selectedId = null;
      saveObjects();
      schedule();
    } catch (err) {
      console.error(err);
      alert('Файл не похож на GeoJSON. Нужен тот, что сохраняет кнопка выгрузки.');
    }
  };
  reader.readAsText(file);
}

// ── Панель сведений ───────────────────────────────────────────────────────

const objInfoEl = document.getElementById('objinfo');
const objTitleEl = document.getElementById('objTitle');
const objMetaEl = document.getElementById('objMeta');
const btnDone = document.getElementById('objDone');
const btnCancel = document.getElementById('objCancel');
const btnRename = document.getElementById('objRename');
const btnDelete = document.getElementById('objDelete');

let infoMode = '';
let doneReady = null;

// plural() объявлена в app.js — своя копия здесь перезаписала бы её.
const points = (n) => n + ' ' + plural(n, 'точка', 'точки', 'точек');

/**
 * Карточка собрана в разметке один раз, а здесь меняется только текст.
 * Пересобирать её через innerHTML нельзя: пока ведёшь курсор, замеры
 * меняются каждый кадр, и кнопки пересоздавались бы под нажатием.
 */
function updateObjInfo() {
  let mode = '';
  let title = '';
  let meta = '';

  if (draft) {
    mode = 'draft';
    const live = draftCursor ? [...draft.coords, draftCursor] : draft.coords;
    title = draft.type === 'polygon' ? 'Полигон' : 'Линия';
    const parts = [points(draft.coords.length)];
    if (live.length >= 2) parts.push(fmtLen(lineLength(live)));
    if (draft.type === 'polygon' && live.length >= 3) {
      parts.push(fmtArea(polygonArea(live)));
    }
    meta = parts.join(' · ');
  } else {
    const o = objects.find((x) => x.id === selectedId);
    if (o) {
      mode = 'selected';
      title = o.name;
      if (o.type === 'marker') {
        meta = o.coords[0][1].toFixed(5) + ', ' + o.coords[0][0].toFixed(5);
      } else if (o.type === 'line') {
        meta = fmtLen(lineLength(o.coords)) + ' · ' + points(o.coords.length);
      } else {
        meta =
          fmtArea(polygonArea(o.coords)) +
          ' · периметр ' +
          fmtLen(lineLength([...o.coords, o.coords[0]]));
      }
    }
  }

  if (mode === '') {
    if (infoMode !== '') {
      infoMode = '';
      objInfoEl.hidden = true;
    }
    return;
  }

  if (objTitleEl.textContent !== title) objTitleEl.textContent = title;
  if (objMetaEl.textContent !== meta) objMetaEl.textContent = meta;

  if (mode !== infoMode) {
    infoMode = mode;
    const drafting = mode === 'draft';
    btnDone.hidden = !drafting;
    btnCancel.hidden = !drafting;
    btnRename.hidden = drafting;
    btnDelete.hidden = drafting;
    objInfoEl.hidden = false;
  }

  // Пока точек не набралось, «Готово» ничего не создаст — гасим кнопку,
  // чтобы это было видно заранее, а не выяснялось нажатием.
  if (mode === 'draft') {
    const ready = draft.coords.length >= (draft.type === 'polygon' ? 3 : 2);
    if (ready !== doneReady) {
      doneReady = ready;
      btnDone.disabled = !ready;
    }
  } else {
    doneReady = null;
  }
}

// ── Подключение кнопок ────────────────────────────────────────────────────

loadObjects();

for (const b of document.querySelectorAll('#tools button[data-tool]')) {
  b.onclick = () => setTool(b.dataset.tool === tool ? 'select' : b.dataset.tool);
}

btnDelete.onclick = () => {
  if (selectedId !== null) removeSelected();
};

btnRename.onclick = renameSelected;

btnDone.onclick = () => {
  if (draft) finishDraft();
};

btnCancel.onclick = () => {
  draft = null;
  draftCursor = null;
  setTool('select');
  schedule();
};

document.getElementById('objExport').onclick = exportGeoJSON;

document.getElementById('objImport').onclick = () =>
  document.getElementById('objFile').click();

document.getElementById('objFile').onchange = (e) => {
  if (e.target.files[0]) importGeoJSON(e.target.files[0]);
  e.target.value = '';
};

setTool('select');
