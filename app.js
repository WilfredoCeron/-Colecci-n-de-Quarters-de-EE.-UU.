'use strict';

const IMG_BASE = 'https://onlinecoin.club/images/coins/United_States/';
const IMG_LOCAL = 'img/';
const LS_KEY = 'quarters_owned_v1';
const DB_NAME = 'coin-photos';
const DB_STORE = 'photos';
const RING_CIRC = 326.7;

const PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
      "<circle cx='50' cy='50' r='44' fill='none' stroke='%234a5a7a' stroke-width='5'/>" +
      "<circle cx='50' cy='50' r='34' fill='none' stroke='%23303c52' stroke-width='2'/>" +
      "<text x='50' y='62' font-size='38' text-anchor='middle' fill='%234a5a7a' font-family='Arial'>?</text></svg>"
  );

const catalog = QUARTER_CATALOG;

catalog.sort((a, b) => a.year - b.year || a.design.localeCompare(b.design, 'es'));

let owned = new Set();
let db = null;
let dbPromise = null;
let currentSeries = 'all';
let currentView = 'all';
let currentSearch = '';

/* ---------------- Helpers ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function photoKey(id, side) { return 'coin:' + id + ':' + side; }

function refThumb(coin, side) {
  if (coin.local) return IMG_LOCAL + coin.id + '-' + side + '-thumb.jpg';
  const uuid = side === 'obv' ? coin.obv : coin.rev;
  return uuid ? IMG_BASE + uuid + '_thumb.jpg' : '';
}

function refFull(coin, side) {
  if (coin.local) return IMG_LOCAL + coin.id + '-' + side + '.jpg';
  const uuid = side === 'obv' ? coin.obv : coin.rev;
  return uuid ? IMG_BASE + uuid + '.jpg' : '';
}

function revokeImg(img) {
  if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
}

/* ---------------- localStorage (marcadas) ---------------- */

function loadOwned() {
  try { owned = new Set(JSON.parse(localStorage.getItem(LS_KEY)) || []); } catch (e) { owned = new Set(); }
}

function saveOwned() {
  localStorage.setItem(LS_KEY, JSON.stringify([...owned]));
}

/* ---------------- IndexedDB (fotos subidas) ---------------- */

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function dbGet(key) {
  return new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, 'readonly');
    const r = t.objectStore(DB_STORE).get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}

