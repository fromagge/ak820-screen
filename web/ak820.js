// AK820 Pro TFT protocol over WebHID. See ../PROTOCOL.md.
export const VID = 0x0c45;
export const PIDS = [0x800a, 0x8009];
export const W = 128, H = 128;
const CONFIG_PAGES = [0xff68, 0xff80, 0xff60, 0xff00, 0xff01, 0xff1b];
const BULK_PAGE = 0xff67;

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
  constructor(cfg, bulk) {
    this.cfg = cfg;
    this.bulk = bulk;
    this.name = bulk.productName || 'AK820 Pro';
  }

  static async fromDevices(devices) {
    const ours = devices.filter((d) => d.vendorId === VID && PIDS.includes(d.productId));
    const bulk = ours.find((d) => d.collections.some((c) => c.usagePage === BULK_PAGE));
    if (!bulk) return null;
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
    const d = new Uint8Array([0x5a, 1, 0x5a, t.getFullYear() % 100, t.getMonth() + 1, t.getDate(),
      t.getHours(), t.getMinutes(), t.getSeconds(), t.getDay()]);
    await command(this.cfg, CMD.TEMP, d, 24);
  }

  async showBuiltIn(index) {
    await command(this.bulk, CMD.TFT_BUILTIN, new Uint8Array([index]), 1, { retries: 0 });
  }

  // frames: [{ data: ImageData(128x128), delay: ms }]
  async upload(frames, { onProgress, signal } = {}) {
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

// Bytes on the wire per upload, for time estimates.
export const payloadBytes = (n) => 256 + n * W * H * 2;
