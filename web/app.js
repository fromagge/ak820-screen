import { Keyboard, supported, W, H, payloadBytes, parsePayload } from './ak820.js';
import { GENERATORS, defaults, renderGenerator } from './gen.js';
import { fitText, drawLines, font, motion, post, isAnimated } from './fx.js';

const $ = (id) => document.getElementById(id);
const BYTES_PER_SEC = 30000;
const MAX_SOURCE = 512;      // downscale decoded frames to bound memory
const HARD_MAX_FRAMES = 255; // header byte limit

let kb = null, maxFrames = 0;
let source = [];   // [{ bmp: ImageBitmap, delay }]
let output = [];   // [{ data: ImageData, delay }]
let mode = 'anim';
let uploading = null;
let currentName = '';
let lastFile = null;
let lastFrame = null; // first output frame before switching to Draw

const frameLimit = () => Math.min(maxFrames || 140, HARD_MAX_FRAMES);

// --- UI helpers ---------------------------------------------------------------
function pill(text, cls = '') { $('pilltext').textContent = text; $('pill').className = 'pill ' + cls; }
function msg(text, cls = '') { $('msg').textContent = text; $('msg').className = 'msg ' + cls; }
const segValue = (name) => document.querySelector(`.seg[data-name="${name}"] [aria-pressed=true]`)?.dataset.v;
const setSeg = (name, v) => document.querySelectorAll(`.seg[data-name="${name}"] button`).forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === v));
const chipOn = (id) => $(id)?.getAttribute('aria-pressed') === 'true';
const setChip = (el, on) => el.setAttribute('aria-pressed', on);

const fmt = {
  zoom: (v) => v + '%', bri: (v) => v + '%', con: (v) => v + '%', sat: (v) => v + '%',
  speed: (v) => (v >= 0 ? 2 ** v : 1 / 2 ** -v) + '×', tstart: (v) => +v + 1, tend: (v) => +v + 1,
  skip: (v) => (v == 1 ? 'all frames' : `1 in ${v}`), vfps: (v) => v + ' fps', tsize: (v) => v + 'px',
  gframes: (v) => v + ' frames', fxloop: (v) => v + ' frames', fxhue: (v) => v + '°',
  fxpixel: (v) => (v == 1 ? 'off' : v + '×'), bsize: (v) => v + 'px',
};
function updateOut(el) {
  const out = $(el.id + '-o');
  if (out) out.textContent = (fmt[el.id] || ((v) => v))(el.value);
}
document.querySelectorAll('input[type=range]').forEach(updateOut);

let pending = 0;
function route(kind) {
  if (kind === 'none') return;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    if (kind === 'text') { if (mode === 'text') makeText(); }
    else if (kind === 'anim') { if (mode === 'anim') makeAnim(); }
    else render();
  });
}

document.addEventListener('click', (e) => {
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const seg = segBtn.parentElement;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === segBtn));
    route(seg.dataset.on || 'render');
    return;
  }
  const chip = e.target.closest('.chip');
  if (chip) {
    setChip(chip, chip.getAttribute('aria-pressed') !== 'true');
    route(chip.dataset.on || 'render');
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.type === 'range') updateOut(el);
  if (el.dataset.on === 'video' || el.closest('#tab-draw') || el.id === 'file') return;
  route(el.dataset.on || 'render');
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.on === 'video' && lastFile) loadFile(lastFile);
});

function setRange(id, v) { $(id).value = v; updateOut($(id)); }

$('reset').onclick = () => {
  for (const [id, v] of [['zoom', 100], ['panx', 0], ['pany', 0], ['bri', 100], ['con', 100], ['sat', 100], ['speed', 0], ['skip', 1]]) setRange(id, v);
  setRange('tstart', 0); setRange('tend', $('tend').max);
  $('bg').value = '#000000'; setChip($('flip'), false);
  setSeg('fit', 'cover'); setSeg('rot', '0');
  render();
};

