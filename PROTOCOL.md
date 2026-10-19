# AJAZZ / Epomaker AK820 Pro — TFT screen protocol

Recovered from the vendor's WebHID driver (`ajazz.driveall.cn`, bundle
`layout-classic-*.js`, module exporting `setTftUserAnimation` & friends).
Cross-check target: `AJAZZ_AK820 Pro_三模_0.85英寸彩屏_RGB_V1.0.0.5.exe`.

## Device

| | |
|---|---|
| VID | `0x0C45` (3141) |
| PID | `0x800A` (32778, "820PRO") — also `0x8009` (32777) on older AK820 |
| Screen | 128 × 128, RGB565 |
| Transport | **USB cable only.** The 2.4 GHz dongle (`0C45:FEFE`) and BT can't reach the TFT |

Two vendor-defined HID interfaces are used:

| Role | Usage page | Output report | Used for |
|---|---|---|---|
| **config** | one of `FF68 FF80 FF60 FF00 FF01 FF1B` | 32 bytes | device info, clock, live stats |
| **bulk**   | `FF67` (65383) | ~4104 bytes | animation upload, built-in index |

All reports use report ID 0.

## Packet format

Host → device (`kX`/`AX` in the bundle):

```
[0] 0xAA                magic
[1] cmd
[2] len                 payload bytes in this packet
[3] addr  lo            byte offset of this chunk in the full payload
[4] addr  hi
[5] 0
[6] last-packet flag    1 on the final chunk
[7] 0
[8..] payload           (report_size - 8) bytes per packet
```

Device → host: `[0]=0x55 [1]=cmd [2]=len/type [3..4]=addr [8..]=data`.
Host waits for a reply with matching cmd (500 ms default, 3 retries).

Checksum helper in the bundle is CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021); used by OTA, not the screen.

## Commands (subset)

| cmd | name | iface |
|---|---|---|
| `0x10` | GET_DEVICE_INFO (48 bytes, 2 chunks) | config |
| `0x34` | SET_TEMPORARY_COMMAND_DATA (clock / stats) | config |
| `0x50` | SET_TFT_USER_ANIMATION | bulk |
| `0x51` | SET_TFT_BUILT_IN_INDEX | bulk |
| `0x41` | (reply cmd the host waits for after each `0x50` chunk) | bulk |

### GET_DEVICE_INFO reply (48 bytes, concatenated `data` of both chunks)

| off | field |
|---|---|
| 4–5 / 6–7 | vid / pid |
| 8–9 | firmware version (BCD-ish: `(b8&15)+(b8>>4)*10+b9*100` / 100) |
| 16 | workMode · 17 batteryLevel · 18 chargeStatus · 19 currentProfile |
| 22–23 | **tftMaxFrames** |
| 28 | tftDirection (`0xFF` = no screen) |
| 30 | frameVersion (1 → firmware wants 2 s timeouts) |

### Upload animation — `0x50` on bulk iface

Payload = 256-byte header + frames.

```
header (0xFF-filled, 256 bytes)
  [0]       frame count N
  [1..N-1]  delay of frame 0..N-2, units of 2 ms   (vendor: gif_centiseconds * 5)
  [N]       0
frames      N × 128×128 pixels, row-major, RGB565 **little-endian** (low byte first)
```

Chunked into `report_size - 8` bytes. Each packet uses a *custom* 8-byte header:

```
AA 50 idx_lo idx_hi total_lo total_hi 50 06  <chunk, zero-padded>
```

then waits ≤ 2 s for a `55 41 …` reply.

### Built-in animation — `0x51` on bulk iface
Standard header, `len=1`, payload `[index]`. No reply expected.

### Clock — `0x34` on config iface
Payload (24 bytes, rest zero): `5A 01 5A YY MM DD hh mm ss wd` (YY = year % 100, wd 0 = Sunday).

### Live stats — `0x34` on config iface
24-byte payload, zero except:

| off | value |
|---|---|
| 6 | `0x5A` |
| 12 | CPU % (0–100) |
| 13 | CPU °C (int8) |
| 14 | GPU % |
| 15 | GPU °C (int8) |
| 16/17/18 | weather now / max / min °C (int8) |
| 19 | weather code 0–23 |
| 20 | humidity % |

Note: the vendor only enables the stats page (`isShowTftInfo`) for some models;
the AK820 Pro config doesn't set it, so this may be ignored by its firmware.
