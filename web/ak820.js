// AK820 Pro TFT protocol over WebHID. See ../PROTOCOL.md.
export const VID = 0x0c45;
export const PIDS = [0x800a, 0x8009];
export const W = 128, H = 128;
const CONFIG_PAGES = [0xff68, 0xff80, 0xff60, 0xff00, 0xff01, 0xff1b];
const BULK_PAGE = 0xff67;
// Second layout (e.g. 0C45:800A seen on Linux): commands as 64-byte feature reports on
// FF13, pixels as 4096-byte output reports on FF68. See PROTOCOL.md "FF13 + FF68 layout".
const FF13_PAGE = 0xff13;
const FF68_PAGE = 0xff68;
const BLOCK = 4096;
export const LAYOUT = { LEGACY: 'legacy', FF13: 'ff13' };
// Mutable so tests can zero the waits.
export const TIMING = { settle: 220, poll: 60, replyTimeout: 6000, announcePause: 120, startPause: 250, blockGap: 150 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasPage = (d, page) => d.collections.some((c) => c.usagePage === page);

const CMD = { INFO: 0x10, TEMP: 0x34, ANIM_ACK: 0x41, TFT_ANIM: 0x50, TFT_BUILTIN: 0x51 };

const reportLen = (d, fallback) =>
  d?.collections?.[0]?.outputReports?.[0]?.items?.[0]?.reportCount || fallback;

function waitReply(dev, cmd, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dev.removeEventListener('inputreport', on);
      reject(new Error(`no reply to 0x${cmd.toString(16)}`));
    }, ms);
    function on(e) {
      const d = new Uint8Array(e.data.buffer);
      if (d[0] === 0x55 && d[1] === cmd) {
        clearTimeout(timer);
        dev.removeEventListener('inputreport', on);
        resolve(d);
      }
    }
    dev.addEventListener('inputreport', on);
  });
}

async function transact(dev, pkt, replyCmd, ms = 500, retries = 3) {
  for (let i = 0; ; i++) {
    const reply = replyCmd == null ? null : waitReply(dev, replyCmd, ms);
    reply?.catch(() => {});
    await dev.sendReport(0, pkt);
    if (!reply) return null;
    try {
      return await reply;
    } catch (e) {
      if (i >= retries) throw e;
    }
  }
}

async function command(dev, cmd, data = new Uint8Array(), size = data.length, { ms = 500, retries = 3 } = {}) {
  const len = reportLen(dev, 32), per = len - 8;
  const chunks = Math.max(1, Math.ceil(size / per)), out = [];
  for (let n = 0; n < chunks; n++) {
    const addr = n * per, pkt = new Uint8Array(len);
    pkt.set([0xaa, cmd, Math.min(per, size - addr), addr & 255, addr >> 8, 0, n === chunks - 1 ? 1 : 0, 0]);
    pkt.set(data.slice(addr, addr + per), 8);
    const r = await transact(dev, pkt, retries ? cmd : null, ms, retries);
    if (r) out.push(r);
  }
  return out;
}

export const supported = () => 'hid' in navigator;

export class Keyboard {
  constructor(cfg, bulk, layout = LAYOUT.LEGACY) {
    this.cfg = cfg;
    this.bulk = bulk;
    this.layout = layout;
    this.busy = false;
    this.name = bulk.productName || (layout === LAYOUT.FF13 ? cfg.productName : null) || 'AK820 Pro';
  }

  static async fromDevices(devices) {
    const ours = devices.filter((d) => d.vendorId === VID && PIDS.includes(d.productId));
    const bulk = ours.find((d) => hasPage(d, BULK_PAGE));
    if (!bulk) {
      // No FF67: try the FF13 + FF68 layout. The legacy path below is untouched.
      const cfg13 = ours.find((d) => hasPage(d, FF13_PAGE));
      const data68 = ours.find((d) => hasPage(d, FF68_PAGE));
      if (!cfg13 || !data68) return null;
      for (const d of new Set([cfg13, data68])) if (!d.opened) await d.open();
      return new Keyboard(cfg13, data68, LAYOUT.FF13);
    }
    const cfg = ours.find((d) => d.collections.some((c) => CONFIG_PAGES.includes(c.usagePage))) || null;
    for (const d of [cfg, bulk]) if (d && !d.opened) await d.open();
    return new Keyboard(cfg, bulk);
  }