// --- tabs -----------------------------------------------------------------------
function showTab(t) {
  if (mode !== 'draw' && output[0]) lastFrame = output[0].data;
  mode = t;
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  for (const id of ['anim', 'file', 'text', 'draw']) $('tab-' + id).hidden = id !== t;
  $('fpsctl').hidden = !(t === 'file' && lastFile?.type.startsWith('video/'));
  if (t === 'file') lastFile ? loadFile(lastFile) : setSource([]);
  else if (t === 'text') makeText();
  else if (t === 'anim') { startThumbs(); makeAnim(); }
  else if (t === 'draw') useDrawing();
}
document.querySelectorAll('[role=tab]').forEach((tab) => (tab.onclick = () => showTab(tab.dataset.tab)));

function setSource(frames, keepTrim = false) {
  const old = source;
  source = frames;
  old.forEach((f) => !frames.includes(f) && f.bmp.close?.());
  const max = Math.max(0, source.length - 1);
  $('tstart').max = $('tend').max = max;
  if (!keepTrim) { setRange('tstart', 0); setRange('tend', max); }
  document.querySelectorAll('.trim').forEach((el) => (el.hidden = source.length <= 1));
  render();
}

// --- decoding -----------------------------------------------------------------
async function toBitmap(src, w, h) {
  const s = Math.min(1, MAX_SOURCE / Math.max(w, h));
  return createImageBitmap(src, { resizeWidth: Math.max(1, Math.round(w * s)), resizeHeight: Math.max(1, Math.round(h * s)), resizeQuality: 'high' });
}

async function decodeImage(file) {
  const out = [];
  if ('ImageDecoder' in window && (await ImageDecoder.isTypeSupported(file.type))) {
    const dec = new ImageDecoder({ data: file.stream(), type: file.type });
    await dec.tracks.ready;
    const count = Math.min(dec.tracks.selectedTrack.frameCount, 600);
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      out.push({ bmp: await toBitmap(image, image.displayWidth, image.displayHeight), delay: Math.round((image.duration ?? 100000) / 1000) || 100 });
      image.close();
      if (i % 10 === 0) msg(`Decoding… frame ${i + 1}/${count}`);
    }
    dec.close();
  } else {
    const b = await createImageBitmap(file);
    out.push({ bmp: await toBitmap(b, b.width, b.height), delay: 100 });
  }
  return out;
}

async function decodeVideo(file) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(file);
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error("This video format can't be read")); });
  const fps = +$('vfps').value, step = 1 / fps, limit = frameLimit();
  const frames = Math.min(limit, Math.floor(v.duration * fps) || 1), out = [];
  for (let i = 0; i < frames; i++) {
    v.currentTime = i * step;
    await new Promise((r) => (v.onseeked = r));
    out.push({ bmp: await toBitmap(v, v.videoWidth, v.videoHeight), delay: Math.round(1000 / fps) });
    if (i % 5 === 0) msg(`Reading video… ${i + 1}/${frames}`);
  }
  URL.revokeObjectURL(v.src);
  if (v.duration * fps > limit) msg(`Video trimmed to the first ${(limit / fps).toFixed(1)} s (${limit} frames).`);
  return out;
}

async function loadFile(file) {
  if (mode !== 'file') { lastFile = file; showTab('file'); return; }
  lastFile = file;
  currentName = file.name;
  const isVideo = file.type.startsWith('video/');
  $('fpsctl').hidden = !isVideo;
  msg('Decoding…');
  let frames = [];
  try {
    frames = isVideo ? await decodeVideo(file) : await decodeImage(file);
    if (!$('msg').textContent.startsWith('Video trimmed')) msg('');
  } catch (e) {
    msg(e.message || "Couldn't read that file", 'err');
  }
  setSource(frames);
}

