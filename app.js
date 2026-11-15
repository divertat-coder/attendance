'use strict';
const APP_VERSION = '5 (Fighter_ID)';
/*
  Учёт посещений по лицу.
  Распознавание идёт прямо в телефоне. Лица хранятся только в телефоне (128 чисел на снимок, не фото).
  В Google Таблицу уходят только: имя, дата, время.
*/

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/* ---------- хранилище ---------- */
const KEYS = {fighters: 'an_fighters_v1', log: 'an_log_v1', cfg: 'an_cfg_v1'};
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { toast('Не удалось сохранить: память браузера недоступна или заполнена'); return false; }
}

const DEFAULT_CFG = {url: '', token: '', threshold: 0.5, minFace: 0.14, facing: 'user', pin: ''};
let cfg = Object.assign({}, DEFAULT_CFG, lsGet(KEYS.cfg, {}));
let fighters = lsGet(KEYS.fighters, []);   // {id (Fighter_ID), name, group, nick, desc:[[128 чисел],...], orphan}
let log = lsGet(KEYS.log, []);             // {uid, fid (Fighter_ID), name, date, time, sent}

const saveFighters = () => lsSet(KEYS.fighters, fighters);
const saveLog = () => lsSet(KEYS.log, log);

/* ---------- мелкие UI-помощники ---------- */
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

let bannerTimer = null;
function setBanner(text, kind, holdMs = 0) {
  const b = $('#banner'); b.textContent = text; b.className = 'banner ' + kind;
  clearTimeout(bannerTimer);
  if (holdMs) bannerTimer = setTimeout(idleBanner, holdMs);
}
function idleBanner() {
  if (!modelsReady) return;
  setBanner('Подойдите к камере и посмотрите в кадр', 'idle');
}

/* ---------- индекс лиц для сопоставления ---------- */
let index = new Map(); // Fighter_ID -> [Float32Array,...]
const fighterById = id => fighters.find(x => x.id === id);
// Что показывать на экране: ник, если он есть, иначе имя. В таблицу всегда уходит полное имя.
function labelOf(id, fallbackName) {
  const f = fighterById(id);
  return f ? (f.nick || f.name) : (fallbackName || String(id));
}
function rebuildIndex() {
  index = new Map();
  for (const f of fighters) {
    if (f.orphan || !f.desc || !f.desc.length) continue;
    index.set(f.id, f.desc.map(a => Float32Array.from(a)));
  }
}
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
// Возвращает ближайшего бойца, расстояние и отрыв от второго по близости бойца.
function matchDescriptor(d, excludeId) {
  let best = {id: null, dist: 9}, second = 9;
  for (const [id, arr] of index) {
    if (id === excludeId) continue;
    let m = 9;
    for (const s of arr) { const x = dist(d, s); if (x < m) m = x; }
    if (m < best.dist) { second = best.dist; best = {id, dist: m}; }
    else if (m < second) second = m;
  }
  return {id: best.id, dist: best.dist, margin: second - best.dist};
}
const MARGIN = 0.04;

/* ---------- камера ---------- */
let stream = null;
const kVideo = $('#kVideo'), rVideo = $('#rVideo'), kCanvas = $('#kCanvas'), rCanvas = $('#rCanvas');

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Камера недоступна (нужен https)');
  stream = await navigator.mediaDevices.getUserMedia({
    video: {facingMode: cfg.facing, width: {ideal: 800}, height: {ideal: 600}}, audio: false
  });
  for (const v of [kVideo, rVideo]) { v.srcObject = stream; v.play().catch(() => {}); }
  $$('.camwrap').forEach(w => w.classList.toggle('mirror', cfg.facing === 'user'));
}
function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}
function cameraAlive() {
  return stream && stream.getVideoTracks().some(t => t.readyState === 'live');
}
for (const [v, w] of [[kVideo, '#kioskCam'], [rVideo, '#regCam']]) {
  v.addEventListener('loadedmetadata', () => { if (v.videoWidth) $(w).style.aspectRatio = v.videoWidth + ' / ' + v.videoHeight; });
}

