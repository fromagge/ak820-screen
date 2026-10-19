// Paste into the DevTools console of a WebHID page (e.g. the vendor driver) BEFORE
// connecting. Logs every HID packet the page sends and receives (first 32 bytes).
// When done: copy(__hidlog.join('\n'))  → paste into a text file.
(() => {
  const log = (window.__hidlog = []);
  const t0 = performance.now();
  const hex = (v) => {
    const u = v instanceof DataView ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
    return [...u.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join(' ') + (u.length > 32 ? ` …(${u.length})` : '');
  };
  const tag = (d) => `${d.productId.toString(16)}/${(d.collections[0]?.usagePage ?? 0).toString(16)}`;
  const stamp = () => ((performance.now() - t0) / 1000).toFixed(3).padStart(8);
  const P = HIDDevice.prototype;
  for (const m of ['sendReport', 'sendFeatureReport']) {
    const orig = P[m];
    P[m] = function (id, data) { log.push(`${stamp()} ${tag(this)} ${m}(${id}) ${hex(data)}`); return orig.call(this, id, data); };
  }
  const origRecv = P.receiveFeatureReport;
  P.receiveFeatureReport = async function (id) {
    const r = await origRecv.call(this, id);
    log.push(`${stamp()} ${tag(this)} receiveFeatureReport(${id}) ${hex(r)}`);
    return r;
  };
  const origAdd = P.addEventListener;
  const seen = new WeakSet();
  P.addEventListener = function (type, fn, opts) {
    if (type === 'inputreport' && !seen.has(this)) {
      seen.add(this);
      origAdd.call(this, 'inputreport', (e) => log.push(`${stamp()} ${tag(this)} input(${e.reportId}) ${hex(e.data)}`));
    }
    return origAdd.call(this, type, fn, opts);
  };
  console.log('HID logger on. When done: copy(__hidlog.join("\\n"))');
})();