// --- text -----------------------------------------------------------------------
function makeText() {
  const text = $('txt').value.trim() || ' ';
  const family = $('tfont').value, maxSize = +$('tsize').value, speed = +$('tspeed').value;
  const style = segValue('tmode'), rainbow = segValue('tcol') === 'rainbow';
  const bgc = $('tbg').value;
  currentName = `“${text.replace(/\s+/g, ' ').slice(0, 24)}”`;
  const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d');
  const frame = (draw) => { ctx.fillStyle = bgc; ctx.fillRect(0, 0, W, H); draw?.(); return c.transferToImageBitmap(); };
  const base = { family, cy: H / 2 + 1, fill: $('tfg').value, rainbow, outline: chipOn('toutline') ? '#000' : null };
  const limit = frameLimit(), fresh = [];

  if (style === 'scroll') {
    const line = text.replace(/\s+/g, ' ');
    ctx.font = font(maxSize, family);
    const tw = Math.ceil(ctx.measureText(line).width), dist = W + tw;
    const px = Math.max(speed, Math.ceil(dist / limit)), n = Math.ceil(dist / px);
    for (let k = 0; k < n; k++)
      fresh.push({ bmp: frame(() => drawLines(ctx, [line], { ...base, size: maxSize, cx: W - k * px + tw / 2, phase: k / n })), delay: 40 });
  } else {
    const { size, lines } = fitText(ctx, text, family, maxSize);
    const o = { ...base, size };
    if (style === 'static') {
      const n = rainbow ? 24 : 1;
      for (let k = 0; k < n; k++) fresh.push({ bmp: frame(() => drawLines(ctx, lines, { ...o, phase: k / n })), delay: rainbow ? 110 - speed * 10 : 500 });
    } else if (style === 'blink') {
      fresh.push({ bmp: frame(() => drawLines(ctx, lines, { ...o, phase: 0 })), delay: 560 - speed * 50 }, { bmp: frame(), delay: 560 - speed * 50 });
    } else if (style === 'wave') {
      const n = 24;
      for (let k = 0; k < n; k++) fresh.push({ bmp: frame(() => drawLines(ctx, lines, { ...o, phase: k / n, wave: size * 0.18 })), delay: 90 - speed * 8 });
    } else if (style === 'type') {
      const total = lines.reduce((s, l) => s + l.length, 0) || 1;
      const step = Math.max(1, Math.ceil(total / (limit - 5)));
      for (let k = step; k < total + step; k += step)
        fresh.push({ bmp: frame(() => drawLines(ctx, lines, { ...o, phase: 0, limit: Math.min(k, total) })), delay: 200 - speed * 20 });
      for (let h = 0; h < 3; h++) fresh.push({ bmp: frame(() => drawLines(ctx, lines, { ...o, phase: 0 })), delay: 500 });
      fresh.push({ bmp: frame(), delay: 300 });
    }
  }
  setSource(fresh);
}

// --- animations -----------------------------------------------------------------
let gen = GENERATORS[0], genSeed = 1;

function buildGens() {
  const box = $('gens');
  for (const g of GENERATORS) {
    const b = document.createElement('button');
    b.className = 'gen'; b.dataset.gen = g.id; b.setAttribute('aria-pressed', g === gen);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const label = document.createElement('span'); label.textContent = g.name;
    if (g.id === 'rainbow') label.className = 'rb';
    b.append(c, label);
    b.onclick = () => selectGen(g);
    box.append(b);
  }
}

function selectGen(g, params) {
  gen = g; genSeed = 1;
  document.querySelectorAll('.gen').forEach((b) => b.setAttribute('aria-pressed', b.dataset.gen === g.id));
  buildParams(params || defaults(g));
  makeAnim();
}

function buildParams(values) {
  const box = $('genparams');
  box.replaceChildren();
  for (const p of gen.params) {
    const ctl = document.createElement('div');
    ctl.className = 'ctl' + (p.type === 'seg' && p.options.length > 3 ? ' full' : '');
    const label = document.createElement('label');
    label.textContent = p.label;
    let input;
    if (p.type === 'seg') {
      input = document.createElement('div');
      input.className = 'seg'; input.dataset.name = 'g_' + p.key; input.dataset.on = 'anim';
      for (const [v, text] of p.options) {
        const b = document.createElement('button');
        b.dataset.v = v; b.textContent = text; b.setAttribute('aria-pressed', v === values[p.key]);
        input.append(b);
      }
    } else {
      input = document.createElement('input');
      input.id = 'g_' + p.key; input.dataset.on = 'anim'; input.value = values[p.key];
      if (p.type === 'range') {
        Object.assign(input, { type: 'range', min: p.min, max: p.max });
        const out = document.createElement('output'); out.id = input.id + '-o'; label.append(out);
      } else input.type = 'text';
      label.htmlFor = input.id;
    }
    ctl.append(label, input);
    box.append(ctl);
    if (p.type === 'range') updateOut(input);
  }
}