  static async request() {
    await navigator.hid.requestDevice({ filters: PIDS.map((productId) => ({ vendorId: VID, productId })) });
    return Keyboard.fromDevices(await navigator.hid.getDevices());
  }

  static async reconnect() {
    return Keyboard.fromDevices(await navigator.hid.getDevices());
  }

  owns(device) {
    return device === this.cfg || device === this.bulk;
  }

  async info() {
    if (this.layout === LAYOUT.FF13) {
      // No GET_DEVICE_INFO known for this layout; the screen limit is the vendor's 140 frames.
      return { firmware: null, battery: null, charging: false, profile: null, maxFrames: 140, hasScreen: true };
    }
    if (!this.cfg) return null;
    const r = await command(this.cfg, CMD.INFO, new Uint8Array(), 48);
    const i = new Uint8Array(r.flatMap((x) => [...x.slice(8)])).slice(0, 48);
    return {
      firmware: (((i[8] & 15) + (i[8] >> 4) * 10 + i[9] * 100) / 100).toFixed(2),
      battery: i[17],
      charging: !!i[18],
      profile: i[19],
      maxFrames: i[22] | (i[23] << 8),
      hasScreen: i[28] !== 0xff,
    };
  }

  async syncClock(t = new Date()) {
    if (this.layout === LAYOUT.FF13) return this._ff13Clock(t);
    const d = new Uint8Array([0x5a, 1, 0x5a, t.getFullYear() % 100, t.getMonth() + 1, t.getDate(),
      t.getHours(), t.getMinutes(), t.getSeconds(), t.getDay()]);
    await command(this.cfg, CMD.TEMP, d, 24);
  }

  async showBuiltIn(index) {
    if (this.layout === LAYOUT.FF13) throw new Error('Built-in animations are not supported on this keyboard layout yet.');
    await command(this.bulk, CMD.TFT_BUILTIN, new Uint8Array([index]), 1, { retries: 0 });
  }

  // frames: [{ data: ImageData(128x128), delay: ms }]
  async upload(frames, { onProgress, signal } = {}) {
    if (this.layout === LAYOUT.FF13) return this._ff13Upload(frames, onProgress);
    const payload = buildPayload(frames);
    const len = reportLen(this.bulk, 4104), per = len - 8;
    const total = Math.ceil(payload.length / per);
    for (let idx = 0; idx < total; idx++) {
      if (signal?.aborted) throw new Error('cancelled');
      const pkt = new Uint8Array(len);
      pkt.set([0xaa, CMD.TFT_ANIM, idx & 255, idx >> 8, total & 255, total >> 8, 0x50, 0x06]);
      pkt.set(payload.subarray(idx * per, (idx + 1) * per), 8);
      await transact(this.bulk, pkt, CMD.ANIM_ACK, 2000, 3);
      onProgress?.((idx + 1) / total);
    }
    return payload;
  }
  // --- FF13 + FF68 layout ---------------------------------------------------------
  // Every command is a 64-byte feature report on FF13 answered in the same buffer:
  // reply = 04 <cmd> 00 <status>, status 0x01 ok / 0xFF refused. A read right after a
  // write returns our own frame (status 0), so wait for the settle time and poll.
  async _ff13Send(bytes) {
    const f = new Uint8Array(64);
    f.set(bytes);
    await this.cfg.sendFeatureReport(0, f);
  }

  async _ff13Reply(cmd) {
    await sleep(TIMING.settle);
    const t0 = performance.now();
    while (performance.now() - t0 < TIMING.replyTimeout) {
      try {
        const d = new Uint8Array((await this.cfg.receiveFeatureReport(0)).buffer);
        if (d[0] === 0x04 && d[1] === cmd && d[3] !== 0) return d[3];
      } catch { /* retry until timeout */ }
      await sleep(TIMING.poll);
    }
    return null;
  }

  async _ff13Step(bytes, cmd, label) {
    await this._ff13Send(bytes);
    const status = await this._ff13Reply(cmd);
    if (status !== 0x01) {
      throw new Error(`${label}: ${status === null ? 'no reply from the keyboard' : `refused (0x${status.toString(16)})`}`);
    }
  }

  async _ff13Abort() { try { await this._ff13Send([0x04, 0xf0]); } catch { /* ignore */ } }

  async _ff13Begin() {
    try { await this._ff13Step([0x04, 0x18], 0x18, 'begin'); } catch (e) { await this._ff13Abort(); throw e; }
  }

