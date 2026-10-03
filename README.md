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
These four signed relative pressures are shared by the heatmap, plot, sound, and haptics.
**Zero pressure** snapshots the latest four readings, updates every output, and
clears plot history. Switching streams discards packets from the previous stream
using a firmware generation tag, so queued test data cannot affect real outputs. The first complete set of readings establishes an initial
baseline automatically; release the sensors at connection time.

There is no averaging, deadband, envelope smoothing, or pressure normalization.
Every received sample enters the plot history. Sound and haptics use the latest
four values from that same processed stream, independent of animation timing.

- **Plot:** four pressure traces, ten seconds of history, refreshed at display rate.
- **Heatmap:** CH2 on the top row, CH6 below; 0x46 left and 0x47 right. Color maps
  directly from 0–30 kPa, without spatial interpolation or pressure smoothing.
- **Sound:** four voices, linear gain from 0 to 30 kPa. Vowels sustains ah/ee/oh/oo
  by repeating a steady vocal cycle synthesized from human recordings, without
  syllable envelopes or gaps; [recordings and credits](docs/vowels/index.html).
  Pure tones sustains four sine waves at 220, 660, 1980, and 5940 Hz.
  Bands, Pulses, and Stereo use filtered noise.
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

For bus diagnostics, stop acquisition and send `?` over the SuperMini USB serial
port. This resets the mux, checks addresses 0x70–0x77 and sensor IDs on channels
2 and 6 at 100 and 400 kHz, then restores 400 kHz. Run one serial process at a time.
For connector measurements, `C`, `A`, and `R` stop acquisition and hold SCL,
SDA, or RESET low, respectively. Measure against connector GND. `H` releases
the signals and restores I2C; acquisition stays stopped until started again.

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

## Verified October 2, 2026

Both BLE firmwares were flashed and verified on the USB-connected boards. A
30-second integration check delivered 60,116 synthetic pressure samples at
499.0 Hz per channel, with zero gaps, errors, FIFO-full events, or firmware drops.
It sent new motor values at 69.7 Hz and verified endpoint duties, invalid-command
rejection, watchdog stop, disconnect stop, and reconnection. The maximum time since
the oldest sensor notification was received was 42.8 ms; this is not a measurement
of sensor-to-motor latency.

Chrome subsequently ran both real BLE connections at 15 ms intervals, with over
180,000 test samples and zero reported gaps or faults. Shared zeroing, laptop noise
playback, haptics, and Stop were exercised together. Audio reported 5.3 ms base plus
32 ms output latency. Browser fixture checks covered all sound modes, common zero,
step response, stale input, and rejection of late packets from previous streams.

After the user repaired a bad connection, all four BMP585 sensors returned the
correct chip IDs. A 30-second real-sensor check delivered 59,652 samples at
492.2–498.1 Hz per channel, with zero gaps, I2C errors, FIFO-full events, or drops.
Both BLE links used 15 ms intervals. Motor duty endpoints, watchdog stop,
disconnect stop, and reconnection passed. Physical motor amplitude was not measured.
The published page then received 277,689 real samples with zero gaps or faults.
Shared zeroing, AudioWorklet playback, pressure-dependent motor duty, and Stop
were exercised together. Browser intervals were 15 ms for pressure and 30 ms
for vibration; audio reported 5.3 ms base plus 32 ms output latency.
A ten-second native repeat reported 559 BLE samples dropped without I2C errors.
The final 30-second reconnect check passed with 59,738 real samples, zero gaps,
errors, FIFO-full events, or drops, and both links at 15 ms. Both service UUIDs
were visible after disconnecting.

The broken connection previously caused I2C failures and an invalid all-high
pressure word. BLE status identifies initialization failures and reports GPIO8–12
pin levels. The page rejects invalid pressure words and stops haptics. The browser
fixture passed with the invalid word injected while haptics were active: the motor
stopped and the shared pressure stayed unchanged.
