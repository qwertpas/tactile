// Gains change at the next 128-frame block, without pressure smoothing.
class PressureAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pressures = [0, 0, 0, 0]; this.volume = 0.25; this.mode = 0; this.enabled = false;
    this.stamp = -Infinity; this.sample = 0;
    this.phase = [0, 0, 0, 0]; this.flow = [0, 0, 0, 0];
    const filter = (frequency, bandwidth, gain) => {
      const w = 2 * Math.PI * frequency / sampleRate, alpha = Math.sin(w) * bandwidth / (2 * frequency);
      return { b: alpha / (1 + alpha), a1: -2 * Math.cos(w) / (1 + alpha),
        a2: (1 - alpha) / (1 + alpha), x1: 0, x2: 0, y1: 0, y2: 0,
        gain: gain ?? Math.sqrt((1 + alpha) / alpha) };
    };
    const centers = [
      [[220], [660], [1980], [5940]],
      [],
      [[300], [600], [1200], [2400]],
      [[500], [500], [3500], [3500]],
    ];
    this.filters = centers.map(mode => mode.map(voice => voice.map(frequency => filter(frequency, frequency / 8))));
    // Tenor ah / ee / oh / oo: frequency, bandwidth, amplitude (dB).
    // https://csound.com/manual/misc/formants/
    const vowels = [
      [[650,80,0],[1080,90,-6],[2650,120,-7],[2900,130,-8],[3250,140,-22]],
      [[290,40,0],[1870,90,-15],[2800,100,-18],[3250,120,-20],[3540,120,-30]],
      [[400,70,0],[800,80,-10],[2600,100,-12],[2800,130,-12],[3000,135,-26]],
      [[350,40,0],[600,60,-20],[2700,100,-17],[2900,120,-14],[3300,120,-26]],
    ];
    this.filters[1] = vowels.map(voice => voice.map(([frequency, bandwidth, db]) => filter(frequency, bandwidth, 8 * 10 ** (db / 20))));
    this.port.onmessage = ({ data }) => {
      if (data.pressures) { this.pressures = data.pressures; this.stamp = currentTime; }
      if ('enabled' in data) this.enabled = data.enabled;
      if ('volume' in data) this.volume = data.volume;
      if ('mode' in data) this.mode = data.mode;
      if (data.stale) this.stamp = -Infinity;
    };
  }
  voiced(voice) {
    const frequency = (120 + voice * 15) * (1 + 0.003 * Math.sin(2 * Math.PI * (4.5 + voice * 0.1) * this.sample / sampleRate + voice));
    this.phase[voice] = (this.phase[voice] + frequency / sampleRate) % 1;
    const phase = this.phase[voice];
    // Vocal-fold opening and closure, then its radiated flow derivative (Rosenberg pulse).
    const flow = phase < 0.4 ? (1 - Math.cos(Math.PI * phase / 0.4)) / 2
      : phase < 0.6 ? Math.cos(Math.PI * (phase - 0.4) / 0.4) : 0;
    const source = (flow - this.flow[voice]) * sampleRate / frequency * 0.25;
    this.flow[voice] = flow;
    return source;
  }
  process(inputs, outputs) {
    const [left, right] = outputs[0];
    const fresh = this.enabled && currentTime - this.stamp < 0.1;
    const gains = this.pressures.map(p => fresh ? Math.max(0, Math.min(1, p / 30)) * this.volume : 0);
    const voices = this.filters[this.mode];
    for (let sample = 0; sample < left.length; ++sample) {
      let l = 0, r = 0;
      for (let voice = 0; voice < 4; ++voice) {
        const source = this.mode === 1 ? this.voiced(voice) : (Math.random() * 2 - 1) * Math.sqrt(3);
        let value = 0;
        for (const f of voices[voice]) {
          const y = f.b * (source - f.x2) - f.a1 * f.y1 - f.a2 * f.y2;
          f.x2 = f.x1; f.x1 = source; f.y2 = f.y1; f.y1 = y;
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
registerProcessor('pressure-audio', PressureAudio);