/* ---------- модели ---------- */
let modelsReady = false;
async function loadModels() {
  await faceapi.tf.ready();
  await faceapi.nets.tinyFaceDetector.loadFromUri('models');
  await faceapi.nets.faceLandmark68TinyNet.loadFromUri('models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('models');
  modelsReady = true;
}
const detOpts = () => new faceapi.TinyFaceDetectorOptions({inputSize: 416, scoreThreshold: 0.5});
const detect = video => faceapi.detectAllFaces(video, detOpts()).withFaceLandmarks(true).withFaceDescriptors();

function drawBoxes(canvas, video, items) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.lineWidth = Math.max(3, w / 200);
  for (const it of items) {
    c.strokeStyle = it.color;
    const b = it.box; c.strokeRect(b.x, b.y, b.width, b.height);
  }
}

/* ---------- режимы ---------- */
let mode = 'kiosk'; // kiosk | menu | register
function showView(name) {
  for (const v of ['kiosk', 'menu', 'register']) $('#view-' + v).classList.toggle('hidden', v !== name);
  mode = name;
  if (name === 'kiosk') kioskLoop();
}

/* ---------- киоск ---------- */
const hits = new Map();      // Fighter_ID -> подряд идущих совпадений
let unknownHits = 0;
let loopRunning = false;
const doneToday = new Set(); // ключи 'дата|Fighter_ID': один раз за дату

function rebuildDone() {
  doneToday.clear();
  for (const e of log) if (e.fid) doneToday.add(e.date + '|' + e.fid);
}

async function kioskLoop() {
  if (loopRunning) return;
  loopRunning = true;
  while (mode === 'kiosk') {
    const t0 = performance.now();
    try { await kioskTick(); } catch (e) { console.error(e); await sleep(800); }
    await sleep(Math.max(60, 300 - (performance.now() - t0)));
  }
  drawBoxes(kCanvas, kVideo, []);
  loopRunning = false;
}

async function kioskTick() {
  if (!modelsReady || !kVideo.videoWidth || kVideo.paused) return;
  const dets = await detect(kVideo);
  const vw = kVideo.videoWidth;
  const items = [];
  const seen = new Set();
  let sawUnknownBig = false;

  for (const d of dets) {
    const box = d.detection.box;
    if (box.width / vw < cfg.minFace) { items.push({box, color: '#8b98a5'}); continue; }
    const m = matchDescriptor(d.descriptor);
    if (m.id && m.dist <= cfg.threshold && m.margin >= MARGIN) {
      seen.add(m.id);
      const n = (hits.get(m.id) || 0) + 1;
      hits.set(m.id, n);
      items.push({box, color: '#34d399'});
      if (n >= 2) registerScan(m.id);
    } else {
      sawUnknownBig = true;
      items.push({box, color: '#fbbf24'});
    }
  }
  for (const k of [...hits.keys()]) if (!seen.has(k)) hits.delete(k);

  if (sawUnknownBig && !seen.size) {
    unknownHits++;
    if (unknownHits >= 3) setBanner('Не узнаю. Подойдите ближе, смотрите в камеру', 'warn', 2500);
  } else unknownHits = 0;

  drawBoxes(kCanvas, kVideo, items);
}

function registerScan(fid) {
  const f = fighterById(fid); if (!f) return;
  const d = new Date();
  const key = dateStr(d) + '|' + fid;
  if (doneToday.has(key)) {
    // сегодня уже записан — повторно не пишем, только показываем на экране
    setBanner(labelOf(fid) + ' — уже в списке', 'seen', 2000);
    return;
  }
  doneToday.add(key);
  log.push({uid: d.getTime() + '-' + Math.random().toString(36).slice(2, 6), fid, name: f.name, date: dateStr(d), time: timeStr(d), sent: false});
  saveLog();
  setBanner('✓ ' + labelOf(fid), 'ok', 3500);
  beep();
  renderRecent();
  updateStatus();
  syncLog();
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.12);
  } catch (e) { /* звук необязателен */ }
}
document.addEventListener('pointerdown', () => { try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {} }, {passive: true});

