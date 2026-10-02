# Tactile

[Open the BLE interface](https://qwertpas.github.io/tactile/) in Chrome or Edge.
The static page connects directly to both boards through Web Bluetooth. USB is
used for power and firmware upload; no Python server or serial stream is needed.

1. Click **Connect pressures** and choose **Tactile Pressure** (ESP32-S3 SuperMini).
2. Click **Connect vibration** and choose **Tactile Vibration** (XIAO ESP32-S3).
3. Release the sensors and click **Zero pressure**.
4. Click **Start sound** and/or **Start haptics**.

Until the mux is attached, initialization reports an error. Click **Start BLE
test stream** to generate four 500 Hz signals on the actual SuperMini, transmitted
through the same BLE path as hardware samples. The page labels this mode clearly.
After connecting the mux, click **Read sensors**, release them, and zero again.
Keep the XIAO external antenna connected.

## Pressure and outputs

The browser decodes each sample to kPa and subtracts one per-sensor baseline.
These four signed relative pressures are shared by the plot, sound, and haptics.
**Zero pressure** snapshots the latest four readings, updates every output, and
clears plot history. The first complete set of readings establishes an initial
baseline automatically; release the sensors at connection time.

There is no averaging, deadband, envelope smoothing, or pressure normalization.
Every received sample enters the plot history. Sound and haptics use the latest
four values from that same processed stream, independent of animation timing.

- **Plot:** four pressure traces, ten seconds of history, refreshed at display rate.
- **Sound:** independent white-noise voices, linear gain from 0 to 30 kPa. Bands,
  Vowels, Pulses, and Stereo retain the mappings from the original Python interface.
  Web Audio runs 128-frame blocks with an interactive latency request. Audio-device
  buffering adds latency; the browser displays its reported base and output latency.
- **Haptics:** the highest of the four relative pressures maps linearly from
  0–30 kPa to 20–100% constant duty, clamped at the endpoints. At zero pressure,
  enabled haptics still drive 20%; **Stop haptics** drives zero. PWM is 20 kHz,
  with D9/GPIO8 held low and D10/GPIO9 driving the DRV8833.

Commands use BLE writes without response and one pending latest value. Duplicate
motor values are suppressed except for watchdog refresh. Missing pressure updates
for 100 ms, leaving the page, or hiding the tab stops haptics. A separate firmware
watchdog stops the motor after 250 ms without a valid command; BLE disconnect also
stops it. Sound mutes on stale pressure. Re-enable haptics explicitly after a stop.

## Firmware

Both PlatformIO projects default to the `ble` environment, using the existing
board settings and pinned NimBLE-Arduino 2.5.0. The SuperMini has no PSRAM.
Only one process may access a serial port at a time.

```sh
pio run -d sensor -t upload --upload-port /dev/cu.usbmodem1101
pio run -d vibration -t upload --upload-port /dev/cu.usbmodem101
```

These port assignments were identified on this laptop; check `pio device list`
after moving USB cables. SuperMini USB serial ID: E0:72:A1:E9:89:AC;
XIAO: 44:1B:F6:80:3E:6C.

The verified SuperMini connector wiring is GPIO8→3V3, 9→SCL, 10→SDA,
11→RESET, 12→GND. TCA9548A address 0x70, channels 2 and 6, two BMP585s
at 0x46 and 0x47 on each channel. I2C runs at 400 kHz. Sensors retain maximum
continuous P+T conversion, 1× oversampling, IIR bypass, and no FIFO decimation.
Only pressure is transmitted; all fresh pressure samples are retained.

BLE requests a 15 ms connection interval, zero peripheral latency, 251-byte
radio data length, and 2 Mbit PHY. The central decides which parameters it accepts.
Firmware reads FIFOs and sends twice per negotiated interval (about every
7.5 ms when the Mac selects 15 ms), packing independent sensor blocks into one
notification where they fit. This batching avoids BLE queue buildup without
averaging or dropping pressure samples. It adds up to one poll period before
radio transmission. Sample-rate counters and sequence gaps expose transport loss.

Sensor FIFO timestamps mark readout, not conversion. Plot spacing within each
FIFO batch is estimated at 2 ms. Sensor clocks are independent; the latest four
values are a shared snapshot rather than simultaneous conversions.

## Checks and local development

Use global Python 3.11, without a virtual environment.

```sh
npm test
python3.11 ble/check.py --seconds 30
# After connecting the mux:
python3.11 ble/check.py --sensors --seconds 30
# Local app, with real BLE:
python3.11 -m http.server 8765 --bind 127.0.0.1 --directory docs
```

The BLE check connects to both real boards, checks duty endpoints and rejected
commands, watchdog and disconnect stops, missing-mux reporting, 500 Hz synthetic
streaming, sequence gaps, counters, and simultaneous motor commands. Stop browser
connections before running it. `--sensors` checks the actual BMP585 stream instead.

For the browser integration fixture, serve the repository root and open
`/tests/browser.html`, then click **Run browser check**. It uses simulated BLE
devices with the actual application and AudioWorklet, and verifies shared zero,
pressure steps, highest-pressure PWM, all audio modes, stop, and stale input.

Source is in `docs/`; GitHub Pages serves `main:/docs`. No build step or external
web dependencies. Verification logs and captures stay local under `logs/`.

Original serial implementations remain available explicitly:

```sh
pio run -d sensor -e esp32s3_supermini -t upload --upload-port /dev/cu.usbmodem1101
python3.11 sensor/plot.py
pio run -d vibration -e xiao_esp32s3 -t upload --upload-port /dev/cu.usbmodem101
python3.11 vibration/gui.py
```

Their wiring and historical checks are in [sensor/README.md](sensor/README.md)
and [vibration/README.md](vibration/README.md). They require uploading their serial
firmware first.

References: [Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth),
[NimBLE server API](https://h2zero.github.io/NimBLE-Arduino/class_nim_b_l_e_server.html),
[Apple connection parameters](https://developer.apple.com/library/archive/qa/qa1931/_index.html),
[BMP585 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp585-ds003.pdf).