  async _ff13Clock(t) {
    if (this.busy) throw new Error('A transfer is already running.');
    this.busy = true;
    try {
      await this._ff13Begin();
      try { await this._ff13Step([0x04, 0x28, 0, 0, 0, 0, 0, 0, 1], 0x28, 'clock announce'); } catch (e) { await this._ff13Abort(); throw e; }
      await sleep(TIMING.announcePause);
      const body = new Uint8Array(64);
      body.set([0, 1, 0x5a, t.getFullYear() % 100, t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds(), 0, t.getDay()]);
      body[62] = 0xaa; body[63] = 0x55;
      await this._ff13Send(body);
      await this._ff13Step([0x04, 0x02], 0x02, 'clock commit');
    } finally { this.busy = false; }
  }

  // Once the announce is accepted the keyboard expects every block: there is no cancel
  // (04 F0 does not stop it and the keyboard hangs until replugged), so no signal here.
  async _ff13Upload(frames, onProgress) {
    if (this.busy) throw new Error('A transfer is already running.');
    const payload = buildPayloadFf13(frames), blocks = payload.length / BLOCK;
    if (blocks > 0xffff) throw new Error('Too many frames.');
    this.busy = true;
    try {
      await this._ff13Begin();
      try { await this._ff13Step([0x04, 0x72, 0x03, 0, 0, 0, 0, 0, blocks & 255, blocks >> 8], 0x72, 'announce'); } catch (e) { await this._ff13Abort(); throw e; }
      await sleep(TIMING.startPause);
      for (let i = 0; i < blocks; i++) {
        await this.bulk.sendReport(0, payload.slice(i * BLOCK, (i + 1) * BLOCK));
        onProgress?.((i + 1) / blocks);
        if (i < blocks - 1) await sleep(TIMING.blockGap);
      }
      await this._ff13Step([0x04, 0x02], 0x02, 'commit');
    } finally { this.busy = false; }
    return payload;
  }
}

export function buildPayload(frames) {
  const n = frames.length, hdr = new Uint8Array(256).fill(0xff);
  hdr[0] = n;
  for (let k = 0; k < n - 1; k++) hdr[k + 1] = Math.max(1, Math.min(255, Math.round(frames[k].delay / 2)));
  hdr[n] = 0;
  const out = new Uint8Array(256 + n * W * H * 2);
  out.set(hdr);
  let j = 256;
  for (const { data } of frames) {
    const d = data.data;
    for (let p = 0; p < d.length; p += 4) {
      const v = ((d[p] & 0xf8) << 8) | ((d[p + 1] & 0xfc) << 3) | (d[p + 2] >> 3);
      out[j++] = v & 255;
      out[j++] = v >> 8;
    }
  }
  return out;
}

// FF13 layout payload: same header + RGB565 frames, but every frame's delay is stored
// (2 ms units, 30-500 ms) and the buffer is padded with 0xFF to (frames*8+1) blocks of 4096.
export function buildPayloadFf13(frames) {
  const n = frames.length;
  if (n < 1 || n > 140) throw new Error('An animation needs 1 to 140 frames.');
  const out = new Uint8Array((n * 8 + 1) * BLOCK).fill(0xff);
  out[0] = n;
  const base = buildPayload(frames);
  out.set(base.subarray(256), 256);
  for (let k = 0; k < n; k++) out[1 + k] = Math.round(Math.max(30, Math.min(500, frames[k].delay)) / 2);
  return out;
}

// Inverse of buildPayload: what was sent → [{ data: ImageData, delay }].
export function parsePayload(payload, limit = Infinity) {
  const n = payload[0], frames = [];
  for (let k = 0; k < Math.min(n, limit); k++) {
    const img = new ImageData(W, H), d = img.data;
    let j = 256 + k * W * H * 2;
    for (let p = 0; p < d.length; p += 4, j += 2) {
      const v = payload[j] | (payload[j + 1] << 8);
      d[p] = ((v >> 11) & 31) * 255 / 31;
      d[p + 1] = ((v >> 5) & 63) * 255 / 63;
      d[p + 2] = (v & 31) * 255 / 31;
      d[p + 3] = 255;
    }
    const raw = k < n - 1 ? payload[k + 1] : payload[n - 1] || 50; // last frame's delay isn't stored
    frames.push({ data: img, delay: n === 1 ? 500 : raw * 2 });
  }
  return frames;
}

// Bytes on the wire per upload, for time estimates.
export const payloadBytes = (n) => 256 + n * W * H * 2;
