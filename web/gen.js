// Procedural animations for a 128×128 screen. Every generator is a seamless loop:
// draw(ctx, t, params, state) is called for t in [0, 1) and t = 1 matches t = 0.
const W = 128, H = 128, TAU = Math.PI * 2;

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// h in degrees, s/v in 0..1 → [r, g, b] 0..255
export function hsv(h, s = 1, v = 1) {
  h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), u = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i % 6];
  return [r * 255, g * 255, b * 255];
}

const frac = (x) => x - Math.floor(x);
const tri = (x) => 1 - Math.abs(2 * frac(x) - 1);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Fill every pixel from fn(x, y) → [r, g, b].
function perPixel(ctx, fn) {
  const img = ctx.createImageData(W, H), d = img.data;
  for (let y = 0, p = 0; y < H; y++)
    for (let x = 0; x < W; x++, p += 4) {
      const c = fn(x, y);
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

const PALETTES = {
  rainbow: (v, t) => hsv(v * 360 + t * 360),
  fire: (v) => [255 * clamp01(v * 3), 255 * clamp01(v * 3 - 1), 255 * clamp01(v * 3 - 2)],
  ocean: (v) => hsv(180 + v * 60, 0.9, 0.25 + v * 0.75),
  neon: (v, t) => hsv(280 + Math.sin(v * TAU) * 60 + t * 360, 1, 0.4 + 0.6 * v),
  ice: (v) => hsv(200 + v * 30, 1 - v * 0.8, 0.2 + v * 0.8),
  toxic: (v) => hsv(90 + v * 40, 1, 0.15 + v * 0.85),
  mono: (v) => [v * 255, v * 255, v * 255],
};

function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s);
  ctx.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
  ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
  ctx.fill();
}

const seg = (key, label, options, value = options[0][0]) => ({ type: 'seg', key, label, options, value });

