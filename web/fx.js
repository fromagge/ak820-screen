// Text layout + per-frame effects for the 128×128 screen.
import { mulberry32 } from './gen.js';

const W = 128, H = 128, TAU = Math.PI * 2;

// --- text ---------------------------------------------------------------------

export const font = (size, family, weight = 800) => `${weight} ${size}px ${family}`;

function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word;
      if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  return lines;
}

// Largest size ≤ maxSize where the wrapped text fits the box.
export function fitText(ctx, text, family, maxSize, boxW = W - 8, boxH = H - 8) {
  for (let size = maxSize; size >= 8; size--) {
    ctx.font = font(size, family);
    const lines = wrap(ctx, text, boxW);
    if (lines.length * size * 1.12 <= boxH && lines.every((l) => ctx.measureText(l).width <= boxW)) return { size, lines };
  }
  ctx.font = font(8, family);
  return { size: 8, lines: wrap(ctx, text, boxW) };
}

export const rainbowAt = (k, phase, light = 60) => `hsl(${((k * 360 + phase * 360) % 360 + 360) % 360} 100% ${light}%)`;

// Draw centred lines. opts: { size, family, cx, cy, fill, rainbow, phase, wave, outline, limit }
export function drawLines(ctx, lines, o) {
  const lh = o.size * 1.12, total = lines.reduce((n, l) => n + l.length, 0) || 1;
  ctx.font = font(o.size, o.family);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, o.size / 7);
  ctx.strokeStyle = o.outline || '#000';
  const perChar = o.rainbow || o.wave || o.limit != null;
  let ci = 0;
  lines.forEach((line, li) => {
    const y0 = o.cy + (li - (lines.length - 1) / 2) * lh;
    let x = (o.cx ?? W / 2) - ctx.measureText(line).width / 2;
    if (!perChar) {
      if (o.outline) ctx.strokeText(line, x, y0);
      ctx.fillStyle = o.fill;
      ctx.fillText(line, x, y0);
      return;
    }
    for (const ch of line) {
      if (o.limit != null && ci >= o.limit) return;
      const y = y0 + (o.wave ? o.wave * Math.sin(TAU * (o.phase - ci / 9)) : 0);
      if (o.outline) ctx.strokeText(ch, x, y);
      ctx.fillStyle = o.rainbow ? rainbowAt(ci / total, -o.phase) : o.fill;
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width;
      ci++;
    }
  });
}

// --- effects --------------------------------------------------------------------

export const ANIMATED_FX = ['spin', 'shake', 'breathe', 'pulse', 'glitch', 'cycle', 'wash', 'border', 'sparkle'];
export const isAnimated = (fx) => ANIMATED_FX.some((k) => fx[k]) || (fx.caption && fx.capRainbow);

// Changes to the base draw (before the image is placed).
export function motion(fx, t) {
  const s = Math.sin(TAU * t);
  return {
    bri: fx.pulse ? 1 + 0.4 * s : 1,
    hue: (fx.hue || 0) + (fx.cycle ? 360 * t : 0),
    dx: fx.shake ? Math.round(Math.sin(TAU * t * 5) * 4 + Math.sin(TAU * t * 13) * 2) : 0,
    dy: fx.shake ? Math.round(Math.cos(TAU * t * 7) * 4) : 0,
    spin: fx.spin ? 360 * t * fx.spin : 0,
    zoom: fx.breathe ? 1 + 0.16 * (1 - Math.cos(TAU * t)) / 2 : 1,
    filters: (fx.gray ? ' grayscale(1)' : '') + (fx.sepia ? ' sepia(1)' : '') + (fx.invert ? ' invert(1)' : ''),
  };
}

