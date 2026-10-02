#!/usr/bin/env python3.11
"""Read BMP585 FIFO packets over native USB; plot or verify acquisition."""
import argparse
import csv
import queue
import struct
import threading
import time
import zlib
from collections import deque

import numpy as np
import serial
from serial.tools import list_ports

HEADER = struct.Struct('<4sHBBIQIII')
LABELS = ['CH2 · 0x46', 'CH2 · 0x47', 'CH6 · 0x46', 'CH6 · 0x47']


class Parser:
    def __init__(self):
        self.buffer = bytearray()
        self.bad = 0

    def feed(self, data):
        self.buffer.extend(data)
        while len(self.buffer) >= HEADER.size:
            start = self.buffer.find(b'BMP1')
            if start < 0:
                del self.buffer[:-3]
                return
            del self.buffer[:start]
            if len(self.buffer) < HEADER.size:
                return
            _, size, sensor, count, first, stamp, errors, full, dropped = HEADER.unpack_from(self.buffer)
            if sensor > 3 or not 1 <= count <= 16 or size != HEADER.size + count * 6 + 4:
                self.bad += 1
                del self.buffer[0]
                continue
            if len(self.buffer) < size:
                return
            frame = bytes(self.buffer[:size])
            if zlib.crc32(frame[:-4]) != struct.unpack_from('<I', frame, size - 4)[0]:
                self.bad += 1
                del self.buffer[0]
                continue
            del self.buffer[:size]
            raw = np.frombuffer(frame[HEADER.size:-4], dtype=np.uint8).reshape(count, 2, 3).astype(np.int32)
            raw = raw[:, :, 0] | raw[:, :, 1] << 8 | raw[:, :, 2] << 16
            # Bosch SensorAPI uses signed temperature and unsigned pressure.
            temperature = ((raw[:, 0] ^ 0x800000) - 0x800000) / 65536.0
            pressure = raw[:, 1] / 64.0
            yield sensor, first, stamp / 1e6, temperature, pressure, errors, full, dropped


def find_port():
    ports = [p.device for p in list_ports.comports() if p.vid == 0x303A]
    if len(ports) != 1:
        raise RuntimeError(f'Expected one ESP32 USB device, found {ports}; specify --port')
    return ports[0]


class Stream:
    def __init__(self, port, csv_path=None):
        self.port = port
        self.csv_path = csv_path
        self.stop = threading.Event()
        self.messages = queue.Queue(2048)
        self.parser = Parser()
        self.latest = (np.zeros(4), 0.)
        self.thread = threading.Thread(target=self.read, daemon=True)

    def read(self):
        output = None
        try:
            if self.csv_path:
                output = open(self.csv_path, 'w', newline='')
                writer = csv.writer(output)
                writer.writerow(['sensor', 'sample', 'fifo_read_time_s', 'temperature_C', 'pressure_Pa'])
            with serial.Serial(self.port, 115200, timeout=0.1, exclusive=True) as port:
                port.reset_input_buffer()
                port.write(b's')
                port.flush()
                last = time.monotonic()
                startup = bytearray()
                started = False
                try:
                    while not self.stop.is_set():
                        data = port.read(port.in_waiting or 1)
                        if not started:
                            startup.extend(data)
                            if b'# ERROR' in startup:
                                raise RuntimeError(startup.decode(errors='replace').strip())
                        for packet in self.parser.feed(data):
                            started = True
                            last = time.monotonic()
                            pressure = self.latest[0].copy()
                            pressure[packet[0]] = packet[4][-1]
                            self.latest = (pressure, last)
                            if output:
                                sensor, first, stamp, temperature, pressure, *_ = packet
                                writer.writerows((sensor, first + i, stamp, t, p)
                                                 for i, (t, p) in enumerate(zip(temperature, pressure)))
                            self.messages.put_nowait(packet)
                        if time.monotonic() - last > 3:
                            detail = startup[:1024].decode(errors='replace').strip() if not started else ''
                            raise RuntimeError(f'No sensor data for 3 seconds. {detail}')
                finally:
                    port.write(b'x')
                    port.flush()
        except Exception as error:
            # Keep failures visible even if the consumer has stopped draining.
            try:
                self.messages.put_nowait(str(error))
            except queue.Full:
                self.error = str(error)
        finally:
            if output:
                output.close()

    def close(self):
        self.stop.set()
        self.thread.join(2)