function dbPut(key, blob) {
  return new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, 'readwrite');
    t.objectStore(DB_STORE).put(blob, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

function dbDel(key) {
  return new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, 'readwrite');
    t.objectStore(DB_STORE).delete(key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/* ---------------- Imágenes ---------------- */

function onImgError(e) {
  const img = e.target;
  if (img.dataset.uploaded) return;
  img.classList.remove('ref');
  img.classList.add('placeholder');
  img.src = PLACEHOLDER;
  img.alt = 'Imagen no disponible';
}

async function setImage(img, coin, side, mode) {
  revokeImg(img);
  img.dataset.uploaded = '';
  img.classList.remove('uploaded');

  if (!db && dbPromise) {
    await Promise.race([dbPromise, new Promise((r) => setTimeout(r, 1200))]).catch(() => {});
  }
  try {
    const blob = db ? await dbGet(photoKey(coin.id, side)) : null;
    if (blob) {
      img.src = URL.createObjectURL(blob);
      img.classList.add('uploaded');
      img.classList.remove('placeholder', 'ref');
      img.dataset.uploaded = '1';
      img.alt = coin.design + ' ' + (side === 'obv' ? 'anverso' : 'reverso') + ' (tu foto)';
      return;
    }
  } catch (e) { /* continuar con referencia */ }

  const url = mode === 'thumb' ? refThumb(coin, side) : refFull(coin, side);
  img.classList.remove('placeholder');
  if (url) {
    img.classList.add('ref');
    img.src = url;
    img.alt = 'Referencia ' + (side === 'obv' ? 'anverso' : 'reverso');
  } else {
    img.classList.add('placeholder');
    img.classList.remove('ref');
    img.src = PLACEHOLDER;
    img.alt = 'Sin foto — súbela';
  }
}

async function resizeImage(file, maxDim) {
  const max = maxDim || 800;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
}

/* ---------------- Estado de colección ---------------- */

function toggleOwned(coin) {
  if (owned.has(coin.id)) owned.delete(coin.id);
  else owned.add(coin.id);
  saveOwned();
  render();
}

function matchesFilter(coin) {
  if (currentSeries !== 'all' && coin.series !== currentSeries) return false;
  const isOwned = owned.has(coin.id);
  if (currentView === 'owned' && !isOwned) return false;
  if (currentView === 'missing' && isOwned) return false;
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    const hay = (coin.year + ' ' + coin.design + ' ' + coin.series).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/* ---------------- Render ---------------- */

function buildSide(coin, side, label) {
  const f = el('figure');
  const img = el('img', 'coin-side-img placeholder');
  img.loading = 'lazy';
  img.dataset.side = side;
  img.alt = coin.design + ' ' + label.toLowerCase();
  img.addEventListener('error', onImgError);
  f.append(img);
  f.append(el('figcaption', '', label));
  return f;
}

function buildCard(coin) {
  const ownedFlag = owned.has(coin.id);
  const card = el('div', 'coin-card' + (ownedFlag ? ' owned' : ''));
  card.dataset.id = coin.id;
  card.dataset.year = String(coin.year);

  const top = el('div', 'card-top');
  top.append(el('span', 'year-badge', String(coin.year)));
  top.append(el('span', 'owned-badge', 'TENGO'));
  card.append(top);

  card.append(el('h3', 'card-title', coin.design));
  card.append(el('div', 'card-series', coin.series));

  const sides = el('div', 'coin-sides');
  const revF = buildSide(coin, 'rev', 'Reverso');
  const obvF = buildSide(coin, 'obv', 'Anverso');
  sides.append(revF, obvF);
  card.append(sides);

  const toggle = el('button', 'card-toggle', ownedFlag ? '✓ Tienes esta moneda' : 'Marcar como tengo');
  toggle.type = 'button';
  toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleOwned(coin); });
  card.append(toggle);

  const foot = el('div', 'card-foot');
  const upBtn = el('button', 'mini-btn', 'Subir foto');
  upBtn.type = 'button';
  upBtn.addEventListener('click', (e) => { e.stopPropagation(); openModal(coin); });
  const detBtn = el('button', 'mini-btn', 'Detalle');
  detBtn.type = 'button';
  detBtn.addEventListener('click', (e) => { e.stopPropagation(); openModal(coin); });
  foot.append(upBtn, detBtn);
  card.append(foot);

  card.addEventListener('click', () => openModal(coin));

  setImage(revF.querySelector('img'), coin, 'rev', 'thumb');
  setImage(obvF.querySelector('img'), coin, 'obv', 'thumb');

  return card;
}

function render() {
  const grid = document.getElementById('coinGrid');
  grid.innerHTML = '';
  let shown = 0;
  catalog.forEach((coin) => {
    if (!matchesFilter(coin)) return;
    shown++;
    grid.append(buildCard(coin));
  });
  document.getElementById('emptyState').hidden = shown > 0;
  updateProgress();
}

/* ---------------- Progreso ---------------- */

function updateProgress() {
  const total = catalog.length;
  const count = owned.size;
  const pct = total ? Math.round((count / total) * 100) : 0;

  document.getElementById('ringFg').style.strokeDashoffset = String(RING_CIRC * (1 - count / total));
  document.getElementById('ownedPct').textContent = pct + '%';
  document.getElementById('ownedCount').textContent = String(count);
  document.getElementById('totalCount').textContent = String(total);
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('ownedPill').innerHTML = 'Tienes <b>' + count + '</b>';
  document.getElementById('missingPill').innerHTML = 'Faltan <b>' + (total - count) + '</b>';

  updateSeriesChips();
}

function updateSeriesChips() {
  const wrap = document.getElementById('seriesProgress');
  wrap.innerHTML = '';

  const seriesOrder = [...new Set(catalog.map((c) => c.series))];
  seriesOrder.forEach((s) => {
    const coins = catalog.filter((c) => c.series === s);
    const have = coins.filter((c) => owned.has(c.id)).length;
    const pct = Math.round((have / coins.length) * 100);
    const chip = el('button', 'series-chip' + (currentSeries === s ? ' active' : ''));
    chip.title = s;
    chip.innerHTML =
      escHtml(s) + ' · ' + have + '/' + coins.length + ' <b>' + pct + '%</b>';
    chip.addEventListener('click', () => {
      currentSeries = currentSeries === s ? 'all' : s;
      document.getElementById('seriesFilter').value = currentSeries;
      render();
    });
    wrap.append(chip);
  });
}

function populateSeriesFilter() {
  const sel = document.getElementById('seriesFilter');
  sel.innerHTML = '';
  const all = el('option', '', 'Todas las series');
  all.value = 'all';
  sel.append(all);
  [...new Set(catalog.map((c) => c.series))].forEach((s) => {
    const o = el('option', '', s);
    o.value = s;
    sel.append(o);
  });
}

function populateYearFilter() {
  const sel = document.getElementById('yearFilter');
  sel.innerHTML = '';
  const ph = el('option', '', 'Ir a un año…');
  ph.value = '';
  sel.append(ph);
  [...new Set(catalog.map((c) => c.year))].sort((a, b) => a - b).forEach((y) => {
    const o = el('option', '', String(y));
    o.value = String(y);
    sel.append(o);
  });
}

function goToYear(year) {
  currentSearch = '';
  currentSeries = 'all';
  currentView = 'all';
  document.getElementById('searchInput').value = '';
  document.getElementById('seriesFilter').value = 'all';
  document.querySelectorAll('.view-btn').forEach((x) => x.classList.remove('active'));
  document.querySelector('.view-btn[data-view="all"]').classList.add('active');
  render();
  const targets = document.querySelectorAll('.coin-card[data-year="' + year + '"]');
  if (targets.length) {
    targets[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    targets.forEach((t) => {
      t.classList.add('flash');
      setTimeout(() => t.classList.remove('flash'), 3000);
    });
  }
}

/* ---------------- Modal ---------------- */

function syncCardImage(coin, side) {
  const card = document.querySelector('.coin-card[data-id="' + coin.id + '"]');
  if (!card) return;
  const img = card.querySelector('img[data-side="' + side + '"]');
  if (img) setImage(img, coin, side, 'thumb');
}

function buildModalSide(coin, side, label) {
  const div = el('div', 'modal-side');

  const f = el('figure', 'zoom-figure');
  const img = el('img', 'modal-side-img placeholder');
  img.alt = coin.design + ' ' + label.toLowerCase();
  img.addEventListener('error', onImgError);
  const lens = el('div', 'zoom-lens');
  f.append(img, lens);
  f.append(el('figcaption', '', label + (side === 'obv' ? ' (cara / derecho)' : ' (cruz / revés)')));
  f.title = 'Pasa el mouse sobre la imagen para acercar';
  initZoom(f, lens, img);
  div.append(f);

  setImage(img, coin, side, 'full');

  const actions = el('div', 'modal-side-actions');
  const up = el('button', 'btn primary', 'Subir foto');
  const file = el('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.hidden = true;
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    up.disabled = true;
    up.textContent = 'Procesando…';
    try {
      const blob = await resizeImage(file.files[0]);
      await dbPut(photoKey(coin.id, side), blob);
      await setImage(img, coin, side, 'full');
      syncCardImage(coin, side);
    } catch (err) {
      alert('No se pudo guardar la foto: ' + err.message);
    }
    up.disabled = false;
    up.textContent = 'Subir foto';
  });
  up.addEventListener('click', () => file.click());

  const del = el('button', 'btn danger', 'Quitar');
  del.addEventListener('click', async () => {
    await dbDel(photoKey(coin.id, side));
    await setImage(img, coin, side, 'full');
    syncCardImage(coin, side);
  });

  actions.append(up, del);
  div.append(actions, file);
  return div;
}

function initZoom(figure, lens, img) {
  figure.addEventListener('mousemove', (e) => {
    if (!img.src || img.classList.contains('placeholder') || !img.complete) return;
    const rect = figure.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * 100;
    const y = (e.clientY - rect.top) / rect.height * 100;
    lens.style.display = 'block';
    lens.style.left = (e.clientX - rect.left) + 'px';
    lens.style.top = (e.clientY - rect.top) + 'px';
    lens.style.backgroundImage = "url('" + img.src + "')";
    lens.style.backgroundPosition = x + '% ' + y + '%';
  });
  figure.addEventListener('mouseleave', () => {
    lens.style.display = 'none';
  });
}

function openModal(coin) {
  const body = document.getElementById('modalBody');
  body.innerHTML = '';

  body.append(el('h2', 'modal-title', coin.year + ' · ' + coin.design));
  body.append(el('div', 'modal-sub', coin.series));

  const toggle = el('button', 'modal-toggle' + (owned.has(coin.id) ? ' owned' : ''));
  toggle.type = 'button';
  toggle.textContent = owned.has(coin.id) ? '✓ La tienes — toca para quitar' : 'Toca para marcar que la tienes';
  toggle.addEventListener('click', () => {
    toggleOwned(coin);
    const isOwned = owned.has(coin.id);
    toggle.className = 'modal-toggle' + (isOwned ? ' owned' : '');
    toggle.textContent = isOwned ? '✓ La tienes — toca para quitar' : 'Toca para marcar que la tienes';
  });
  body.append(toggle);

  const sides = el('div', 'modal-sides');
  sides.append(buildModalSide(coin, 'rev', 'Reverso'));
  sides.append(buildModalSide(coin, 'obv', 'Anverso'));
  body.append(sides);

  const info = el('div', 'modal-info');
  info.innerHTML =
    '<b>Serie:</b> ' + escHtml(coin.series) +
    '<br><b>Material:</b> ' + escHtml(coin.material || '—') +
    '<br><b>Cecas:</b> ' + escHtml(coin.mint || '—') +
    '<br><b>Tirada:</b> ' + escHtml(coin.mintage || '—') +
    '<br><span class="hint">Las fotos que subas se guardan solo en este navegador (IndexedDB).</span>';
  body.append(info);

  document.getElementById('modal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal').hidden = true;
  document.body.style.overflow = '';
}

/* ---------------- Exportar / Importar ---------------- */

function exportData() {
  const payload = {
    app: 'quarters-collection',
    version: 1,
    exportedAt: new Date().toISOString(),
    owned: [...owned],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'coleccion-quarters-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!payload || !Array.isArray(payload.owned)) throw new Error('formato');
      const valid = new Set(catalog.map((c) => c.id));
      owned = new Set(payload.owned.filter((id) => valid.has(id)));
      saveOwned();
      render();
    } catch (e) {
      alert('Archivo no válido. Exporta tu colección desde "Exportar" para obtener el formato correcto.');
    }
  };
  reader.readAsText(file);
}

