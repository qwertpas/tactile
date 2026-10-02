// Four independent filtered white-noise voices. Gains change at the next 128-frame block.
class Noise extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pressures = [0, 0, 0, 0]; this.volume = 0.25; this.mode = 0; this.enabled = false;
    this.stamp = -Infinity; this.sample = 0;
    const centers = [
      [[220], [660], [1980], [5940]],
      [[500, 1500, 2500], [300, 2200, 3000], [400, 800, 2600], [250, 600, 2300]],
      [[300], [600], [1200], [2400]],
      [[500], [500], [3500], [3500]],
    ];
    this.filters = centers.map(mode => mode.map(voice => voice.map(frequency => {
      const w = 2 * Math.PI * frequency / sampleRate, alpha = Math.sin(w) / 16;
      return { b: alpha / (1 + alpha), a1: -2 * Math.cos(w) / (1 + alpha),
        a2: (1 - alpha) / (1 + alpha), x1: 0, x2: 0, y1: 0, y2: 0,
        gain: Math.sqrt((1 + alpha) / alpha) / Math.sqrt(voice.length) };
    })));
    this.port.onmessage = ({ data }) => {
      if (data.pressures) { this.pressures = data.pressures; this.stamp = currentTime; }
      if ('enabled' in data) this.enabled = data.enabled;
      if ('volume' in data) this.volume = data.volume;
      if ('mode' in data) this.mode = data.mode;
      if (data.stale) this.stamp = -Infinity;
    };
  }
  process(inputs, outputs) {
    const [left, right] = outputs[0];
    const fresh = this.enabled && currentTime - this.stamp < 0.1;
    const gains = this.pressures.map(p => fresh ? Math.max(0, Math.min(1, p / 30)) * this.volume : 0);
    const voices = this.filters[this.mode];
    for (let sample = 0; sample < left.length; ++sample) {
      let l = 0, r = 0;
      for (let voice = 0; voice < 4; ++voice) {
        const noise = (Math.random() * 2 - 1) * Math.sqrt(3);
        let value = 0;
        for (const f of voices[voice]) {
          const y = f.b * (noise - f.x2) - f.a1 * f.y1 - f.a2 * f.y2;
          f.x2 = f.x1; f.x1 = noise; f.y2 = f.y1; f.y1 = y;
          value += y * f.gain;
        }
        value *= gains[voice];
        if (this.mode === 2) value *= ((1 + Math.cos(2 * Math.PI * [2, 3, 5, 7][voice] * this.sample / sampleRate)) / 2) ** 4;
        if (this.mode === 3) { if (voice % 2) r += value; else l += value; }
        else { l += value * Math.SQRT1_2; r += value * Math.SQRT1_2; }
      }
      left[sample] = 0.35 * Math.tanh(l); right[sample] = 0.35 * Math.tanh(r);
      ++this.sample;
    }
    return true;
  }
}
registerProcessor('pressure-noise', Noise);
