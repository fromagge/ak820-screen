#!/usr/bin/env python3
"""Drive the AJAZZ / Epomaker AK820 Pro TFT screen over hidraw. See PROTOCOL.md."""
import argparse
import datetime
import glob
import os
import select
import sys
import time

VID = 0x0C45
PIDS = {0x800A, 0x8009}
CONFIG_PAGES = {0xFF68, 0xFF80, 0xFF60, 0xFF00, 0xFF01, 0xFF1B}
BULK_PAGE = 0xFF67
W = H = 128
HIST_DIR = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"),
                        "ak820", "history")
HIST_MAX = 50

CMD_GET_DEVICE_INFO = 0x10
CMD_TEMP_DATA = 0x34
CMD_LED_USER_ANIM = 0x41
CMD_TFT_USER_ANIM = 0x50
CMD_TFT_BUILTIN = 0x51


def parse_descriptor(desc):
    """Return (first usage page, output report byte count) from a HID report descriptor."""
    page = None
    size = count = 0
    out_bits = 0
    i = 0
    while i < len(desc):
        b = desc[i]
        if b == 0xFE:  # long item
            i += 3 + desc[i + 1]
            continue
        n = (0, 1, 2, 4)[b & 3]
        val = int.from_bytes(desc[i + 1:i + 1 + n], "little")
        tag = b & 0xFC
        if tag == 0x04 and page is None:
            page = val
        elif tag == 0x74:
            size = val
        elif tag == 0x94:
            count = val
        elif tag == 0x90:
            out_bits += size * count
        i += 1 + n
    return page, out_bits // 8


def find_interfaces():
    config = bulk = None
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            uevent = open(f"{node}/device/uevent").read()
            hid_id = next(l for l in uevent.splitlines() if l.startswith("HID_ID="))
            _, vid, pid = hid_id.split("=")[1].split(":")
            if int(vid, 16) != VID or int(pid, 16) not in PIDS:
                continue
            desc = open(f"{node}/device/report_descriptor", "rb").read()
        except (OSError, StopIteration):
            continue
        page, out_len = parse_descriptor(desc)
        dev = "/dev/" + os.path.basename(node)
        if page == BULK_PAGE:
            bulk = (dev, out_len or 4104)
        elif page in CONFIG_PAGES and config is None:
            config = (dev, out_len or 32)
    return config, bulk