/* ---------------- Eventos ---------------- */

function bindEvents() {
  document.getElementById('searchInput').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    render();
    if (currentSearch) {
      document.querySelectorAll('#coinGrid .coin-card').forEach((c) => {
        c.classList.add('flash');
        setTimeout(() => c.classList.remove('flash'), 3000);
      });
    }
  });

  document.getElementById('seriesFilter').addEventListener('change', (e) => {
    currentSeries = e.target.value;
    render();
  });

  document.getElementById('yearFilter').addEventListener('change', (e) => {
    const y = parseInt(e.target.value, 10);
    if (y) goToYear(y);
    e.target.value = '';
  });

  document.querySelectorAll('.view-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      currentView = b.dataset.view;
      render();
    });
  });

  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

function syncToolbarSticky() {
  const header = document.querySelector('.app-header');
  if (header) {
    document.documentElement.style.setProperty('--header-h', header.getBoundingClientRect().height + 'px');
  }
}

/* ---------------- Init ---------------- */

async function init() {
  loadOwned();
  populateSeriesFilter();
  populateYearFilter();
  bindEvents();
  dbPromise = openDB();
  render();
  syncToolbarSticky();
  window.addEventListener('resize', syncToolbarSticky);
  dbPromise.catch((e) => console.warn('IndexedDB no disponible, las fotos no se guardarán', e));
}

document.addEventListener('DOMContentLoaded', init);