const readGenParams = () => Object.fromEntries(gen.params.map((p) => [p.key, p.type === 'seg' ? segValue('g_' + p.key) : $('g_' + p.key).value]));

function makeAnim() {
  const n = Math.min(+$('gframes').value, frameLimit());
  const bmps = renderGenerator(gen, readGenParams(), n, genSeed);
  currentName = gen.name;
  setSource(bmps.map((bmp) => ({ bmp, delay: 50 })));
}

$('shuffle').onclick = () => { genSeed = 1 + Math.floor(Math.random() * 1e6); makeAnim(); };

const pick = (a) => a[Math.floor(Math.random() * a.length)];
$('surprise').onclick = () => {
  const g = pick(GENERATORS), params = defaults(g);
  for (const p of g.params) if (p.type === 'seg') params[p.key] = pick(p.options)[0];
  clearFx();
  if (Math.random() < 0.5) randomFx(1);
  selectGen(g, params);
  genSeed = 1 + Math.floor(Math.random() * 1e6);
  makeAnim();
};

let thumbsStarted = false;
function startThumbs() {
  if (thumbsStarted) return;
  thumbsStarted = true;
  const sets = GENERATORS.map((g) => renderGenerator(g, defaults(g), 16, 1));
  const canvases = [...document.querySelectorAll('.gen canvas')];
  let i = 0;
  setInterval(() => {
    if (document.hidden || mode !== 'anim') return;
    canvases.forEach((c, k) => c.getContext('2d').drawImage(sets[k][i % 16], 0, 0));
    i++;
  }, 90);
}

// --- drawing --------------------------------------------------------------------
const dc = $('draw'), dctx = dc.getContext('2d', { willReadFrequently: true });
const undo = [];
let stroking = null, brushHue = 0;

function fillDrawBg() { dctx.fillStyle = $('dbg').value; dctx.fillRect(0, 0, W, H); }
fillDrawBg();
const pushUndo = () => { undo.push(dctx.getImageData(0, 0, W, H)); if (undo.length > 40) undo.shift(); };
const posOf = (e) => { const r = dc.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };

function stroke(a, b) {
  const erase = segValue('tool') === 'erase', rainbow = chipOn('brainbow') && !erase;
  if (rainbow) brushHue = (brushHue + Math.hypot(b[0] - a[0], b[1] - a[1]) * 4 + 1) % 360;
  dctx.lineCap = 'round'; dctx.lineJoin = 'round'; dctx.lineWidth = +$('bsize').value;
  dctx.strokeStyle = erase ? $('dbg').value : rainbow ? `hsl(${brushHue} 100% 55%)` : $('bcolor').value;
  dctx.beginPath(); dctx.moveTo(a[0], a[1]); dctx.lineTo(b[0] + 0.01, b[1]); dctx.stroke();
}

let drawPending = 0;
const scheduleDrawing = () => { cancelAnimationFrame(drawPending); drawPending = requestAnimationFrame(useDrawing); };
dc.onpointerdown = (e) => { dc.setPointerCapture(e.pointerId); pushUndo(); stroking = posOf(e); stroke(stroking, stroking); scheduleDrawing(); };
dc.onpointermove = (e) => { if (!stroking) return; const p = posOf(e); stroke(stroking, p); stroking = p; scheduleDrawing(); };
dc.onpointerup = dc.onpointercancel = () => { stroking = null; scheduleDrawing(); };

$('dundo').onclick = () => { const s = undo.pop(); if (s) { dctx.putImageData(s, 0, 0); useDrawing(); } };
$('dclear').onclick = () => { pushUndo(); fillDrawBg(); useDrawing(); };
$('dtrace').onclick = () => {
  if (!lastFrame) return msg('Open an image, text or animation first, then come back here.');
  pushUndo(); dctx.putImageData(lastFrame, 0, 0); useDrawing();
};

async function useDrawing() {
  if (mode !== 'draw') return;
  currentName = 'Drawing';
  setSource([{ bmp: await createImageBitmap(dc), delay: 500 }]);
}

