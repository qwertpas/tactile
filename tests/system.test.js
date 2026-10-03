import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { decode, decodeBatch, Pressures, motorDuty, MotorWriter } from '../docs/pressure.js';

function packet(sensor, values, sequence = 0) {
  const view = new DataView(new ArrayBuffer(16 + values.length * 3));
  view.setUint8(0, 1); view.setUint8(1, sensor); view.setUint8(2, values.length);
  view.setUint32(4, sequence, true);
  values.forEach((p, i) => {
    const raw = Math.round(p * 64000);
    for (let b = 0; b < 3; ++b) view.setUint8(16 + i * 3 + b, raw >> (8 * b));
  });
  return decode(view);
}

let Processor;
const recordings = ['ah', 'ee', 'oh', 'oo'].map(name => {
  const wav = fs.readFileSync(new URL(`../docs/vowels/${name}.wav`, import.meta.url));
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  return Float32Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
});
const audioOptions = { processorOptions: { vowels: recordings } };
const audioContext = { AudioWorkletProcessor: class { constructor() { this.port = {}; } },
  registerProcessor: (_, cls) => { Processor = cls; }, sampleRate: 48000, currentTime: 0 };
vm.runInNewContext(fs.readFileSync(new URL('../docs/audio.js', import.meta.url), 'utf8'), audioContext);
function render(processor, blocks = 100) {
  const outputs = [[new Float32Array(128), new Float32Array(128)]];
  let energy = [0, 0], max = 0;
  for (let i = 0; i < blocks; ++i) {
    processor.process([], outputs);
    for (let channel = 0; channel < 2; ++channel)
      for (const sample of outputs[0][channel]) {
        assert.ok(Number.isFinite(sample)); energy[channel] += sample * sample;
        max = Math.max(max, Math.abs(sample));
      }
  }
  return { energy, max };
}

test('one zeroed snapshot controls history, audio gains and highest-pressure motor; step has no smoothing', () => {
  const state = new Pressures();
  for (let i = 0; i < 4; ++i) state.ingest(packet(i, [100 + i]), 0);
  assert.deepEqual(state.values, [0, 0, 0, 0]);
  assert.equal(motorDuty(state.values), 205);
  state.ingest(packet(2, [117, 132], 1), 5);
  assert.deepEqual(state.values, [0, 0, 30, 0]);
  assert.equal(state.history[2].at(-1)[1], state.values[2]);
  assert.equal(motorDuty(state.values), 1023);
  const processor = new Processor(audioOptions);
  processor.port.onmessage({ data: { pressures: [...state.values], enabled: true, mode: 3 } });
  let sound = render(processor);
  assert.ok(sound.energy[0] > 0.1); assert.equal(sound.energy[1], 0);
  assert.ok(sound.max <= 0.35);
  assert.equal(state.zero(), true);
  assert.deepEqual(state.values, [0, 0, 0, 0]);
  assert.ok(state.history.every(history => history.length === 0));
  assert.equal(motorDuty(state.values), 205);
  processor.port.onmessage({ data: { pressures: [...state.values] } });
  assert.deepEqual(render(processor, 1).energy, [0, 0]); // Silence on the very next block.
  state.ingest(packet(0, [99], 1), 10);
  assert.equal(state.values[0], -1); assert.equal(motorDuty(state.values), 205);
  assert.equal(state.fresh(99), true); assert.equal(state.fresh(101), false);
});

test('all sound modes render bounded audio; stale input silences the next block', () => {
  for (let mode = 0; mode < 4; ++mode) {
    const processor = new Processor(audioOptions);
    processor.port.onmessage({ data: { pressures: [30, 30, 30, 30], enabled: true, mode, volume: 1 } });
    const audio = render(processor);
    assert.ok(audio.energy.every(e => e > 0)); assert.ok(audio.max <= (mode === 1 ? 0.96 : 0.35));
    processor.port.onmessage({ data: { stale: true } });
    assert.deepEqual(render(processor, 1).energy, [0, 0]);
  }
});