function renderRecent() {
  const today = dateStr();
  const todays = log.filter(e => e.date === today);
  $('#todayCount').textContent = new Set(todays.map(e => e.fid || e.name)).size;
  const ul = $('#recentList'); ul.innerHTML = '';
  for (const e of todays.slice(-8).reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${esc(e.time.slice(0, 5))}</span><span>${esc(labelOf(e.fid, e.name))}</span>`;
    ul.appendChild(li);
  }
}

/* ---------- отправка в таблицу ---------- */
let sending = false;
function updateStatus() {
  const pend = log.filter(e => !e.sent).length;
  const dot = $('#netDot');
  dot.className = 'dot' + (!navigator.onLine ? ' off' : pend ? ' wait' : '');
  $('#pendingTxt').textContent = !cfg.url ? 'таблица не подключена' : pend ? `не отправлено: ${pend}` : 'всё отправлено';
}

async function syncLog(manual = false) {
  if (sending) return;
  const pend = log.filter(e => !e.sent);
  if (!pend.length) { if (manual) toast('Нечего отправлять'); return; }
  if (!cfg.url) { if (manual) toast('Сначала укажите адрес скрипта в настройках'); return; }
  sending = true;
  try {
    const r = await fetch(cfg.url, {method: 'POST', body: JSON.stringify({
      token: cfg.token, scans: pend.map(e => ({fid: e.fid, name: e.name, date: e.date, time: e.time}))
    })});
    const j = await r.json();
    if (!j.ok) throw new Error(j.error === 'bad token' ? 'неверный пароль' : (j.error || 'ошибка сервера'));
    if (j.bad) throw new Error('сервер не принял записей: ' + j.bad + ' (обновите список бойцов и приложение)');
    const ids = new Set(pend.map(e => e.uid));
    for (const e of log) if (ids.has(e.uid)) e.sent = true;
    saveLog();
    if (manual) toast(`Отправлено: ${pend.length}. Записано новых: ${j.added === undefined ? '?' : j.added}, уже было: ${j.dup === undefined ? '?' : j.dup}`, 6000);
  } catch (e) {
    if (manual) toast('Не удалось отправить: ' + e.message);
  } finally {
    sending = false;
    updateStatus();
    if ($('#tab-log') && !$('#tab-log').classList.contains('hidden')) renderLog();
  }
}

async function apiGet(action) {
  if (!cfg.url) throw new Error('не указан адрес скрипта (Настройки)');
  const u = new URL(cfg.url);
  u.searchParams.set('action', action);
  u.searchParams.set('token', cfg.token);
  const r = await fetch(u.toString());
  const j = await r.json();
  if (!j.ok) throw new Error(j.error === 'bad token' ? 'неверный пароль' : (j.error || 'ошибка сервера'));
  return j;
}

function pruneLog() {
  const cutoff = dateStr(new Date(Date.now() - 90 * 86400000));
  const before = log.length;
  log = log.filter(e => !(e.sent && e.date < cutoff));
  if (log.length !== before) saveLog();
}

/* ---------- меню ---------- */
function openMenu() { showView('menu'); switchTab('fighters'); }
function switchTab(name) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['fighters', 'log', 'settings']) $('#tab-' + t).classList.toggle('hidden', t !== name);
  if (name === 'fighters') renderFighters();
  if (name === 'log') renderLog();
  if (name === 'settings') fillSettings();
}

$('#btnMenu').onclick = () => {
  if (cfg.pin) { const p = prompt('Введите PIN'); if (p === null) return; if (p !== cfg.pin) { toast('Неверный PIN'); return; } }
  openMenu();
};
$('#btnBack').onclick = () => { showView('kiosk'); renderRecent(); };
$$('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

/* --- бойцы --- */
function renderFighters() {
  const q = $('#fSearch').value.trim().toLowerCase();
  const total = fighters.filter(f => !f.orphan).length;
  const done = fighters.filter(f => !f.orphan && f.desc && f.desc.length).length;
  $('#fSummary').textContent = fighters.length
    ? `Лица зарегистрированы: ${done} из ${total}. Нажмите на бойца, чтобы снять или обновить лицо.`
    : 'Список пуст. Укажите адрес скрипта в «Настройках» и нажмите «Обновить из таблицы».';
  const ul = $('#fList'); ul.innerHTML = '';
  const sorted = [...fighters].sort((a, b) => (a.group || '').localeCompare(b.group || '', 'ru') || a.name.localeCompare(b.name, 'ru'));
  for (const f of sorted) {
    if (q && !(f.name.toLowerCase().includes(q) || (f.group || '').toLowerCase().includes(q) || (f.nick || '').toLowerCase().includes(q))) continue;
    const n = f.desc ? f.desc.length : 0;
    const li = document.createElement('li'); li.className = 'tap';
    const chip = f.orphan ? '<span class="chip bad">нет в таблице</span>'
      : n ? `<span class="chip ok">лицо · ${n}</span>` : '<span class="chip no">нет лица</span>';
    li.innerHTML = `<div class="grow"><div class="nm">${esc(f.name)}${f.nick ? ' · «' + esc(f.nick) + '»' : ''}</div><div class="sub">${esc(f.group || 'без группы')}</div></div>${chip}`;
    li.onclick = () => openRegister(f.id);
    ul.appendChild(li);
  }
}
$('#fSearch').oninput = renderFighters;

$('#btnRefresh').onclick = async () => {
  try {
    const j = await apiGet('fighters');
    const old = new Map(fighters.map(f => [f.id, f]));
    const next = [], seen = new Set();
    for (const f of j.fighters) {
      const id = String(f.id);
      const o = old.get(id);
      next.push({id, name: f.name, group: f.group || '', nick: f.nick || '', desc: o ? (o.desc || []) : [], orphan: false});
      seen.add(id);
    }
    let kept = 0;
    for (const o of fighters) if (o.id && !seen.has(o.id) && o.desc && o.desc.length) { next.push(Object.assign({}, o, {orphan: true})); kept++; }
    fighters = next; saveFighters(); rebuildIndex(); renderFighters();
    toast(`Список обновлён: ${j.fighters.length} бойцов` + (kept ? `; «нет в таблице»: ${kept}` : ''));
  } catch (e) { toast('Не удалось обновить список: ' + e.message, 5000); }
};

/* --- регистрация лица --- */
let regTarget = null, regSamples = [], regBusy = false;
function openRegister(id) {
  regTarget = fighterById(id); if (!regTarget) return;
  regSamples = [];
  $('#rName').textContent = regTarget.name + (regTarget.group ? ' · ' + regTarget.group : '');
  updateRegUi();
  showView('register');
}
function updateRegUi() {
  $('#rCount').textContent = regSamples.length;
  $('#rSave').disabled = regSamples.length < 3;
  $('#rDelete').disabled = !(regTarget && regTarget.desc && regTarget.desc.length);
}
$('#rBack').onclick = () => { drawBoxes(rCanvas, rVideo, []); showView('menu'); switchTab('fighters'); };

$('#rCapture').onclick = async () => {
  if (regBusy || !modelsReady) return;
  regBusy = true; $('#rCapture').disabled = true;
  try {
    const dets = await detect(rVideo);
    if (dets.length !== 1) { toast(dets.length ? 'В кадре должен быть один человек' : 'Лицо не найдено — подойдите ближе'); return; }
    const d = dets[0];
    drawBoxes(rCanvas, rVideo, [{box: d.detection.box, color: '#34d399'}]);
    setTimeout(() => drawBoxes(rCanvas, rVideo, []), 600);
    if (d.detection.box.width / rVideo.videoWidth < 0.2) { toast('Лицо слишком маленькое — подойдите ближе'); return; }
    const m = matchDescriptor(d.descriptor, regTarget.id);
    if (m.id && m.dist < 0.42) toast(`Очень похоже на «${labelOf(m.id)}». Проверьте, что выбран нужный боец.`, 5000);
    regSamples.push(Array.from(d.descriptor, x => Math.round(x * 1e4) / 1e4));
    updateRegUi();
    beep();
  } catch (e) { toast('Ошибка распознавания: ' + e.message); }
  finally { regBusy = false; $('#rCapture').disabled = false; }
};
$('#rReset').onclick = () => { regSamples = []; updateRegUi(); };
$('#rSave').onclick = () => {
  regTarget.desc = (regTarget.desc || []).concat(regSamples).slice(-12);
  saveFighters(); rebuildIndex();
  toast('Сохранено: ' + regTarget.name);
  regSamples = []; updateRegUi();
  showView('menu'); switchTab('fighters');
};
$('#rDelete').onclick = () => {
  if (!confirm('Удалить все сохранённые лица бойца «' + regTarget.name + '»?')) return;
  regTarget.desc = [];
  if (regTarget.orphan) fighters = fighters.filter(f => f !== regTarget);
  saveFighters(); rebuildIndex();
  showView('menu'); switchTab('fighters');
};

/* --- журнал --- */
function renderLog() {
  const pend = log.filter(e => !e.sent).length;
  const today = dateStr();
  const todays = log.filter(e => e.date === today);
  $('#logSummary').textContent = `Сегодня записей: ${todays.length}. Не отправлено: ${pend}.`;
  const ul = $('#logList'); ul.innerHTML = '';
  for (const e of [...todays].reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sub">${esc(e.time.slice(0, 5))}</span><div class="grow">${esc(e.name)}</div><span class="chip ${e.sent ? 'ok' : 'no'}">${e.sent ? 'отправлено' : 'ждёт'}</span>`;
    ul.appendChild(li);
  }
}
$('#btnSend').onclick = () => syncLog(true);
function download(filename, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
$('#btnCsv').onclick = () => {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const rows = ['Дата;Время;Fighter_ID;Имя Фамилия'].concat(log.map(e => [e.date, e.time, e.fid || '', q(e.name)].join(';')));
  download('journal-' + dateStr() + '.csv', '﻿' + rows.join('\r\n'), 'text/csv');
};

/* --- настройки --- */
function fillSettings() {
  $('#ver').textContent = 'Версия приложения: ' + APP_VERSION;
  $('#sUrl').value = cfg.url; $('#sToken').value = cfg.token;
  $('#sThr').value = cfg.threshold; $('#sThrVal').textContent = cfg.threshold;
  $('#sMin').value = cfg.minFace; $('#sMinVal').textContent = cfg.minFace;
  $('#sFacing').value = cfg.facing; $('#sPin').value = cfg.pin;
}
$('#sThr').oninput = e => $('#sThrVal').textContent = e.target.value;
$('#sMin').oninput = e => $('#sMinVal').textContent = e.target.value;
$('#btnSaveCfg').onclick = async () => {
  const prevFacing = cfg.facing;
  cfg = {
    url: $('#sUrl').value.trim(), token: $('#sToken').value.trim(),
    threshold: parseFloat($('#sThr').value), minFace: parseFloat($('#sMin').value),
    facing: $('#sFacing').value, pin: $('#sPin').value.trim()
  };
  lsSet(KEYS.cfg, cfg);
  updateStatus();
  if (cfg.facing !== prevFacing) { try { await startCamera(); } catch (e) { toast('Камера: ' + e.message); return; } }
  toast('Настройки сохранены');
};

$('#btnBackup').onclick = () => {
  const data = fighters.filter(f => f.desc && f.desc.length).map(f => ({id: f.id, name: f.name, group: f.group, desc: f.desc}));
  download('faces-backup-' + dateStr() + '.json', JSON.stringify({v: 1, fighters: data}), 'application/json');
};
$('#btnRestore').onclick = () => $('#fileRestore').click();
$('#fileRestore').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (!j || !Array.isArray(j.fighters)) throw new Error('неверный формат файла');
    const byId = new Map(fighters.map(f => [f.id, f]));
    let n = 0;
    for (const it of j.fighters) {
      if (!it.id || !it.name || !Array.isArray(it.desc)) continue;
      const desc = it.desc.filter(a => Array.isArray(a) && a.length === 128);
      if (!desc.length) continue;
      const cur = byId.get(String(it.id));
      if (cur) { cur.desc = desc; cur.orphan = false; }
      else fighters.push({id: String(it.id), name: it.name, group: it.group || '', desc, orphan: true});
      n++;
    }
    saveFighters(); rebuildIndex(); renderFighters();
    toast('Загружено бойцов: ' + n);
  } catch (err) { toast('Не удалось загрузить: ' + err.message); }
};

/* ---------- экран не гаснет, камера не пропадает ---------- */
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (!cameraAlive()) { try { await startCamera(); } catch (e) { setBanner('Нет доступа к камере', 'bad'); } }
  renderRecent();
});
window.addEventListener('online', () => { updateStatus(); syncLog(); });
window.addEventListener('offline', updateStatus);

/* ---------- старт ---------- */
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  pruneLog();
  rebuildDone(); renderRecent(); updateStatus();
  keepAwake();
  try {
    setBanner('Загрузка моделей…', 'load');
    await loadModels();
  } catch (e) { setBanner('Не удалось загрузить модели: ' + e.message, 'bad'); return; }
  rebuildIndex();
  try { await startCamera(); }
  catch (e) { setBanner('Нет доступа к камере: разрешите её в настройках браузера', 'bad'); return; }
  idleBanner();
  kioskLoop();
  setInterval(() => { syncLog(); updateStatus(); renderRecentIfKiosk(); }, 60000);
})();
function renderRecentIfKiosk() { if (mode === 'kiosk') renderRecent(); }