// --- effects --------------------------------------------------------------------
const fxChips = () => [...document.querySelectorAll('#fxpanel .chip[data-fx]')];
function readFx() {
  const fx = {};
  for (const c of fxChips()) fx[c.dataset.fx] = c.getAttribute('aria-pressed') === 'true';
  fx.spin = fx.spin ? 1 : 0;
  fx.hue = +$('fxhue').value;
  fx.pixel = +$('fxpixel').value;
  fx.caption = $('fxcap').value.trim();
  fx.capPos = segValue('cappos');
  fx.capColor = $('fxcapcolor').value;
  fx.loop = +$('fxloop').value;
  return fx;
}
function clearFx() {
  fxChips().forEach((c) => setChip(c, false));
  setRange('fxhue', 0); setRange('fxpixel', 1); $('fxcap').value = '';
}
function randomFx(count = 1 + Math.floor(Math.random() * 2)) {
  const nice = ['cycle', 'wash', 'border', 'spin', 'shake', 'breathe', 'pulse', 'glitch', 'sparkle', 'scan', 'vignette', 'posterize'];
  for (let k = 0; k < count; k++) setChip(document.querySelector(`[data-fx="${pick(nice)}"]`), true);
}
$('fxclear').onclick = () => { clearFx(); render(); };
$('fxrandom').onclick = () => { clearFx(); randomFx(); render(); };

// --- render pipeline --------------------------------------------------------------
const work = new OffscreenCanvas(W, H), wctx = work.getContext('2d', { willReadFrequently: true });

function drawFrame(bmp, o, fx, t, i) {
  const m = motion(fx, t);
  wctx.save();
  wctx.filter = 'none';
  wctx.fillStyle = o.bg; wctx.fillRect(0, 0, W, H);
  wctx.filter = `brightness(${o.bri * m.bri}%) contrast(${o.con}%) saturate(${o.sat}%) hue-rotate(${m.hue}deg)${m.filters}`;
  wctx.translate(W / 2 + (o.panx / 100) * W / 2 + m.dx, H / 2 + (o.pany / 100) * H / 2 + m.dy);
  wctx.rotate(((o.rot + m.spin) * Math.PI) / 180);
  if (o.mirror) wctx.scale(-1, 1);
  const sw = o.rot % 180 ? bmp.height : bmp.width, sh = o.rot % 180 ? bmp.width : bmp.height;
  let sx = W / sw, sy = H / sh;
  if (o.fit === 'cover') sx = sy = Math.max(sx, sy);
  else if (o.fit === 'contain') sx = sy = Math.min(sx, sy);
  const z = (o.zoom / 100) * m.zoom;
  sx *= z; sy *= z;
  const [dw, dh] = o.rot % 180 ? [bmp.width * sy, bmp.height * sx] : [bmp.width * sx, bmp.height * sy];
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  wctx.restore();
  post(wctx, fx, t, i);
  return wctx.getImageData(0, 0, W, H);
}

function render() {
  if (!source.length) { output = []; updateMeta(); return; }
  const o = {
    fit: segValue('fit'), rot: +segValue('rot'), mirror: chipOn('flip'), bg: $('bg').value,
    zoom: +$('zoom').value, panx: +$('panx').value, pany: -$('pany').value,
    bri: +$('bri').value, con: +$('con').value, sat: +$('sat').value,
  };
  const fx = readFx();
  const speed = 2 ** +$('speed').value, skip = +$('skip').value;
  let a = +$('tstart').value, b = +$('tend').value;
  if (a > b) [a, b] = [b, a];
  let plan = [];
  for (let i = a; i <= b; i += skip) {
    const delay = source.slice(i, Math.min(i + skip, b + 1)).reduce((s, f) => s + f.delay, 0);
    plan.push({ bmp: source[i].bmp, delay: delay / speed });
  }
  if (plan.length === 1 && isAnimated(fx))
    plan = Array.from({ length: Math.min(fx.loop, frameLimit()) }, () => ({ bmp: plan[0].bmp, delay: 70 / speed }));
  const loop = Math.min(plan.length, frameLimit()); // effects loop over what actually gets sent
  output = plan.map((p, i) => ({
    data: drawFrame(p.bmp, o, fx, (i % loop) / loop, i),
    delay: Math.max(2, Math.min(510, Math.round(p.delay))),
  }));
  updateMeta();
  play();
}

