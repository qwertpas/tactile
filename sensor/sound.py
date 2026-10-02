"""Four pressure proportions drive four contrasting filtered-white-noise mappings."""
import time

import numpy as np
import sounddevice as sd
from scipy import signal

MODES = {
    'Bands': 'Four pitches: 220, 660, 1980, 5940 Hz. Each pressure controls its pitch.',
    'Vowels': 'Four noise vowels: ah, ee, oh, oo. Pressure proportions blend their timbres.',
    'Pulses': 'Four pitched rhythms: 2, 3, 5, 7 pulses/second. Pressure controls each rhythm.',
    'Stereo': 'Low left, low right, high left, high right. Use headphones for clear positions.',
}


class Sound:
    def __init__(self, read_pressure, rate=48000):
        self.rate = rate
        self.read_pressure = read_pressure
        self.random = np.random.default_rng()
        self.controls = (0, 0.25, 30000., False)
        self.samples = 0
        self.errors = 0
        self.stream = None
        self.filters = []
        frequencies = [
            [[220], [660], [1980], [5940]],
            [[500, 1500, 2500], [300, 2200, 3000], [400, 800, 2600], [250, 600, 2300]],
            [[300], [600], [1200], [2400]],
            [[500], [500], [3500], [3500]],
        ]
        for mode in frequencies:
            voices = []
            for centers in mode:
                filters = []
                response = 0
                for center in centers:
                    b, a = signal.iirpeak(center, 8, fs=rate)
                    _, h = signal.freqz(b, a, worN=8192)
                    response = response + h
                    filters.append([b, a, np.zeros(2)])
                voices.append((filters, 1 / np.sqrt(np.mean(np.abs(response) ** 2))))
            self.filters.append(voices)

    def set(self, mode, volume, scale, enabled):
        self.controls = (mode, volume, scale, enabled)

    def render(self, frames):
        pressure, stamp = self.read_pressure()
        mode, volume, scale, enabled = self.controls
        target = np.zeros((4, 4))
        if enabled and time.monotonic() - stamp < 0.5:
            target[mode] = np.clip(pressure / scale, 0, 1) * volume
        mix = np.zeros((frames, 2))
        noise = self.random.standard_normal((4, frames))
        times = (self.samples + np.arange(frames)) / self.rate
        for m, voices in enumerate(self.filters):
            for i, (filters, gain) in enumerate(voices):
                voice = np.zeros(frames)
                for f in filters:
                    filtered, f[2] = signal.lfilter(f[0], f[1], noise[i], zi=f[2])
                    voice += filtered
                envelope = np.full(frames, target[m, i])
                if m == 2:
                    envelope *= ((1 + np.cos(2 * np.pi * [2, 3, 5, 7][i] * times)) / 2) ** 4
                voice *= gain * envelope
                pan = ([1., 0.] if i % 2 == 0 else [0., 1.]) if m == 3 else [0.707, 0.707]
                mix += voice[:, None] * pan
        self.samples += frames
        return (0.35 * np.tanh(mix)).astype(np.float32)

    def callback(self, output, frames, timing, status):
        if status:
            self.errors += 1
        output[:] = self.render(frames)

    def start(self):
        self.stream = sd.OutputStream(samplerate=self.rate, channels=2, dtype='float32',
                                      blocksize=128, latency='low', callback=self.callback)
        self.stream.start()

    def close(self):
        if self.stream:
            self.stream.stop()
            self.stream.close()
            self.stream = None
