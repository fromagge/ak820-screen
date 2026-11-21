import test from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard, LAYOUT, TIMING, buildPayloadFf13 } from '../web/ak820.js';

Object.assign(TIMING, { settle: 0, poll: 0, announcePause: 0, startPause: 0, blockGap: 0 });

const coll = (...pages) => pages.map((usagePage) => ({ usagePage }));
const frame = (v = 0) => ({ data: { data: new Uint8ClampedArray(128 * 128 * 4).fill(v) }, delay: 100 });

// Fake keyboard: records writes, answers feature reads like the firmware (04 cmd 00 status).
function fakeDevices({ refuse = null } = {}) {
  const log = [];
  let last = null;
  const cfg = {
    vendorId: 0x0c45, productId: 0x800a, opened: true, collections: coll(0xff13),
    async sendFeatureReport(id, d) { last = new Uint8Array(d); log.push(['feature', last]); },
    async receiveFeatureReport() {
      const r = new Uint8Array(64);
      r.set([0x04, last[1], 0, last[1] === refuse ? 0xff : 0x01]);
      return new DataView(r.buffer);
    },
  };
  const data = {
    vendorId: 0x0c45, productId: 0x800a, opened: true, collections: coll(0xff68),
    async sendReport(id, d) { log.push(['out', new Uint8Array(d)]); },
  };
  return { cfg, data, log };
}

test('only FF68 or only FF13 is not a usable layout', async () => {
  const { cfg, data } = fakeDevices();
  assert.equal(await Keyboard.fromDevices([data]), null);
  assert.equal(await Keyboard.fromDevices([cfg]), null);
});

test('FF67 still selects the legacy layout, FF13+FF68 the new one', async () => {
  const legacy = { vendorId: 0x0c45, productId: 0x800a, opened: true, collections: coll(0xff67, 0xff68) };
  assert.equal((await Keyboard.fromDevices([legacy])).layout, LAYOUT.LEGACY);
  const { cfg, data } = fakeDevices();
  assert.equal((await Keyboard.fromDevices([cfg, data])).layout, LAYOUT.FF13);
});

test('payload: (n*8+1) blocks, delays in 2 ms units, 0xFF padding', () => {
  const p = buildPayloadFf13([frame(), frame()]);
  assert.equal(p.length, 17 * 4096);
  assert.equal(p[0], 2);
  assert.deepEqual([...p.subarray(1, 3)], [50, 50]);
  assert.equal(p[3], 0xff);
  assert.equal(p[p.length - 1], 0xff);
  assert.throws(() => buildPayloadFf13([]));
});

test('upload: begin, announce with 16-bit LE block count, blocks, commit, no 04 F0', async () => {
  const { cfg, data, log } = fakeDevices();
  const kb = await Keyboard.fromDevices([cfg, data]);
  const frames = Array.from({ length: 60 }, () => frame());
  await kb.upload(frames);
  const features = log.filter((l) => l[0] === 'feature').map((l) => l[1]);
  assert.deepEqual([...features[0].subarray(0, 2)], [0x04, 0x18]);
  assert.deepEqual([...features[1].subarray(0, 10)], [0x04, 0x72, 0x03, 0, 0, 0, 0, 0, 0xe1, 0x01]);
  assert.deepEqual([...features[2].subarray(0, 2)], [0x04, 0x02]);
  assert.equal(features.length, 3);
  const outs = log.filter((l) => l[0] === 'out');
  assert.equal(outs.length, 481);
  assert.ok(outs.every((o) => o[1].length === 4096));
});

test('refused announce aborts with 04 F0 before any block', async () => {
  const { cfg, data, log } = fakeDevices({ refuse: 0x72 });
  const kb = await Keyboard.fromDevices([cfg, data]);
  await assert.rejects(kb.upload([frame()]), /announce: refused/);
  assert.equal(log.filter((l) => l[0] === 'out').length, 0);
  assert.deepEqual([...log.at(-1)[1].subarray(0, 2)], [0x04, 0xf0]);
  assert.equal(kb.busy, false);
});

test('clock: begin, 04 28 announce, 64-byte body with AA 55, commit', async () => {
  const { cfg, data, log } = fakeDevices();
  const kb = await Keyboard.fromDevices([cfg, data]);
  await kb.syncClock(new Date(2026, 9, 29, 20, 40, 26)); // Thu
  const f = log.map((l) => l[1]);
  assert.deepEqual([...f[1].subarray(0, 9)], [0x04, 0x28, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...f[2].subarray(0, 11)], [0, 1, 0x5a, 26, 10, 29, 20, 40, 26, 0, 4]);
  assert.deepEqual([...f[2].subarray(62)], [0xaa, 0x55]);
  assert.deepEqual([...f[3].subarray(0, 2)], [0x04, 0x02]);
});

test('built-in animations are rejected on the new layout', async () => {
  const { cfg, data } = fakeDevices();
  await assert.rejects((await Keyboard.fromDevices([cfg, data])).showBuiltIn(0), /not supported/);
});