test('vowels preserve the human recording waveform; zero pressure and stop silence the next audio block', () => {
  for (let voice = 0; voice < 4; ++voice) {
    const processor = new Processor(audioOptions);
    const pressures = [0, 0, 0, 0]; pressures[voice] = 30;
    processor.port.onmessage({ data: { pressures, enabled: true, mode: 1, volume: 0.25 } });
    render(processor);
    const output = [[new Float32Array(128), new Float32Array(128)]], samples = [];
    for (let block = 0; block < 40; ++block) {
      processor.process([], output); samples.push(...output[0][0]);
    }
    let best = 0;
    const recording = recordings[voice];
    for (let offset = 0; offset < recording.length; offset += 128) {
      let correlation = 0, energy = 0, shifted = 0;
      for (let i = 0; i < samples.length; ++i) {
        const reference = recording[(offset + i) % recording.length];
        correlation += samples[i] * reference;
        energy += samples[i] ** 2; shifted += reference ** 2;
      }
      assert.ok(energy > 0.01);
      best = Math.max(best, correlation / Math.sqrt(energy * shifted));
    }
    assert.ok(best > 0.999, `Vowel ${voice} retains the human waveform without distortion`);
    processor.port.onmessage({ data: { pressures: [0, 0, 0, 0] } });
    assert.deepEqual(render(processor, 1).energy, [0, 0]);
    processor.port.onmessage({ data: { pressures, enabled: false } });
    assert.deepEqual(render(processor, 1).energy, [0, 0]);
  }
});

test('BLE writer sends newest pressure and immediate stop after an in-flight write, without a backlog', async () => {
  const sent = [], finish = [];
  const writer = new MotorWriter(view => new Promise(resolve => {
    sent.push([view.getUint16(0, true), view.getUint32(2, true)]); finish.push(resolve);
  }), e => { throw e; });
  const pending = writer.set(205);
  for (let duty = 206; duty <= 1023; ++duty) writer.set(duty);
  writer.set(0);
  assert.equal(sent.length, 1);
  finish.shift()(); await Promise.resolve();
  assert.deepEqual(sent, [[205, 1], [0, 2]]);
  finish.shift()(); await pending;
  assert.equal(writer.busy, false);
});

test('malformed BLE data is rejected, sample gaps and faults are counted', () => {
  assert.throws(() => decode(new DataView(new ArrayBuffer(18))));
  const invalid = new DataView(new ArrayBuffer(19));
  invalid.setUint8(0, 1); invalid.setUint8(2, 1);
  for (let i = 16; i < 19; ++i) invalid.setUint8(i, 255);
  assert.throws(() => decode(invalid), /Invalid sensor pressure/);
  const state = new Pressures();
  state.ingest(packet(0, [100], 0), 0); state.ingest(packet(0, [101], 4), 1);
  assert.equal(state.gaps[0], 3);
  assert.equal(state.zero(), false);
});

test('one BLE notification preserves each sensor and every batched sample', () => {
  const bytes = [];
  for (let sensor = 0; sensor < 4; ++sensor) {
    const view = new DataView(new ArrayBuffer(22));
    view.setUint8(0, 1); view.setUint8(1, sensor); view.setUint8(2, 2);
    for (let i = 0; i < 2; ++i) {
      const raw = (100 + sensor + i) * 64000;
      for (let b = 0; b < 3; ++b) view.setUint8(16 + i * 3 + b, raw >> (8 * b));
    }
    bytes.push(...new Uint8Array(view.buffer));
  }
  const decoded = decodeBatch(new DataView(Uint8Array.from(bytes).buffer));
  assert.deepEqual(decoded.map(p => p.sensor), [0, 1, 2, 3]);
  assert.deepEqual(decoded.map(p => p.values), [[100, 101], [101, 102], [102, 103], [103, 104]]);
  assert.throws(() => decodeBatch(new DataView(Uint8Array.from(bytes.slice(0, -1)).buffer)));
});
