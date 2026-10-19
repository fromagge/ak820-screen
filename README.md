# ak820-screen

Put any GIF, image, video or text on the **AJAZZ / Epomaker AK820 Pro** keyboard's 0.85" screen,
with no vendor driver, on Linux, macOS or Windows.

**▶ Use it in your browser: https://fromagge.github.io/ak820-screen/**
(Chrome, Edge, Brave or Opera on desktop. Nothing to install.)

- **Animations** made from scratch, all seamless loops: Rainbow (6 patterns), Plasma, Matrix, Warp, Fire, Snow, Hearts, Bounce, Ripples, Equalizer, plus a 🎲 Surprise me button
- Drop in a GIF / PNG / JPG / WebP / APNG / MP4 / WebM
- **Text**: static, scroll, wave, typewriter or blink, in solid or rainbow colours, multi-line, auto-fit
- **Draw** directly at 128×128, including a rainbow brush
- **Effects** on anything: rainbow colour cycle / wash / border, spin, shake, zoom pulse, glow pulse, glitch, sparkles, CRT lines, vignette, poster, black & white, sepia, invert, hue shift, pixelate, captions. Effects turn a still image into a loop
- Fill / fit / stretch, zoom, pan, rotate, mirror, brightness, contrast, saturation
- Change speed, trim frames, drop every Nth frame to fit the keyboard's ~140-frame limit
- Sync the screen clock, switch to built-in animations
- **History**: every send is saved in your browser, so you can see what's on the keyboard, what was there before, and put it back

Unofficial; not affiliated with AJAZZ or Epomaker. The protocol was recovered from the vendor's own
web driver. See [PROTOCOL.md](PROTOCOL.md).

> The screen is only reachable over the **USB-C cable with the keyboard in wired mode**.
> The 2.4 GHz dongle and Bluetooth can't do it.

## Linux setup (once)

Browsers and the CLI need permission to open the keyboard:

```sh
sudo cp 99-ak820.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger
```
then unplug and replug the keyboard. macOS and Windows need nothing.

## CLI

Python 3 + Pillow. Also handy for scripting (e.g. a live CPU/GPU monitor).

```sh
./ak820.py info                       # interfaces, firmware, max frames
./ak820.py upload cat.gif             # GIF / PNG / JPG / WebP / APNG
./ak820.py upload pic.png --fit contain --bg '#202020'
./ak820.py upload loop.gif --delay 60 # force 60 ms per frame
./ak820.py time                       # sync clock
./ak820.py builtin 0                  # vendor built-in animation
./ak820.py stats -v                   # push CPU/GPU %/°C (if the firmware shows it)
./ak820.py history                    # list everything you've sent (1 = newest)
./ak820.py history export 2 -o old.gif  # turn a past upload back into a GIF
./ak820.py history restore 2          # put it back on the keyboard
./ak820.py raw 0x10 --size 48         # debug: send any command
```

The keyboard can't send its picture back (no such command exists), so both the site and the CLI
keep their own copy of each upload: the site in browser storage, the CLI in `~/.local/share/ak820/history/`.

## Run the site locally

```sh
cd web && python3 -m http.server 8820   # → http://localhost:8820
```

`web/ak820.js` is a standalone ES module (`Keyboard.request()`, `.upload(frames)`, `.syncClock()`, …)
if you want to build your own tool on top.

## Tested

| Keyboard | USB ID | Firmware | Result |
|---|---|---|---|
| Epomaker × AJAZZ AK820 Pro | `0C45:800A` | 1.16 | upload ✓, info ✓ |

Got another model with a screen working (or not)? Please open an issue with the output of
`./ak820.py info`.