class Stats:
    def __init__(self):
        self.first = [None] * 4
        self.last = [None] * 4
        self.next = [None] * 4
        self.total = [0] * 4
        self.missing = [0] * 4
        self.errors = [0] * 4
        self.full = [0] * 4
        self.dropped = [0] * 4
        self.pressure = [deque(maxlen=4800) for _ in range(4)]
        self.temperature = [deque(maxlen=4800) for _ in range(4)]
        self.times = [deque(maxlen=4800) for _ in range(4)]

    def add(self, packet):
        sensor, first, stamp, temperature, pressure, errors, full, dropped = packet
        if self.next[sensor] is not None:
            gap = (first - self.next[sensor]) & 0xffffffff
            if gap > 0x7fffffff:
                raise RuntimeError('Device sample sequence restarted; restart the plotter')
            self.missing[sensor] += gap
        self.next[sensor] = (first + len(pressure)) & 0xffffffff
        if self.first[sensor] is None:
            self.first[sensor] = first, stamp
        self.last[sensor] = first, stamp
        self.total[sensor] += len(pressure)
        self.errors[sensor], self.full[sensor], self.dropped[sensor] = errors, full, dropped
        self.pressure[sensor].extend(pressure)
        self.temperature[sensor].extend(temperature)
        # FIFO has no sample timestamps; estimate within each batch at nominal 480 Hz.
        self.times[sensor].extend(stamp - np.arange(len(pressure) - 1, -1, -1) / 480.0)

    def rates(self):
        rates = []
        for first, last in zip(self.first, self.last):
            rates.append((last[0] - first[0]) / (last[1] - first[1])
                         if first and last[1] > first[1] else 0.0)
        return rates


def check(stream, seconds):
    stats = Stats()
    stream.thread.start()
    end = time.monotonic() + seconds
    try:
        while time.monotonic() < end:
            try:
                packet = stream.messages.get(timeout=0.2)
            except queue.Empty:
                if not stream.thread.is_alive():
                    raise RuntimeError(getattr(stream, 'error', 'Reader stopped'))
                continue
            if isinstance(packet, str):
                raise RuntimeError(packet)
            stats.add(packet)
    finally:
        stream.close()
    for i, label in enumerate(LABELS):
        print(f'{label}: {stats.total[i]} samples, {stats.rates()[i]:.2f} Hz, '
              f'I2C errors={stats.errors[i]}, FIFO full={stats.full[i]}, '
              f'queue dropped={stats.dropped[i]}, sequence gaps={stats.missing[i]}, '
              f'P={np.mean(stats.pressure[i]):.2f} Pa, T={np.mean(stats.temperature[i]):.2f} C')
    print(f'Invalid packets: {stream.parser.bad}')
    if (any(rate < 450 or rate > 520 for rate in stats.rates()) or stream.parser.bad
            or any(stats.errors + stats.full + stats.dropped + stats.missing)):
        raise RuntimeError('Acquisition verification failed')