export const GENERATORS = [
  {
    id: 'rainbow', name: 'Rainbow',
    params: [
      seg('pattern', 'Pattern', [['h', 'Across'], ['v', 'Down'], ['d', 'Diagonal'], ['r', 'Rings'], ['s', 'Spiral'], ['c', 'Swirl']]),
      { type: 'range', key: 'bands', label: 'Bands', min: 1, max: 4, value: 1 },
      seg('soft', 'Look', [['full', 'Bright'], ['pastel', 'Pastel'], ['dark', 'Deep']]),
    ],
    draw(ctx, t, p) {
      const n = +p.bands, [s, v] = { full: [1, 1], pastel: [0.45, 1], dark: [1, 0.6] }[p.soft];
      const cx = W / 2, cy = H / 2, maxd = Math.hypot(cx, cy);
      const at = {
        h: (x) => x / W,
        v: (x, y) => y / H,
        d: (x, y) => (x + y) / (W + H),
        r: (x, y) => Math.hypot(x - cx, y - cy) / maxd,
        s: (x, y) => Math.atan2(y - cy, x - cx) / TAU + Math.hypot(x - cx, y - cy) / maxd,
        c: (x, y) => Math.atan2(y - cy, x - cx) / TAU,
      }[p.pattern];
      perPixel(ctx, (x, y) => hsv((at(x, y) * n - t) * 360, s, v));
    },
  },
  {
    id: 'plasma', name: 'Plasma',
    params: [seg('palette', 'Colours', [['rainbow', 'Rainbow'], ['neon', 'Neon'], ['fire', 'Lava'], ['ocean', 'Ocean'], ['toxic', 'Toxic']])],
    draw(ctx, t, p) {
      const T = t * TAU, pal = PALETTES[p.palette];
      perPixel(ctx, (x, y) => {
        const v = Math.sin(x / 13 + T) + Math.sin(y / 9 - T) + Math.sin((x + y) / 17 + 2 * T)
          + Math.sin(Math.hypot(x - 64 + 30 * Math.sin(T), y - 64 + 30 * Math.cos(T)) / 9);
        return pal((v + 4) / 8, t);
      });
    },
  },
  {
    id: 'matrix', name: 'Matrix',
    params: [seg('color', 'Colour', [['green', 'Green'], ['rainbow', 'Rainbow'], ['blue', 'Blue'], ['red', 'Red']])],
    init(rand) {
      return Array.from({ length: 16 }, (_, i) => ({ x: i * 8, off: rand(), speed: 1 + Math.floor(rand() * 3), trail: 6 + Math.floor(rand() * 8), seed: rand() * 1e6 }));
    },
    draw(ctx, t, p, cols) {
      const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEF<>*+';
      const hue = { green: 120, blue: 200, red: 0 }[p.color];
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.font = '9px ui-monospace, monospace'; ctx.textBaseline = 'top';
      const rows = 16;
      for (const c of cols) {
        const span = rows + c.trail, head = frac(c.off + t * c.speed) * span;
        for (let k = 0; k < c.trail; k++) {
          const row = Math.floor(head) - k;
          if (row < 0 || row >= rows) continue;
          const g = glyphs[Math.floor(mulberry32(c.seed + row * 31 + (Math.floor(t * 12) % 12))() * glyphs.length)];
          const fade = 1 - k / c.trail;
          const h = p.color === 'rainbow' ? c.x * 2.8 + t * 360 : hue;
          const [r, gg, b] = k === 0 ? [230, 255, 230] : hsv(h, 1, 0.25 + 0.75 * fade);
          ctx.fillStyle = `rgb(${r},${gg},${b})`;
          ctx.fillText(g, c.x, row * 8);
        }
      }
    },
  },
  {
    id: 'stars', name: 'Warp',
    params: [seg('color', 'Stars', [['white', 'White'], ['rainbow', 'Rainbow'], ['gold', 'Gold']]), seg('streak', 'Trails', [['1', 'On'], ['0', 'Off']])],
    init(rand) { return Array.from({ length: 140 }, () => ({ x: rand() * 2 - 1, y: rand() * 2 - 1, z: rand(), h: rand() * 360 })); },
    draw(ctx, t, p, stars) {
      ctx.fillStyle = '#02030a'; ctx.fillRect(0, 0, W, H);
      for (const s of stars) {
        const z = frac(s.z - t) * 0.95 + 0.05, z2 = Math.min(1, z + 0.06);
        const sx = 64 + (s.x / z) * 36, sy = 64 + (s.y / z) * 36;
        if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue;
        const b = 1 - z;
        const [r, g, bb] = p.color === 'rainbow' ? hsv(s.h + t * 360, 0.8, b) : p.color === 'gold' ? hsv(42, 0.7, b) : [255 * b, 255 * b, 255 * b];
        ctx.strokeStyle = ctx.fillStyle = `rgb(${r},${g},${bb})`;
        if (p.streak === '1') {
          ctx.lineWidth = 0.6 + b * 1.6;
          ctx.beginPath(); ctx.moveTo(64 + (s.x / z2) * 36, 64 + (s.y / z2) * 36); ctx.lineTo(sx, sy); ctx.stroke();
        } else {
          const r2 = 0.5 + b * 1.8; ctx.fillRect(sx - r2 / 2, sy - r2 / 2, r2, r2);
        }
      }
    },
  },
  {
    id: 'fire', name: 'Fire',
    params: [seg('palette', 'Flame', [['fire', 'Classic'], ['ice', 'Ice'], ['toxic', 'Toxic'], ['rainbow', 'Rainbow']])],
    draw(ctx, t, p) {
      const T = t * TAU, pal = PALETTES[p.palette];
      perPixel(ctx, (x, y) => {
        const up = y / H; // 0 top, 1 bottom
        const n = Math.sin(x * 0.19 + y * 0.31 + 3 * T) * 0.5 + Math.sin(x * 0.07 - y * 0.23 + 2 * T + 1.3) * 0.7
          + Math.sin(x * 0.41 + y * 0.53 + 5 * T + 2.1) * 0.3 + Math.sin(x * 0.11 + y * 0.67 + 4 * T) * 0.4;
        const heat = up ** 1.6 * 1.35 + n * 0.22 * up - 0.18;
        return p.palette === 'rainbow' ? hsv(x * 2.8 + t * 360, 1, clamp01(heat * 1.4)) : pal(clamp01(heat), t);
      });
    },
  },
  {
    id: 'snow', name: 'Snow',
    params: [seg('sky', 'Sky', [['night', 'Night'], ['dusk', 'Dusk'], ['black', 'Black']])],
    init(rand) { return Array.from({ length: 110 }, () => ({ x: rand() * W, y: rand(), r: 0.6 + rand() * 1.9, k: 1 + Math.floor(rand() * 2), ph: rand(), m: 1 + Math.floor(rand() * 3) })); },
    draw(ctx, t, p, flakes) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      const sky = { night: ['#03081f', '#1b2d5a'], dusk: ['#2a0f3d', '#c2577a'], black: ['#000', '#000'] }[p.sky];
      g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      for (const f of flakes) {
        const y = frac(f.y + t * f.k) * (H + 10) - 5, x = f.x + Math.sin((t * f.m + f.ph) * TAU) * 4;
        ctx.globalAlpha = 0.5 + f.r / 5;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, f.r, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  },
  {
    id: 'hearts', name: 'Hearts',
    params: [seg('mood', 'Colours', [['love', 'Love'], ['rainbow', 'Rainbow'], ['pastel', 'Pastel']])],
    init(rand) { return Array.from({ length: 26 }, () => ({ x: rand() * W, y: rand(), s: 7 + rand() * 12, k: 1, ph: rand(), h: rand() })); },
    draw(ctx, t, p, hearts) {
      ctx.fillStyle = p.mood === 'pastel' ? '#fff0f5' : '#14020a'; ctx.fillRect(0, 0, W, H);
      for (const h of hearts) {
        const y = H + 12 - frac(h.y + t * h.k) * (H + 30), x = h.x + Math.sin((t * 2 + h.ph) * TAU) * 6;
        const [r, g, b] = p.mood === 'rainbow' ? hsv(h.h * 360 + t * 360) : p.mood === 'pastel' ? hsv(330 + h.h * 60, 0.35, 1) : hsv(340 + h.h * 30, 0.85, 0.6 + h.h * 0.4);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        heartPath(ctx, x, y, h.s * (1 + 0.08 * Math.sin((t * 4 + h.ph) * TAU)));
      }
    },
  },
  {
    id: 'bounce', name: 'Bounce',
    params: [{ type: 'text', key: 'text', label: 'Text', value: 'AK820' }, seg('size', 'Size', [['18', 'Small'], ['26', 'Medium'], ['36', 'Large']], '26')],
    draw(ctx, t, p) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.font = `800 ${p.size}px system-ui, sans-serif`; ctx.textBaseline = 'top';
      const text = p.text || ' ', w = Math.min(W - 2, ctx.measureText(text).width), h = +p.size;
      // integer bounce counts per loop → seamless; 10 wall hits per loop → 36° hue step
      const x = tri(t * 2 + 0.13) * (W - w), y = tri(t * 3 + 0.31) * (H - h);
      const hits = Math.floor(2 * (t * 2 + 0.13)) + Math.floor(2 * (t * 3 + 0.31));
      const [r, g, bb] = hsv(hits * 36);
      ctx.fillStyle = `rgb(${r},${g},${bb})`;
      ctx.fillText(text, x, y, W - 2);
    },
  },
  {
    id: 'ripples', name: 'Ripples',
    params: [seg('palette', 'Colours', [['rainbow', 'Rainbow'], ['ocean', 'Ocean'], ['neon', 'Neon'], ['mono', 'Mono']])],
    draw(ctx, t, p) {
      const T = t * TAU, pal = PALETTES[p.palette];
      const ax = 64 + 34 * Math.cos(T), ay = 64 + 34 * Math.sin(T), bx = 64 - 34 * Math.cos(T), by = 64 - 34 * Math.sin(T);
      perPixel(ctx, (x, y) => {
        const v = Math.sin(Math.hypot(x - ax, y - ay) * 0.32 - T * 3) + Math.sin(Math.hypot(x - bx, y - by) * 0.32 - T * 3);
        return pal((v + 2) / 4, t);
      });
    },
  },
  {
    id: 'eq', name: 'Equalizer',
    params: [seg('color', 'Colours', [['classic', 'Classic'], ['rainbow', 'Rainbow'], ['mono', 'Mono']])],
    init(rand) { return Array.from({ length: 16 }, () => Array.from({ length: 3 }, () => ({ m: 1 + Math.floor(rand() * 4), ph: rand() * TAU, a: 0.3 + rand() * 0.5 }))); },
    draw(ctx, t, p, bars) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const bw = 8, segs = 16, sh = 8;
      bars.forEach((waves, i) => {
        let v = 0.45;
        for (const w of waves) v += w.a * 0.5 * Math.sin(t * TAU * w.m + w.ph);
        const lit = Math.round(clamp01(v) * segs);
        for (let k = 0; k < lit; k++) {
          const [r, g, b] = p.color === 'rainbow' ? hsv(i * 22 + t * 360) : p.color === 'mono' ? [230, 230, 230] : hsv(120 - (k / segs) * 120);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(i * bw + 1, H - (k + 1) * sh + 1, bw - 2, sh - 2);
        }
      });
    },
  },
];

export function defaults(gen) {
  return Object.fromEntries(gen.params.map((p) => [p.key, p.value]));
}

// Render n frames of a generator → array of ImageBitmap.
export function renderGenerator(gen, params, n, seed = 1) {
  const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  const state = gen.init?.(mulberry32(seed), params);
  const out = [];
  for (let i = 0; i < n; i++) {
    ctx.save();
    gen.draw(ctx, i / n, params, state);
    ctx.restore();
    out.push(c.transferToImageBitmap());
  }
  return out;
}
