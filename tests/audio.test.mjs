import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { decodeBatch } from '../docs/pressure.js';

const source = fs.readFileSync(new URL('../docs/audio.js', import.meta.url), 'utf8');
function audio(rate = 48000) {
  let Processor;
  const clock = { sampleRate: rate, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor: (_, value) => { Processor = value; } };
  vm.runInNewContext(source, clock);
  const processor = new Processor({ processorOptions: { vowels: Array.from({ length: 4 }, () => Float32Array.of(1, -1)) } });
  processor.port.onmessage({ data: { enabled: true, gain: 100, volume: 0.25 } });
  return { clock, processor, send: data => processor.port.onmessage({ data }) };
}
function notification(first, count, rate, frequency, sensor = 0, baseline = 100, stamp = null) {
  const view = new DataView(new ArrayBuffer(16 + count * 3));
  view.setUint8(0, 1); view.setUint8(1, sensor); view.setUint8(2, count);
  view.setUint32(4, first >>> 0, true);
  view.setUint32(8, stamp ?? Math.round((first + count) * 1e6 / rate), true);
  for (let i = 0; i < count; ++i) {
    const pressure = baseline + .002 * Math.sin(2 * Math.PI * frequency * (first + i) / rate);
    const raw = Math.round(pressure * 64000);
    for (let b = 0; b < 3; ++b) view.setUint8(16 + i * 3 + b, raw >> (8 * b));
  }
  return view;
}
function simulate({ rate = 500, frequency = 173, sensor = 0, baseline = 100, jitter = false, seconds = 5, outputRate = 48000 } = {}) {
  const engine = audio(outputRate), output = [[new Float32Array(128), new Float32Array(128)]];
  const samples = [[], []]; let next = 0, delivery = 0, packets = 0;
  for (let block = 0; block < Math.ceil(seconds * outputRate / 128); ++block) {
    const time = block * 128 / outputRate; engine.clock.currentTime = time;
    // 16 ms packets, with delivery jitter independent of sensor timestamps.
    while (time >= delivery) {
      const count = [8, 7, 9][packets % 3];
      const bytes = notification(next, count, rate, frequency, sensor, baseline);
      engine.send({ packets: decodeBatch(bytes) });
      next += count; ++packets;
      delivery = next / rate + (jitter ? [0, .004, .001][packets % 3] : 0);
    }
    engine.processor.process([], output);
    for (let c = 0; c < 2; ++c) samples[c].push(...output[0][c]);
  }
  return { ...engine, samples, next };
}
function energy(samples) { return samples.reduce((sum, x) => sum + x * x, 0) / samples.length; }
function tone(samples, frequency, rate = 48000) {
  let sine = 0, cosine = 0;
  for (let i = 0; i < samples.length; ++i) {
    sine += samples[i] * Math.sin(2 * Math.PI * frequency * i / rate);
    cosine += samples[i] * Math.cos(2 * Math.PI * frequency * i / rate);
  }
  return 2 * Math.hypot(sine, cosine) / samples.length;
}

test('real BLE decoding through default playback retains the 173 Hz signal inside packets, not its 14.5 Hz packet-tail alias', () => {
  const { processor, samples, next } = simulate();
  assert.equal(processor.mode, 5);
  const left = samples[0].slice(48000);
  assert.ok(tone(left, 173) > .023);
  assert.ok(tone(left, 14.5) < .0001);
  assert.equal(energy(samples[1]), 0);
  assert.equal(processor.direct[0].next, next);
  // A bounded unread tail remains for interpolation; no growing sample backlog.
  assert.ok(processor.direct[0].queue.length < 60);
});

test('independent sensor clocks retain pitch under batching jitter and route every channel to its stereo side', () => {
  for (let sensor = 0; sensor < 4; ++sensor) {
    const rate = [498, 503, 495, 501][sensor], frequency = [73, 131, 173, 211][sensor];
    const { samples, processor } = simulate({ rate, frequency, sensor, jitter: true, seconds: 8 });
    const active = samples[sensor % 2].slice(4 * 48000);
    assert.ok(tone(active, frequency) > .02, `channel ${sensor}: ${tone(active, frequency)}`);
    assert.equal(energy(samples[1 - sensor % 2]), 0);
    assert.ok(Math.abs(processor.direct[sensor].rate - rate) < 1);
    assert.ok(processor.direct[sensor].queue.length < 60);
    for (let i = 0; i + 2400 <= active.length; i += 2400)
      assert.ok(energy(active.slice(i, i + 2400)) > .0001, 'no 50 ms audio gaps');
  }
});

test('static preload does not change the vibration, and 44.1 kHz output preserves pitch', () => {
  const a = simulate({ baseline: 90 }).samples[0];
  const b = simulate({ baseline: 120 }).samples[0];
  assert.ok(a.every((value, i) => Math.abs(value - b[i]) < 1e-7));
  const { samples } = simulate({ outputRate: 44100 });
  assert.ok(tone(samples[0].slice(44100), 173, 44100) > .023);
});

test('stop, stale data, zeroing and gaps clear buffered audio; counters and timestamps can wrap', () => {
  const { processor, send, clock } = audio(), output = [[new Float32Array(128), new Float32Array(128)]];
  const feed = (first, stamp) => send({ packets: decodeBatch(notification(first, 16, 500, 173, 0, 100, stamp)) });
  feed(0, 32000); feed(16, 64000); processor.process([], output);
  assert.ok(energy(output[0][0]) > 0);
  for (const control of [{ enabled: false }, { stale: true }, { reset: true }]) {
    send(control); processor.process([], output);
    assert.equal(energy(output[0][0]), 0);
    send({ enabled: true }); feed(0, 32000); feed(16, 64000);
  }
  feed(100, 100000); assert.equal(processor.direct[0].queue.length, 28);
  feed(116, 132000); clock.currentTime = .101; processor.process([], output);
  assert.equal(energy(output[0][0]), 0);
  clock.currentTime = 0;
  feed(0xfffffff0, 0xffff8000); feed(0, 0); feed(16, 32000);
  assert.equal(processor.direct[0].next, 32);
  assert.equal(processor.direct[0].queue.length, 60);
});

test('underruns wait for more samples, and legacy sound mappings still start and stop', () => {
  const { processor, send } = audio(), output = [[new Float32Array(128), new Float32Array(128)]];
  send({ packets: decodeBatch(notification(0, 16, 500, 173)) });
  processor.process([], output); assert.equal(energy(output[0][0]), 0);
  send({ packets: decodeBatch(notification(16, 16, 500, 173)) });
  for (let block = 0; block < 100; ++block) processor.process([], output);
  const position = processor.direct[0].position;
  processor.process([], output); assert.equal(processor.direct[0].position, position);
  assert.equal(energy(output[0][0]), 0);
  send({ packets: decodeBatch(notification(32, 16, 500, 173)) });
  processor.process([], output); assert.ok(energy(output[0][0]) > 0);
  for (let mode = 0; mode < 5; ++mode) {
    send({ mode, pressures: [30, 30, 30, 30] }); processor.process([], output);
    assert.ok(energy(output[0][0]) > 0);
    send({ enabled: false }); processor.process([], output);
    assert.equal(energy(output[0][0]), 0); send({ enabled: true });
  }
});