class Iface:
    def __init__(self, path, report_len):
        self.path, self.report_len = path, report_len
        try:
            self.fd = os.open(path, os.O_RDWR)
        except PermissionError:
            sys.exit(f"no permission on {path} — install 70-ak820.rules (see README)")

    def drain(self):
        while select.select([self.fd], [], [], 0)[0]:
            os.read(self.fd, 8192)

    def write(self, pkt):
        os.write(self.fd, bytes([0]) + bytes(pkt))

    def wait(self, cmd, timeout):
        end = time.monotonic() + timeout
        while (left := end - time.monotonic()) > 0:
            if not select.select([self.fd], [], [], left)[0]:
                break
            r = os.read(self.fd, 8192)
            if len(r) > 1 and r[0] == 0x55 and r[1] == cmd:
                return r
        return None

    def transact(self, pkt, reply_cmd, timeout=0.5, retries=3):
        for attempt in range(retries + 1):
            self.drain()
            self.write(pkt)
            if retries == 0 and reply_cmd is None:
                return None
            r = self.wait(reply_cmd, timeout)
            if r is not None:
                return r
            if retries:
                print(f"  cmd 0x{pkt[1]:02x}: no reply, retry {attempt + 1}", file=sys.stderr)
        if retries:
            raise TimeoutError(f"cmd 0x{pkt[1]:02x}: no reply")
        return None

    def command(self, cmd, data=b"", content_size=None, timeout=0.5, retries=3):
        """Standard chunked command (vendor kX/AX)."""
        content_size = len(data) if content_size is None else content_size
        per = self.report_len - 8
        chunks = max(1, -(-content_size // per))
        replies = []
        for n in range(chunks):
            addr = n * per
            ln = min(per, content_size - addr)
            pkt = bytearray(self.report_len)
            pkt[0:5] = (0xAA, cmd, ln, addr & 0xFF, addr >> 8)
            pkt[6] = 1 if n == chunks - 1 else 0
            part = data[addr:addr + per]
            pkt[8:8 + len(part)] = part
            r = self.transact(pkt, cmd, timeout, retries)
            if r is not None:
                replies.append(r)
        return replies


def open_ifaces(need_bulk=False):
    config, bulk = find_interfaces()
    if config is None and bulk is None:
        sys.exit("AK820 Pro not found on USB. Switch to wired mode and plug in the cable "
                 "(the 2.4G dongle can't reach the screen).")
    if need_bulk and bulk is None:
        sys.exit("bulk (0xFF67) interface not found")
    return (Iface(*config) if config else None), (Iface(*bulk) if bulk else None)


def get_info(cfg):
    r = cfg.command(CMD_GET_DEVICE_INFO, content_size=48)
    i = b"".join(x[8:] for x in r)[:48]
    return {
        "vid": f"{i[4] | i[5] << 8:04x}",
        "pid": f"{i[6] | i[7] << 8:04x}",
        "firmware": f"{((i[8] & 15) + (i[8] >> 4) * 10 + i[9] * 100) / 100:.2f}",
        "workMode": i[16],
        "battery": i[17],
        "charging": i[18],
        "profile": i[19],
        "tftMaxFrames": i[22] | i[23] << 8,
        "tftDirection": i[28],
        "frameVersion": i[30],
    }


# --- image handling -----------------------------------------------------------

def load_frames(path, fit, bg):
    from PIL import Image, ImageOps, ImageSequence
    im = Image.open(path)
    frames = []
    for fr in ImageSequence.Iterator(im):
        delay_ms = fr.info.get("duration", im.info.get("duration", 100)) or 100
        rgba = fr.convert("RGBA")
        if fit == "cover":
            rgba = ImageOps.fit(rgba, (W, H), Image.LANCZOS)
        elif fit == "stretch":
            rgba = rgba.resize((W, H), Image.LANCZOS)
        else:
            rgba = ImageOps.contain(rgba, (W, H), Image.LANCZOS)
        canvas = Image.new("RGBA", (W, H), bg)
        canvas.alpha_composite(rgba, ((W - rgba.width) // 2, (H - rgba.height) // 2))
        frames.append((canvas.convert("RGB"), delay_ms))
    return frames


def rgb565le(img):
    src = img.tobytes()
    out = bytearray(len(src) // 3 * 2)
    for j, i in enumerate(range(0, len(src), 3)):
        v = ((src[i] & 0xF8) << 8) | ((src[i + 1] & 0xFC) << 3) | (src[i + 2] >> 3)
        out[2 * j] = v & 0xFF
        out[2 * j + 1] = v >> 8
    return out


def build_payload(frames):
    n = len(frames)
    hdr = bytearray([0xFF] * 256)
    hdr[0] = n
    for k in range(n - 1):
        hdr[k + 1] = max(1, min(255, round(frames[k][1] / 2)))  # 2 ms units
    hdr[n] = 0
    return bytes(hdr) + b"".join(rgb565le(f) for f, _ in frames)


def upload(bulk, payload, report_len):
    per = report_len - 8
    total = -(-len(payload) // per)
    for idx in range(total):
        pkt = bytearray(report_len)
        pkt[0:8] = (0xAA, CMD_TFT_USER_ANIM, idx & 0xFF, idx >> 8,
                    total & 0xFF, total >> 8, 0x50, 0x06)
        chunk = payload[idx * per:(idx + 1) * per]
        pkt[8:8 + len(chunk)] = chunk
        bulk.transact(pkt, CMD_LED_USER_ANIM, timeout=2.0, retries=3)
        print(f"\r  uploading {100 * (idx + 1) // total:3d}%", end="", file=sys.stderr)
    print(file=sys.stderr)


# --- commands -----------------------------------------------------------------

def cmd_info(a):
    cfg, bulk = open_ifaces()
    print(f"config iface: {cfg and cfg.path} ({cfg and cfg.report_len} B)")
    print(f"bulk   iface: {bulk and bulk.path} ({bulk and bulk.report_len} B)")
    if cfg:
        for k, v in get_info(cfg).items():
            print(f"  {k:13} {v}")


def cmd_upload(a):
    cfg, bulk = open_ifaces(need_bulk=True)
    max_frames = a.max_frames
    if max_frames is None and cfg:
        try:
            max_frames = get_info(cfg)["tftMaxFrames"] or None
        except TimeoutError:
            pass
    frames = load_frames(a.image, a.fit, a.bg)
    if a.delay:
        frames = [(f, a.delay) for f, _ in frames]
    if max_frames and len(frames) > max_frames:
        print(f"  {len(frames)} frames > device max {max_frames}; truncating", file=sys.stderr)
        frames = frames[:max_frames]
    frames = frames[:255]
    if a.preview:
        frames[0][0].resize((512, 512), 0).save(a.preview)
        print(f"  preview → {a.preview}", file=sys.stderr)
    payload = build_payload(frames)
    print(f"  {len(frames)} frame(s), {len(payload)} bytes", file=sys.stderr)
    upload(bulk, payload, bulk.report_len)
    save_history(payload, os.path.basename(a.image))
    print("done")


# --- history ------------------------------------------------------------------

def save_history(payload, name):
    os.makedirs(HIST_DIR, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)[:60]
    with open(os.path.join(HIST_DIR, f"{datetime.datetime.now():%Y%m%d-%H%M%S}_{safe}.bin"), "wb") as f:
        f.write(payload)
    for old in history_files()[HIST_MAX:]:
        os.remove(old)


def history_files():
    try:
        names = [n for n in os.listdir(HIST_DIR) if n.endswith(".bin")]
    except FileNotFoundError:
        return []
    return [os.path.join(HIST_DIR, n) for n in sorted(names, reverse=True)]


def parse_payload(payload):
    """Inverse of build_payload → [(PIL.Image, delay_ms)]."""
    from PIL import Image
    n = payload[0]
    frames = []
    for k in range(n):
        raw = payload[256 + k * W * H * 2:256 + (k + 1) * W * H * 2]
        rgb = bytearray(W * H * 3)
        for j in range(W * H):
            v = raw[2 * j] | raw[2 * j + 1] << 8
            rgb[3 * j] = (v >> 11) * 255 // 31
            rgb[3 * j + 1] = (v >> 5 & 63) * 255 // 63
            rgb[3 * j + 2] = (v & 31) * 255 // 31
        delay = payload[k + 1] if k < n - 1 else payload[n - 1]
        frames.append((Image.frombytes("RGB", (W, H), bytes(rgb)), 500 if n == 1 else delay * 2))
    return frames


def pick_history(n):
    files = history_files()
    if not 1 <= n <= len(files):
        sys.exit(f"no history entry {n} (have {len(files)}; see `ak820.py history`)")
    return files[n - 1]


def cmd_history(a):
    files = history_files()
    if a.action == "list":
        if not files:
            print(f"no history yet ({HIST_DIR})")
        for i, f in enumerate(files, 1):
            stamp, _, name = os.path.basename(f)[:-4].partition("_")
            with open(f, "rb") as fh:
                frames = fh.read(1)[0]
            when = datetime.datetime.strptime(stamp, "%Y%m%d-%H%M%S")
            tag = "  ← on keyboard (if nothing else sent since)" if i == 1 else ""
            print(f"{i:3d}  {when:%Y-%m-%d %H:%M}  {frames:3d} fr  {name}{tag}")
        return
    path = pick_history(a.n)
    payload = open(path, "rb").read()
    if a.action == "export":
        frames = parse_payload(payload)
        out = a.out or os.path.basename(path)[:-4] + ".gif"
        scale = a.scale
        imgs = [f.resize((W * scale, H * scale), 0) for f, _ in frames]
        imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=[d for _, d in frames], loop=0)
        print(f"saved {out}")
    elif a.action == "restore":
        _, bulk = open_ifaces(need_bulk=True)
        upload(bulk, payload, bulk.report_len)
        save_history(payload, os.path.basename(path)[16:-4] or "restored")
        print("done")


def cmd_builtin(a):
    _, bulk = open_ifaces(need_bulk=True)
    bulk.command(CMD_TFT_BUILTIN, bytes([a.index]), retries=0)
    print("sent")


def cmd_time(a):
    cfg, _ = open_ifaces()
    t = datetime.datetime.now()
    wd = (t.weekday() + 1) % 7  # 0 = Sunday
    data = bytes([0x5A, 1, 0x5A, t.year % 100, t.month, t.day, t.hour, t.minute, t.second, wd])
    cfg.command(CMD_TEMP_DATA, data, content_size=24)
    print(f"clock set to {t:%Y-%m-%d %H:%M:%S}")


def read_cpu():
    with open("/proc/stat") as f:
        v = list(map(int, f.readline().split()[1:]))
    return v[3] + v[4], sum(v)


def read_temp(names):
    for hw in glob.glob("/sys/class/hwmon/hwmon*"):
        try:
            if open(f"{hw}/name").read().strip() in names:
                return int(open(f"{hw}/temp1_input").read()) // 1000
        except OSError:
            pass
    return 0


def read_gpu_busy():
    for p in glob.glob("/sys/class/drm/card*/device/gpu_busy_percent"):
        try:
            return int(open(p).read())
        except OSError:
            pass
    return 0


def stats_packet(cpu, cpu_t, gpu, gpu_t):
    d = bytearray(24)
    d[6] = 0x5A
    d[12], d[13], d[14], d[15] = cpu, cpu_t & 0xFF, gpu, gpu_t & 0xFF
    return bytes(d)


def cmd_stats(a):
    cfg, _ = open_ifaces()
    idle0, tot0 = read_cpu()
    while True:
        time.sleep(a.interval)
        idle1, tot1 = read_cpu()
        cpu = 100 - round(100 * (idle1 - idle0) / max(1, tot1 - tot0))
        idle0, tot0 = idle1, tot1
        cpu_t = read_temp({"k10temp", "coretemp", "zenpower"})
        gpu, gpu_t = read_gpu_busy(), read_temp({"amdgpu", "nouveau", "i915", "xe"})
        cfg.command(CMD_TEMP_DATA, stats_packet(cpu, cpu_t, gpu, gpu_t), retries=0)
        if a.verbose:
            print(f"cpu {cpu:3d}% {cpu_t}°C  gpu {gpu:3d}% {gpu_t}°C")


def cmd_raw(a):
    cfg, bulk = open_ifaces()
    dev = bulk if a.bulk else cfg
    data = bytes.fromhex(a.data) if a.data else b""
    for r in dev.command(int(a.cmd, 0), data, content_size=a.size, retries=1):
        print(r[:64].hex(" "))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    s = p.add_subparsers(dest="cmd", required=True)
    s.add_parser("info", help="show interfaces + device info").set_defaults(fn=cmd_info)

    u = s.add_parser("upload", help="upload an image/GIF/APNG/WebP to the screen")
    u.add_argument("image")
    u.add_argument("--fit", choices=["contain", "cover", "stretch"], default="cover")
    u.add_argument("--bg", default="black")
    u.add_argument("--delay", type=int, help="override per-frame delay (ms)")
    u.add_argument("--max-frames", type=int)
    u.add_argument("--preview", help="also save a PNG preview of frame 0")
    u.set_defaults(fn=cmd_upload)

    b = s.add_parser("builtin", help="select a built-in animation")
    b.add_argument("index", type=int)
    b.set_defaults(fn=cmd_builtin)

    s.add_parser("time", help="sync the screen clock").set_defaults(fn=cmd_time)

    st = s.add_parser("stats", help="push live CPU/GPU stats (loop)")
    st.add_argument("--interval", type=float, default=1.0)
    st.add_argument("-v", "--verbose", action="store_true")
    st.set_defaults(fn=cmd_stats)

    hi = s.add_parser("history", help="list / export / restore previous uploads")
    hi.add_argument("action", nargs="?", choices=["list", "export", "restore"], default="list")
    hi.add_argument("n", nargs="?", type=int, default=1, help="entry number from `history` (1 = newest)")
    hi.add_argument("-o", "--out", help="export: output GIF path")
    hi.add_argument("--scale", type=int, default=2, help="export: pixel scale (default 2)")
    hi.set_defaults(fn=cmd_history)

    r = s.add_parser("raw", help="send a raw command (debug)")
    r.add_argument("cmd")
    r.add_argument("data", nargs="?")
    r.add_argument("--size", type=int)
    r.add_argument("--bulk", action="store_true")
    r.set_defaults(fn=cmd_raw)

    a = p.parse_args()
    try:
        a.fn(a)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