let tmp = null;
// Effects on top of the placed image, in screen space.
export function post(ctx, fx, t, i) {
  if (fx.wash) {
    ctx.save();
    ctx.globalCompositeOperation = 'color';
    ctx.globalAlpha = 0.8;
    const g = ctx.createLinearGradient(0, 0, W, H);
    for (let k = 0; k <= 6; k++) g.addColorStop(k / 6, rainbowAt(k / 6, -t, 50));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (fx.pixel > 1) {
    const s = Math.max(4, Math.round(W / fx.pixel));
    tmp ||= new OffscreenCanvas(W, H);
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.clearRect(0, 0, W, H);
    tctx.drawImage(ctx.canvas, 0, 0, s, s);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, s, s, 0, 0, W, H);
    ctx.restore();
  }
  if (fx.posterize) posterize(ctx, 4);
  if (fx.glitch) glitch(ctx, i);
  if (fx.sparkle) sparkle(ctx, t);
  if (fx.scan) {
    ctx.fillStyle = 'rgb(0 0 0 / .35)';
    for (let y = 1; y < H; y += 2) ctx.fillRect(0, y, W, 1);
  }
  if (fx.vignette) {
    const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.75);
    g.addColorStop(0, 'rgb(0 0 0 / 0)');
    g.addColorStop(1, 'rgb(0 0 0 / .85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (fx.caption) caption(ctx, fx, t);
  if (fx.border) {
    const g = ctx.createConicGradient(TAU * t, W / 2, H / 2);
    for (let k = 0; k <= 6; k++) g.addColorStop(k / 6, rainbowAt(k / 6, 0, 55));
    ctx.strokeStyle = g;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  }
}

function posterize(ctx, levels) {
  const img = ctx.getImageData(0, 0, W, H), d = img.data, step = 255 / (levels - 1);
  for (let p = 0; p < d.length; p += 4)
    for (let c = 0; c < 3; c++) d[p + c] = Math.round(d[p + c] / step) * step;
  ctx.putImageData(img, 0, 0);
}

function glitch(ctx, i) {
  const rand = mulberry32(i * 7919 + 17);
  if (rand() > 0.6) return; // some frames stay clean
  const img = ctx.getImageData(0, 0, W, H), d = img.data, src = new Uint8ClampedArray(d);
  const slices = 2 + Math.floor(rand() * 4);
  for (let s = 0; s < slices; s++) {
    const y0 = Math.floor(rand() * H), h = 2 + Math.floor(rand() * 10), dx = Math.round((rand() - 0.5) * 28);
    for (let y = y0; y < Math.min(H, y0 + h); y++)
      for (let x = 0; x < W; x++) {
        const sx = Math.min(W - 1, Math.max(0, x - dx)), p = (y * W + x) * 4, q = (y * W + sx) * 4;
        d[p] = src[q]; d[p + 1] = src[q + 1]; d[p + 2] = src[q + 2];
      }
  }
  const shift = 1 + Math.floor(rand() * 3); // red/blue split
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      d[p] = src[(y * W + Math.min(W - 1, x + shift)) * 4];
      d[p + 2] = src[(y * W + Math.max(0, x - shift)) * 4 + 2];
    }
  ctx.putImageData(img, 0, 0);
}

function sparkle(ctx, t) {
  const rand = mulberry32(99);
  for (let k = 0; k < 22; k++) {
    const x = rand() * W, y = rand() * H, ph = rand(), size = 2 + rand() * 4;
    const a = Math.max(0, Math.sin(TAU * (t * 2 + ph)));
    if (a < 0.05) continue;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#fff';
    ctx.translate(x, y);
    ctx.beginPath();
    for (let j = 0; j < 4; j++) {
      ctx.rotate(Math.PI / 2);
      ctx.moveTo(0, 0); ctx.lineTo(size * a, size * 0.18); ctx.lineTo(size * a, -size * 0.18);
    }
    ctx.fill();
    ctx.restore();
  }
}

function caption(ctx, fx, t) {
  const family = 'system-ui, sans-serif';
  const { size, lines } = fitText(ctx, fx.caption, family, 20, W - 10, H / 3);
  const block = lines.length * size * 1.12;
  const cy = { top: 6 + block / 2, middle: H / 2, bottom: H - 6 - block / 2 }[fx.capPos || 'bottom'];
  drawLines(ctx, lines, { size, family, cy, fill: fx.capColor || '#fff', rainbow: fx.capRainbow, phase: t, outline: '#000' });
}
