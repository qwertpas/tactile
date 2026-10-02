# Vibration motor

This document describes the original **serial firmware**. The project now defaults
to BLE; see [the combined BLE interface](../README.md). Use the explicit serial
environment below before running these Python tools.

Seeed Studio XIAO ESP32-S3 firmware and a Qt GUI using the global Python 3.11
and its existing PyQt6 installation.

| XIAO | GPIO | DRV8833 module |
| --- | --- | --- |
| D9 | 8 | IN4, held low |
| D10 | 9 | IN3, PWM |
| GND | — | GND, common with motor supply |
| — | — | Motor across OUT3 and OUT4 |

Power the driver VM from a supply appropriate for the motor's rated voltage.
The DRV8833 accepts 2.7–10.8 V, but that does not establish the motor's rating.
Enable the module's SLEEP input if it is exposed and not already pulled high.
PWM pulses have the full supply voltage; amplitude controls duty cycle.

## Run

From `/Users/chris/Code/tactile`:

```sh
pio run -d vibration -t upload --upload-port /dev/cu.usbmodem101
python3.11 vibration/gui.py
```

Click **Connect**, choose the waveform and amplitude, then **Start**. Changes apply
live while dragging, with a precise 5 ms timer (200 Hz target) sending the latest
changed values. **Stop** or **Space** turns the motor off. Disconnecting or closing the GUI
also sends Stop. The firmware stops after two seconds without a heartbeat and
starts with both motor inputs low. Reconnecting never starts the motor.

Dependencies are in `requirements.txt`; if needed, install globally with
`python3.11 -m pip install -r vibration/requirements.txt`. No venv is used.

## Waveforms

Amplitude is 0–100% peak PWM duty. Frequency is 0–500 Hz, adjustable by slider or
numeric entry. Constant ignores frequency. At 0 Hz, every waveform holds the
selected amplitude. At 0% amplitude, every waveform produces zero drive.

- Constant: steady duty at the selected amplitude.
- Square: equal on/off intervals between zero and the selected amplitude.
- Sine: `amplitude × (1 − cos(2π × frequency × time)) / 2`.

The ESP32 generates the envelope at 10 kHz using a hardware-timed ESP timer;
LEDC produces a 20 kHz, 10-bit PWM carrier. Native USB sends settings and a
heartbeat every 400 ms. Timing uses elapsed board time so scheduling jitter
does not accumulate phase drift. Live amplitude/frequency changes preserve
waveform phase instead of restarting each cycle. The motor runs in one direction with coast
between PWM pulses, following the DRV8833 fast-decay control mode.

The preview shows requested duty, not measured motor motion. A rotating
vibration motor has inertia and its own rotation frequency; it cannot reproduce
arbitrary mechanical sine/square vibrations up to 500 Hz. This project controls
the electrical drive envelope. Low duty may not overcome the motor's starting
friction. No motor-current, driver-fault or acceleration sensing is connected.

## Verify

Close or disconnect the GUI first. The check drives brief sequences at up to 20%:

```sh
python3.11 vibration/check.py --port /dev/cu.usbmodem101
```

It checks reported duty extrema, timer update rate, every waveform at 0, 0.5,
10, 100 and 500 Hz, amplitude changes, invalid commands, Stop and heartbeat
expiry. Status counters describe firmware output requests; they do not measure
GPIO voltage or physical motor response. Use an oscilloscope or accelerometer
for those measurements.

Verified October 1, 2026: build and USB upload passed; all hardware-check cases
passed at approximately 10,000 updates/s. Continuous Qt slider changes sent
193 USB settings updates/s; Stop cancelled pending updates. Rapid settings
also preserved a 5 Hz sine through its full duty range. Results are in
`logs/check.txt` and `logs/live_gui.txt`. The dark Qt GUI was verified on
screen; `logs/gui.png` captures its square-wave preview and connected status.

## USB protocol

115200 baud, newline-terminated ASCII commands:

```text
SET square 20 10 1
SET sine 20 500 1
SET constant 20 0 1
STOP
PING
STATUS
```

SET fields are waveform, amplitude percent, frequency Hz and running (0 or 1).
SET and PING renew the heartbeat. STATUS does not. Commands return a JSON status
line with device ID `vibration-v1`, settings, running state, duty, duty extrema,
sample count and maximum timer gap. Invalid commands return `ERR ...`.

References: [XIAO pin mapping](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/),
[DRV8833 datasheet](https://www.ti.com/lit/ds/symlink/drv8833.pdf),
[LEDC API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html).
