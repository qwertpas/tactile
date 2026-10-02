# Four BMP585 sensors

This document describes the original **serial firmware**. The project now defaults
to BLE; see [the combined BLE interface](../README.md). Use the explicit serial
environment below before running these Python tools.

ESP32-S3 SuperMini firmware and a pyqtgraph USB plotter. The verified connector is reversed relative to the initial description:

| GPIO | Signal |
| --- | --- |
| 8 | 3V3, driven high |
| 9 | SCL |
| 10 | SDA |
| 11 | RESET, open drain, released high |
| 12 | GND, driven low |

The TCA9548A is at 0x70. Channels 2 and 6 each contain BMP585 devices at 0x46 and 0x47. All four returned chip ID 0x51 and revision 0x32.

## Run

```sh
cd /Users/chris/Code/tactile/sensor
pio run -e esp32s3_supermini -t upload --upload-port /dev/cu.usbmodem101
python3.11 plot.py
```

Close the plotter before uploading, monitoring, or running another acquisition process. Only one process may use the USB port. The plotter detects a single Espressif USB device; use `--port /dev/cu.usbmodem101` to select explicitly.

Use the global Python 3.11 and its existing PyQt6 installation. Dependencies are already available on this laptop. If needed, run `python3.11 -m pip install -r requirements.txt`; no virtual environment is used.

The window displays four pressure traces and four temperature traces over the latest ten seconds. **Zero pressure** subtracts each sensor's recent mean; **Relative pressure** switches between absolute and relative pressure. Samples are acquired at full rate while plots refresh at 30 Hz.

Verify acquisition without a GUI, or record every sample:

```sh
python3.11 plot.py --check 30 --csv logs/capture.csv
python3.11 plot.py --csv capture.csv
```

The hardware check requires all four sensors to run between 450 and 520 Hz, with no I2C errors, FIFO-full events, queue drops, sequence gaps, or invalid packets. The broad rate bounds allow native sensor oscillator variation; the measured rate is printed separately for every sensor.

Verified on October 1, 2026: a 30-second run captured 59,382 fresh P+T samples, with all fault counters zero. A subsequent 10-second run also passed. Rates from the 30-second run:

| Sensor | Measured rate |
| --- | --- |
| CH2 / 0x46 | 493.66 Hz |
| CH2 / 0x47 | 497.81 Hz |
| CH6 / 0x46 | 498.15 Hz |
| CH6 / 0x47 | 492.47 Hz |

Results are in `logs/acquisition.txt`, `logs/restart.txt`, and `logs/capture.csv`. The live window and Zero pressure control were verified through Computer Use; `logs/plot.png` shows all eight traces and zero fault counters.

## Acquisition

The firmware uses the board, flash, PSRAM, USB flags, and debug settings from `../../flywheeljumper/main/firmware/esp32s3supermini/platformio.ini`, omitting unrelated libraries.

Sensors run in continuous mode, with pressure and temperature enabled, 1× oversampling, IIR bypass, and no FIFO decimation. This is the maximum native continuous rate; Bosch quotes up to 480 Hz. I2C runs at the TCA9548A's rated maximum, 400 kHz. Each sensor has a 16-frame P+T FIFO, drained in batches. A separate USB task prevents USB writes from blocking I2C acquisition.

Each FIFO frame is a fresh conversion. The stream does not repeat the latest register reading to create a higher apparent rate. Sensors have independent clocks and are not synchronized. The sensor FIFO contains no sample timestamps: firmware timestamps FIFO readout, and plots estimate sample spacing inside each batch at nominal 480 Hz. CSV records the exact FIFO readout timestamp for each batch; it is not an exact conversion timestamp.

A filled FIFO is flagged conservatively as possible data loss; the sensor does not report the exact number of overwritten frames. Queue drops and USB sequence gaps are counted explicitly. I2C errors and CRC failures are also visible in the plot status.

## USB protocol

Send ASCII `s` to configure and start; `x` stops acquisition and puts sensors in standby. Configuration diagnostics begin with `#` and precede binary packets. Baud setting is 115200, but native USB throughput is independent of this value.

Packets are little endian:

| Bytes | Field |
| --- | --- |
| 0–3 | `BMP1` |
| 4–5 | Total packet length, 36 + 6 × frame count |
| 6 | Sensor index: CH2/0x46, CH2/0x47, CH6/0x46, CH6/0x47 |
| 7 | Frame count, 1–16 |
| 8–11 | First sample sequence number for this sensor |
| 12–19 | FIFO readout timestamp, microseconds since ESP32 boot |
| 20–23 | Cumulative sensor I2C errors |
| 24–27 | Cumulative FIFO-full observations |
| 28–31 | Cumulative USB queue dropped samples |
| 32 onward | FIFO frames: signed 24-bit temperature / 65536 °C, then unsigned 24-bit pressure / 64 Pa (matching Bosch SensorAPI) |
| Last 4 | Standard CRC32 over all preceding bytes |

## Bring-up finding

The original power orientation was incorrect. With the reverse orientation, address-only probes still reported NACKs with the installed Arduino/ESP-IDF driver. Actual mux control writes and reads succeeded, and selecting channels 2 and 6 exposed all four sensors. Firmware uses actual transactions rather than address-only probes. The earlier scan logs are superseded by `logs/mux_transactions.txt` and the acquisition verification log.

References: [BMP585 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp585-ds003.pdf), [Bosch SensorAPI](https://github.com/boschsensortec/BMP5_SensorAPI/blob/master/bmp5.c), [TCA9548A datasheet](https://www.ti.com/lit/ds/symlink/tca9548a.pdf).

## Sound

The plotter plays pressure-controlled white noise through the default laptop audio output, at 48 kHz stereo. Release all sensors during the first second: it automatically measures a baseline. **Zero pressure** recalibrates both sound and the relative plot. Sound uses positive pressure above this baseline, with no deadband or pressure smoothing.

Sensor order is CH2/0x46, CH2/0x47, CH6/0x46, CH6/0x47. Each sensor independently controls its voice amplitude, linearly from silence at 0 kPa to full amplitude at **Full-scale pressure** (30 kPa by default), above the zeroed baseline. Values above full scale are capped. There is no normalization of total pressure or early gain compression. Lower full scale for lighter touches. **Volume** controls output level; **Sound** mutes it. Audio mutes when pressure updates stop for 0.5 seconds.

| Mapping | Four sensor roles | What to listen for |
| --- | --- | --- |
| Bands | Resonant noise at 220, 660, 1980, 5940 Hz | Relative strength of four distinct pitches |
| Vowels | Noise formants for ah, ee, oh, oo | Blended vowel color |
| Pulses | Pitched noise pulsing at 2, 3, 5, 7 Hz | Relative prominence of four rhythms |
| Stereo | Low left, low right, high left, high right | Position and pitch; clearest with headphones |

Each sensor retains an independent voice, so mixtures preserve proportion information. The mappings use filtered white noise rather than pure sine tones. Output is limited; pressure gains and mode changes apply immediately on the next audio block. Sample recordings in `logs/sound_*.wav` play each sensor separately in order, with a short gap.

Each audio callback reads the latest pressure snapshot directly from the serial reader, independently of the GUI timers, without averaging or envelope smoothing. Audio uses 128-frame blocks and requests low device latency.

Audio verification: spectral peaks matched the four Bands pitches; Stereo isolated the intended channel by over 20× RMS; release faded to silence; all samples were finite and bounded. Rendering over 32 seconds of sound took 1.43 seconds. Native speaker playback exercised all four modes without audio status errors.
