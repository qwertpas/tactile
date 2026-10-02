#!/usr/bin/env python3.11
"""USB control of the XIAO vibration firmware."""
import argparse
import json
import sys
import time

from PyQt6 import QtCore, QtGui, QtWidgets as Qt
import numpy as np
import pyqtgraph as pg
import serial
from serial.tools import list_ports


class Window(Qt.QWidget):
    def __init__(self, port=None):
        super().__init__()
        self.setWindowTitle('Vibration motor')
        self.resize(780, 530)
        self.serial = None
        self.buffer = bytearray()
        self.ready = self.running = False
        self.dirty = False
        self.last_reply = self.last_ping = 0
        layout = Qt.QVBoxLayout(self)
        connection = Qt.QHBoxLayout()
        self.ports = Qt.QComboBox()
        self.ports.setMinimumWidth(280)
        self.refresh = Qt.QPushButton('Refresh ports')
        self.connect = Qt.QPushButton('Connect')
        connection.addWidget(self.ports, 1)
        connection.addWidget(self.refresh)
        connection.addWidget(self.connect)
        layout.addLayout(connection)
        controls = Qt.QGroupBox('Motor drive')
        form = Qt.QFormLayout(controls)
        form.setFieldGrowthPolicy(Qt.QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        self.wave = Qt.QComboBox()
        self.wave.addItems(['Constant', 'Square', 'Sine'])
        form.addRow('Waveform', self.wave)
        self.amplitude, amplitude_row = self.control(100, 1, '%', 20)
        self.frequency, frequency_row = self.control(500, 2, ' Hz', 10)
        form.addRow('Amplitude', amplitude_row)
        form.addRow('Frequency', frequency_row)
        layout.addWidget(controls)
        buttons = Qt.QHBoxLayout()
        self.start = Qt.QPushButton('Start')
        self.stop = Qt.QPushButton('Stop · Space')
        self.stop.setStyleSheet('font-weight: bold; color: #bc3030;')
        buttons.addWidget(self.start)
        buttons.addWidget(self.stop)
        layout.addLayout(buttons)
        self.plot = pg.PlotWidget()
        self.plot.setLabel('left', 'Drive', units='%')
        self.plot.setLabel('bottom', 'Time', units='s')
        self.plot.setYRange(0, 100, padding=0.05)
        self.plot.showGrid(x=True, y=True, alpha=0.2)
        self.plot.setMouseEnabled(x=False, y=False)
        self.curve = self.plot.plot(pen=pg.mkPen('#38bdf8', width=2))
        layout.addWidget(Qt.QLabel('Requested drive preview'))
        layout.addWidget(self.plot, 1)
        note = Qt.QLabel('Amplitude is PWM duty, not measured vibration. Sine and square range '
                         'from 0 to amplitude.\n0 Hz holds the selected amplitude; constant ignores frequency.')
        note.setWordWrap(True)
        layout.addWidget(note)
        self.state = Qt.QLabel('Disconnected')
        self.state.setTextFormat(QtCore.Qt.TextFormat.PlainText)
        layout.addWidget(self.state)
        self.apply_timer = QtCore.QTimer(self)
        self.apply_timer.setTimerType(QtCore.Qt.TimerType.PreciseTimer)
        self.apply_timer.setInterval(5)
        self.apply_timer.timeout.connect(self.apply)
        self.timer = QtCore.QTimer(self)
        self.timer.setTimerType(QtCore.Qt.TimerType.PreciseTimer)
        self.timer.setInterval(5)
        self.timer.timeout.connect(self.poll)
        self.timer.start()
        self.refresh.clicked.connect(lambda: self.refresh_ports())
        self.connect.clicked.connect(self.toggle_connection)
        self.start.clicked.connect(self.start_motor)
        self.stop.clicked.connect(self.stop_motor)
        self.wave.currentIndexChanged.connect(self.changed)
        self.amplitude.valueChanged.connect(self.changed)
        self.frequency.valueChanged.connect(self.changed)
        self.shortcut = QtGui.QShortcut(QtGui.QKeySequence('Space'), self)
        self.shortcut.activated.connect(self.stop_motor)
        self.refresh_ports(port)
        self.changed()
        self.buttons()

    def control(self, maximum, decimals, suffix, value):
        row = Qt.QWidget()
        layout = Qt.QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        slider = Qt.QSlider(QtCore.Qt.Orientation.Horizontal)
        slider.setRange(0, maximum * 10)
        spin = Qt.QDoubleSpinBox()
        spin.setRange(0, maximum)
        spin.setDecimals(decimals)
        spin.setSuffix(suffix)
        spin.setMinimumWidth(120)
        spin.setSingleStep(0.1 if decimals == 2 else 1)
        slider.valueChanged.connect(lambda x: spin.setValue(x / 10))

        def sync(x):
            slider.blockSignals(True)
            slider.setValue(round(x * 10))
            slider.blockSignals(False)

        spin.valueChanged.connect(sync)
        spin.setValue(value)
        layout.addWidget(slider, 1)
        layout.addWidget(spin)
        return spin, row

    def refresh_ports(self, requested=None):
        selected = requested or self.ports.currentData()
        self.ports.clear()
        for port in sorted(list_ports.comports(), key=lambda p: p.device):
            if port.vid in (0x303A, 0x2886):
                self.ports.addItem(f'{port.device} · {port.description}', port.device)
        if requested and self.ports.findData(requested) < 0:
            self.ports.addItem(requested, requested)
        index = self.ports.findData(selected)
        if index >= 0:
            self.ports.setCurrentIndex(index)

    def buttons(self):
        self.ports.setEnabled(self.serial is None)
        self.refresh.setEnabled(self.serial is None)
        self.connect.setText('Disconnect' if self.serial else 'Connect')
        self.start.setEnabled(self.ready and not self.running)
        self.stop.setEnabled(self.ready)

    def toggle_connection(self):
        if self.serial:
            self.disconnect()
            return
        port = self.ports.currentData()
        if not port:
            self.state.setText('No ESP32 USB port found. Connect the board and refresh ports.')
            return
        try:
            self.serial = serial.Serial(port, 115200, timeout=0, write_timeout=0.2,
                                        exclusive=True)
            self.serial.reset_input_buffer()
            self.buffer.clear()
            self.last_reply = self.last_ping = time.monotonic()
            self.state.setText('Checking firmware…')
            self.send('STATUS')
        except (serial.SerialException, OSError) as error:
            self.disconnect(str(error))
        self.buttons()

    def send(self, command):
        if self.serial:
            data = (command + '\n').encode('ascii')
            if self.serial.write(data) != len(data):
                raise serial.SerialTimeoutException('Incomplete USB write')

    def disconnect(self, message='Disconnected'):
        self.apply_timer.stop()
        self.dirty = False
        if self.serial:
            try:
                if self.ready:
                    self.send('STOP')
            except (serial.SerialException, OSError):
                pass  # Firmware heartbeat expires after 2 seconds.
            finally:
                self.serial.close()
                self.serial = None
        self.ready = self.running = False
        self.state.setText(message)
        self.buttons()

    def changed(self, *_):
        mode = self.wave.currentText().lower()
        frequency = self.frequency.value()
        self.frequency.parentWidget().setEnabled(mode != 'constant')
        duration = min(10, 3 / frequency) if frequency > 0 and mode != 'constant' else 1
        times = np.linspace(0, duration, 1600)
        if mode == 'constant' or frequency == 0:
            levels = np.ones_like(times)
        elif mode == 'square':
            levels = ((times * frequency) % 1 < 0.5).astype(float)
        else:
            levels = 0.5 - 0.5 * np.cos(2 * np.pi * frequency * times)
        self.curve.setData(times, levels * self.amplitude.value())
        self.plot.setXRange(0, duration, padding=0)
        if self.running:
            self.dirty = True
            if not self.apply_timer.isActive():
                self.apply_timer.start()

    def apply(self):
        if not self.dirty:
            self.apply_timer.stop()
            return
        self.dirty = False
        if self.ready:
            try:
                self.send(f'SET {self.wave.currentText().lower()} {self.amplitude.value():.3f} '
                          f'{self.frequency.value():.3f} {int(self.running)}')
            except (serial.SerialException, OSError) as error:
                self.disconnect(str(error))

    def start_motor(self):
        if self.ready:
            self.running = True
            self.dirty = True
            self.apply()
            self.buttons()

    def stop_motor(self):
        self.apply_timer.stop()
        self.dirty = False
        self.running = False
        if self.ready:
            try:
                self.send('STOP')
            except (serial.SerialException, OSError) as error:
                self.disconnect(str(error))
        self.buttons()

    def poll(self):
        if not self.serial:
            return
        try:
            self.buffer.extend(self.serial.read(self.serial.in_waiting))
            if len(self.buffer) > 8192:
                raise serial.SerialException('Unexpected USB data; check the firmware')
            while b'\n' in self.buffer:
                raw, _, self.buffer = self.buffer.partition(b'\n')
                line = raw.decode('utf-8', errors='replace').strip()
                if line.startswith('ERR'):
                    raise serial.SerialException(line)
                if not line.startswith('{'):
                    continue
                status = json.loads(line)
                if status.get('device') != 'vibration-v1':
                    raise serial.SerialException('Connected device is not vibration firmware')
                self.last_reply = time.monotonic()
                if not self.ready:
                    self.ready = True
                    self.send('STOP')
                    self.buttons()
                self.state.setText(f'{"Running" if status["running"] else "Stopped"} · '
                                   f'{status["wave"]} · {status["amplitude"]:g}% · '
                                   f'{status["frequency"]:g} Hz · PWM {status["pwm_hz"] / 1000:g} kHz')
            now = time.monotonic()
            if now - self.last_reply > 2:
                raise serial.SerialException('No firmware response. Motor heartbeat expires after 2 seconds.')
            if now - self.last_ping >= 0.4:
                self.send('PING' if self.ready else 'STATUS')
                self.last_ping = now
        except (serial.SerialException, OSError, ValueError, KeyError) as error:
            self.disconnect(str(error))

    def closeEvent(self, event):
        self.disconnect()
        event.accept()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', help='Preselect a USB serial port')
    args = parser.parse_args()
    app = Qt.QApplication(sys.argv[:1])
    window = Window(args.port)
    window.show()
    sys.exit(app.exec())