function updateMeta() {
  const n = output.length;
  if (!n) { $('framesinfo').textContent = 'No image yet'; $('sizeinfo').textContent = ''; $('upload').disabled = true; return; }
  const send = Math.min(n, frameLimit());
  const secs = Math.ceil(payloadBytes(send) / BYTES_PER_SEC);
  const over = n > frameLimit();
  $('framesinfo').textContent = `${n} frame${n > 1 ? 's' : ''}` + (over ? ` · only the first ${send} will fit` : '');
  $('framesinfo').style.color = over ? 'var(--warn)' : '';
  $('sizeinfo').textContent = `~${secs < 60 ? secs + ' s' : Math.ceil(secs / 60) + ' min'} to send`;
  $('upload').disabled = !kb || !!uploading;
}

let anim = 0;
function play() {
  cancelAnimationFrame(anim);
  const ctx = $('preview').getContext('2d');
  let i = 0, next = 0;
  const tick = (t) => {
    if (output.length && t >= next) {
      const f = output[i % Math.min(output.length, frameLimit())];
      ctx.putImageData(f.data, 0, 0);
      next = t + f.delay; i++;
    }
    anim = requestAnimationFrame(tick);
  };
  anim = requestAnimationFrame(tick);
}

// --- file inputs ------------------------------------------------------------------
const drop = $('drop');
drop.onclick = () => $('file').click();
drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && $('file').click();
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f && /^(image|video)\//.test(f.type)) loadFile(f);
});
window.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) loadFile(f);
});

// --- device -------------------------------------------------------------------------
async function attach(k) {
  kb = k;
  if (!kb) { pill('Not connected'); $('devpanel').hidden = true; updateMeta(); return; }
  pill(kb.name, 'ok');
  $('connect').textContent = 'Reconnect';
  $('devpanel').hidden = false;
  try {
    const info = await kb.info();
    if (info) {
      maxFrames = info.maxFrames;
      $('devinfo').innerHTML = `<span>Firmware ${info.firmware}</span><span>Battery ${info.battery}%${info.charging ? ' ⚡' : ''}</span><span>Up to ${info.maxFrames} frames</span>`;
      route(mode === 'text' ? 'text' : mode === 'anim' ? 'anim' : 'render');
    }
  } catch (e) { console.warn(e); }
  $('synctime').disabled = !kb.cfg;
  updateMeta();
}

if (!supported()) {
  $('nohid').hidden = false; $('connect').disabled = true; pill('WebHID unavailable', 'err');
} else {
  Keyboard.reconnect().then((k) => k && attach(k)).catch(() => {});
  navigator.hid.addEventListener('disconnect', (e) => {
    if (kb?.owns(e.device)) { attach(null); pill('Disconnected', 'err'); }
  });
  navigator.hid.addEventListener('connect', async () => { if (!kb) { const k = await Keyboard.reconnect(); k && attach(k); } });
}

$('connect').onclick = async () => {
  try {
    const k = await Keyboard.request();
    if (!k) { pill("That's not the screen interface", 'err'); msg('Pick the AK820 / 820PRO entry. If only "2.4G Dongle" is listed, switch the keyboard to wired mode.', 'err'); return; }
    msg(''); attach(k);
  } catch (e) {
    if (e.name === 'NotFoundError') return; // chooser dismissed
    pill('Connection failed', 'err');
    msg(/access|permission|open/i.test(e.message) ? "The browser can't open the keyboard. On Linux, see Help below. Otherwise close the official driver and try again." : e.message, 'err');
  }
};

$('upload').onclick = async () => {
  const frames = output.slice(0, frameLimit());
  uploading = new AbortController();
  $('upload').disabled = true; $('prog').hidden = false; $('cancel').hidden = false; $('prog').value = 0;
  pill('Sending…', 'busy');
  const t0 = performance.now();
  try {
    const payload = await kb.upload(frames, {
      signal: uploading.signal,
      onProgress: (p) => {
        $('prog').value = p;
        const el = (performance.now() - t0) / 1000, left = Math.max(0, el / p - el);
        msg(`Sending… ${Math.round(p * 100)}% · ${Math.ceil(left)} s left`);
      },
    });
    msg(`Done. ${frames.length} frame${frames.length > 1 ? 's' : ''} on your keyboard.`, 'ok');
    await saveHistory(payload, currentName || 'Image');
  } catch (e) {
    msg(e.message === 'cancelled' ? 'Cancelled. The screen may show a partial image until you send again.' : `Send failed: ${e.message}. Check the cable and try again.`, 'err');
  }
  uploading = null;
  $('prog').hidden = true; $('cancel').hidden = true;
  if (kb) pill(kb.name, 'ok');
  updateMeta();
};
$('cancel').onclick = () => uploading?.abort();