def plot(stream):
    from PyQt6 import QtCore, QtWidgets
    import pyqtgraph as pg
    from sound import Sound, MODES

    app = pg.mkQApp('BMP585')
    pg.setConfigOptions(antialias=False)
    stats = Stats()
    baseline = np.zeros(4)

    def read_pressure():
        pressure, stamp = stream.latest
        return pressure - baseline, stamp

    sound = Sound(read_pressure)

    class Window(QtWidgets.QWidget):
        def closeEvent(self, event):
            sound.close()
            stream.close()
            event.accept()

    window = Window()
    window.setWindowTitle('BMP585 — four sensors')
    window.resize(1150, 760)
    layout = QtWidgets.QVBoxLayout(window)
    controls = QtWidgets.QHBoxLayout()
    relative = QtWidgets.QCheckBox('Relative pressure')
    zero = QtWidgets.QPushButton('Zero pressure')
    controls.addWidget(relative)
    controls.addWidget(zero)
    controls.addStretch()
    layout.addLayout(controls)
    audio = QtWidgets.QHBoxLayout()
    enabled = QtWidgets.QCheckBox('Sound')
    enabled.setChecked(True)
    mode = QtWidgets.QComboBox()
    mode.addItems(MODES)
    volume = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
    volume.setRange(0, 100)
    volume.setValue(25)
    volume.setMaximumWidth(150)
    scale = QtWidgets.QDoubleSpinBox()
    scale.setRange(0.1, 100)
    scale.setValue(30)
    scale.setSuffix(' kPa')
    for widget in (enabled, mode, QtWidgets.QLabel('Volume'), volume,
                   QtWidgets.QLabel('Full-scale pressure'), scale):
        audio.addWidget(widget)
    audio.addStretch()
    layout.addLayout(audio)
    description = QtWidgets.QLabel(MODES[mode.currentText()])
    mode.currentTextChanged.connect(lambda name: description.setText(MODES[name]))
    layout.addWidget(description)
    proportions = QtWidgets.QLabel('Release sensors while the baseline is measured…')
    layout.addWidget(proportions)
    graphs = pg.GraphicsLayoutWidget()
    layout.addWidget(graphs)
    pressure = graphs.addPlot(row=0, col=0)
    temperature = graphs.addPlot(row=1, col=0)
    pressure.setLabel('left', 'Pressure', units='Pa')
    temperature.setLabel('left', 'Temperature', units='°C')
    temperature.setLabel('bottom', 'Time', units='s')
    temperature.setXLink(pressure)
    for graph in (pressure, temperature):
        graph.showGrid(x=True, y=True, alpha=0.2)
        graph.addLegend()
    colors = ['#38bdf8', '#fbbf24', '#f472b6', '#4ade80']
    curves = [[graph.plot(pen=pg.mkPen(color, width=1.5), name=label)
               for color, label in zip(colors, LABELS)] for graph in (pressure, temperature)]
    status = QtWidgets.QLabel('Starting sensors…')
    layout.addWidget(status)
    origin = None
    last = time.monotonic()
    calibrated = False

    def set_zero():
        nonlocal calibrated
        for i in range(4):
            if stats.pressure[i]:
                baseline[i] = np.mean(list(stats.pressure[i])[-480:])
        relative.setChecked(True)
        calibrated = True

    zero.clicked.connect(set_zero)

    def receive():
        nonlocal origin, last
        try:
            while True:
                try:
                    packet = stream.messages.get_nowait()
                except queue.Empty:
                    break
                if isinstance(packet, str):
                    raise RuntimeError(packet)
                stats.add(packet)
                last = time.monotonic()
                if origin is None:
                    origin = packet[2]
            if hasattr(stream, 'error'):
                raise RuntimeError(stream.error)
            if not calibrated and all(len(values) >= 480 for values in stats.pressure):
                set_zero()
            if calibrated:
                readings = np.array([values[-1] for values in stats.pressure]) - baseline
                sound.set(mode.currentIndex(), volume.value() / 100,
                          scale.value() * 1000, enabled.isChecked())
                positive = np.maximum(readings, 0)
                fractions = positive / positive.sum() if positive.sum() else np.zeros(4)
                proportions.setText('Pressure proportions: ' + ' / '.join(f'{p:.0%}' for p in fractions)
                                    + f'    Audio underruns: {sound.errors}')
            if time.monotonic() - last > 3:
                raise RuntimeError('Sensor stream stalled')
        except Exception as error:
            status.setText(f'ERROR: {error}')
            status.setStyleSheet('color: #ef4444')
            receiver.stop()
            timer.stop()
            sound.close()
            stream.close()

    def update():
        for i in range(4):
            if not stats.times[i]:
                continue
            x = np.array(stats.times[i]) - origin
            y = np.array(stats.pressure[i]) - (baseline[i] if relative.isChecked() else 0)
            curves[0][i].setData(x, y)
            curves[1][i].setData(x, np.array(stats.temperature[i]))
        if origin is not None:
            now = max(times[-1] for times in stats.times if times) - origin
            pressure.setXRange(max(0, now - 10), max(10, now), padding=0)
            rates = '  |  '.join(f'{LABELS[i]}: {rate:.1f} Hz' for i, rate in enumerate(stats.rates()))
            faults = sum(stats.errors + stats.full + stats.dropped + stats.missing) + stream.parser.bad
            status.setText(f'{rates}    Errors/full/drops/gaps/CRC: {faults}')
            status.setStyleSheet('color: #ef4444' if faults else '')

    receiver = QtCore.QTimer()
    receiver.setTimerType(QtCore.Qt.TimerType.PreciseTimer)
    receiver.timeout.connect(receive)
    receiver.start(5)
    timer = QtCore.QTimer()
    timer.timeout.connect(update)
    timer.start(33)
    window.show()
    sound.start()
    stream.thread.start()
    app.exec()
    sound.close()
    stream.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', help='ESP32 USB serial device (auto-detected if omitted)')
    parser.add_argument('--check', type=float, metavar='SECONDS', help='Verify hardware without opening plots')
    parser.add_argument('--csv', help='Save every pressure/temperature sample to CSV')
    args = parser.parse_args()
    stream = Stream(args.port or find_port(), args.csv)
    if args.check:
        check(stream, args.check)
    else:
        plot(stream)


if __name__ == '__main__':
    main()
