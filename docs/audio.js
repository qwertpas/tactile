// Each direct voice retains its own sample clock, high-pass state and FIFO.
function directVoice() {
  return { queue: Array(12).fill(0), position: 12, playing: false, next: null,
    time: null, sequence: 0, rate: 500, last: null, high: 0, stamp: -Infinity };
}

class PressureAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.pressures = [0, 0, 0, 0]; this.volume = 0.25; this.mode = 5; this.enabled = false;
    this.gain = 100;
    this.direct = Array.from({ length: 4 }, directVoice);
    // Windowed-sinc interpolation avoids the droop and images of linear playback.
    this.kernel = Array.from({ length: 256 }, (_, phase) => {
      const taps = Array.from({ length: 24 }, (_, i) => {
        const x = i - 11 - phase / 256;
        return Math.abs(x) >= 12 ? 0 : (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
          * (0.42 + 0.5 * Math.cos(Math.PI * x / 12) + 0.08 * Math.cos(Math.PI * x / 6));
      });
      const sum = taps.reduce((a, b) => a + b, 0);
      return taps.map(value => value / sum);
    });
    this.stamp = -Infinity; this.sample = 0;
    this.vowels = options.processorOptions.vowels; this.positions = [0, 0, 0, 0];
    const centers = [
      [[220], [660], [1980], [5940]],
      [[], [], [], []],
      [[300], [600], [1200], [2400]],
      [[500], [500], [3500], [3500]],
    ];
    this.filters = centers.map(mode => mode.map(voice => voice.map(frequency => {
      const w = 2 * Math.PI * frequency / sampleRate, alpha = Math.sin(w) / 16;
      return { b: alpha / (1 + alpha), a1: -2 * Math.cos(w) / (1 + alpha),
        a2: (1 - alpha) / (1 + alpha), x1: 0, x2: 0, y1: 0, y2: 0,
        gain: Math.sqrt((1 + alpha) / alpha) };
    })));
    this.port.onmessage = ({ data }) => {
      if (data.pressures) { this.pressures = data.pressures; this.stamp = currentTime; }
      if ('enabled' in data && data.enabled !== this.enabled) {
        this.enabled = data.enabled; this.direct = Array.from({ length: 4 }, directVoice);
      }
      if ('volume' in data) this.volume = data.volume;
      if ('gain' in data) this.gain = data.gain;
      if ('mode' in data && data.mode !== this.mode) {
        this.mode = data.mode; this.direct = Array.from({ length: 4 }, directVoice);
      }
      if (data.stale || data.reset) {
        this.stamp = -Infinity; this.direct = Array.from({ length: 4 }, directVoice);
      }
      if (this.enabled && this.mode === 5 && data.packets)
        for (const packet of data.packets) this.append(packet);
    };
  }
  append(packet) {
    const { sensor, sequence, time, values } = packet;
    let voice = this.direct[sensor];
    // Do not interpolate across transport loss or a stream restart.
    if (voice.next !== null && voice.next !== sequence) voice = this.direct[sensor] = directVoice();
    voice.next = (sequence + values.length) >>> 0;
    if (voice.time === null) { voice.time = time; voice.sequence = voice.next; }
    const elapsed = (time - voice.time) >>> 0;
    if (elapsed >= 500000) {
      voice.rate = ((voice.next - voice.sequence) >>> 0) * 1e6 / elapsed;
      if (elapsed >= 10000000) { voice.time = time; voice.sequence = voice.next; }
    }
    const alpha = Math.exp(-2 * Math.PI * 8 / voice.rate);
    for (const value of values) {
      if (voice.last === null) voice.last = value;
      voice.high = alpha * (voice.high + value - voice.last);
      voice.last = value;
      voice.queue.push(voice.high);
    }
    voice.stamp = currentTime;
  }
  playDirect(left, right) {
    left.fill(0); right.fill(0);
    if (!this.enabled) return;
    for (let sensor = 0; sensor < 4; ++sensor) {
      const voice = this.direct[sensor], queue = voice.queue;
      if (currentTime - voice.stamp >= 0.1) {
        if (voice.next !== null) this.direct[sensor] = directVoice();
        continue;
      }
      // About 40 ms of lookahead absorbs BLE batching; underruns wait for data.
      if (!voice.playing && queue.length - voice.position >= 20) voice.playing = true;
      if (!voice.playing) continue;
      const output = sensor % 2 ? right : left, step = voice.rate / sampleRate;
      for (let frame = 0; frame < output.length; ++frame) {
        const index = Math.floor(voice.position);
        if (index + 12 >= queue.length) { voice.playing = false; break; }
        const taps = this.kernel[Math.floor((voice.position - index) * 256)];
        let value = 0;
        for (let tap = 0; tap < 24; ++tap) value += queue[index - 11 + tap] * taps[tap];
        output[frame] += value * this.gain * this.volume * 0.5;
        voice.position += step;
      }
      const consumed = Math.floor(voice.position) - 12;
      if (consumed > 0) { queue.splice(0, consumed); voice.position -= consumed; }
    }
    for (let frame = 0; frame < left.length; ++frame) {
      left[frame] = Math.max(-0.95, Math.min(0.95, left[frame]));
      right[frame] = Math.max(-0.95, Math.min(0.95, right[frame]));
    }
  }
  process(inputs, outputs) {
    const [left, right] = outputs[0];
    if (this.mode === 5) { this.playDirect(left, right); return true; }
    const fresh = this.enabled && currentTime - this.stamp < 0.1;
    const gains = this.pressures.map(p => fresh ? Math.max(0, Math.min(1, p / 30)) * this.volume : 0);
    const voices = this.filters[this.mode];
    const linear = this.mode === 1 || this.mode === 4;
    for (let sample = 0; sample < left.length; ++sample) {
      let l = 0, r = 0;
      for (let voice = 0; voice < 4; ++voice) {
        let value = 0;
        if (this.mode === 1) {
          const clip = this.vowels[voice];
          value = clip[this.positions[voice]] * 1.5;
          this.positions[voice] = (this.positions[voice] + 1) % clip.length;
        } else if (this.mode === 4) {
          value = Math.sin(2 * Math.PI * [220, 660, 1980, 5940][voice] * this.sample / sampleRate);
        } else {
          const noise = (Math.random() * 2 - 1) * Math.sqrt(3);
          for (const f of voices[voice]) {
            const y = f.b * (noise - f.x2) - f.a1 * f.y1 - f.a2 * f.y2;
            f.x2 = f.x1; f.x1 = noise; f.y2 = f.y1; f.y1 = y;
            value += y * f.gain;
          }
        }
        value *= gains[voice];
        if (this.mode === 2) value *= ((1 + Math.cos(2 * Math.PI * [2, 3, 5, 7][voice] * this.sample / sampleRate)) / 2) ** 4;
        if (this.mode === 3) { if (voice % 2) r += value; else l += value; }
        else { l += value * Math.SQRT1_2; r += value * Math.SQRT1_2; }
      }
      left[sample] = linear ? 0.25 * l : 0.35 * Math.tanh(l);
      right[sample] = linear ? 0.25 * r : 0.35 * Math.tanh(r);
      ++this.sample;
    }
    return true;
  }
}
registerProcessor('pressure-audio', PressureAudio);