$('synctime').onclick = async () => {
  try { await kb.syncClock(); msg('Clock synced to this computer.', 'ok'); } catch (e) { msg(e.message, 'err'); }
};
$('setbuiltin').onclick = async () => {
  try { await kb.showBuiltIn(+$('builtin').value); msg('Built-in animation selected.', 'ok'); } catch (e) { msg(e.message, 'err'); }
};

// --- history (IndexedDB, this browser only) ----------------------------------------
const HISTORY_MAX = 30;
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('ak820', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function store(txMode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction('history', txMode), req = fn(tx.objectStore('history'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}

function thumb(imageData) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c.toDataURL('image/png');
}

let selected = null;
async function saveHistory(payload, name) {
  try {
    const [first] = parsePayload(payload, 1);
    await store('readwrite', (s) => s.add({ date: Date.now(), name, frames: payload[0], payload, thumb: thumb(first.data) }));
    const keys = await store('readonly', (s) => s.getAllKeys());
    if (keys.length > HISTORY_MAX) await store('readwrite', (s) => { for (const k of keys.slice(0, keys.length - HISTORY_MAX)) s.delete(k); });
    selected = null;
    renderHistory();
  } catch (e) { console.warn('history not saved', e); }
}

const when = (t) => {
  const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

async function renderHistory() {
  let items = [];
  try { items = (await store('readonly', (s) => s.getAll())).sort((a, b) => b.id - a.id); }
  catch { $('histpanel').hidden = true; return; }
  const box = $('hist');
  box.replaceChildren();
  $('histclear').hidden = !items.length;
  if (!items.length) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = 'Nothing sent yet. Your first upload will show up here.';
    box.append(p); return;
  }
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'hitem' + (selected === it.id ? ' sel' : '');
    b.title = `Load "${it.name}" (sent ${new Date(it.date).toLocaleString()})`;
    const img = document.createElement('img'); img.src = it.thumb; img.alt = '';
    const cap = document.createElement('span'); cap.className = 'cap';
    const nm = document.createElement('b'); nm.textContent = it.name;
    cap.append(nm, document.createElement('br'), `${when(it.date)} · ${it.frames} fr`);
    b.append(img, cap);
    if (i === 0) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Now'; badge.title = 'Last thing sent from this browser'; b.append(badge); }
    const del = document.createElement('span'); del.className = 'del'; del.textContent = '✕'; del.title = 'Delete';
    del.setAttribute('role', 'button'); del.setAttribute('aria-label', `Delete ${it.name}`);
    del.onclick = async (e) => { e.stopPropagation(); await store('readwrite', (s) => s.delete(it.id)); renderHistory(); };
    b.append(del);
    b.onclick = () => loadHistory(it);
    box.append(b);
  });
}

async function loadHistory(it) {
  const frames = parsePayload(it.payload);
  const bmps = await Promise.all(frames.map(async (f) => ({ bmp: await createImageBitmap(f.data), delay: f.delay })));
  // Show it exactly as sent: effects and adjustments are already baked in.
  mode = 'file'; lastFile = null; currentName = it.name; selected = it.id;
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === 'file'));
  for (const id of ['anim', 'file', 'text', 'draw']) $('tab-' + id).hidden = id !== 'file';
  $('fpsctl').hidden = true;
  clearFx();
  setSource(bmps);
  $('reset').click();
  renderHistory();
  msg(`Showing "${it.name}", sent ${new Date(it.date).toLocaleString()}. Press Send to put it back.`);
  if (innerWidth < 820) $('preview').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('histclear').onclick = async () => {
  if (!confirm('Delete all saved history from this browser?')) return;
  await store('readwrite', (s) => s.clear());
  renderHistory();
};

// --- start ----------------------------------------------------------------------------
buildGens();
buildParams(defaults(gen));
renderHistory();
showTab('anim');
