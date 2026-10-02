export const ids = {
  sensor: '89c10001-6b3a-4c2d-a155-7b9865500001',
  pressure: '89c10002-6b3a-4c2d-a155-7b9865500001',
  sensorControl: '89c10003-6b3a-4c2d-a155-7b9865500001',
  sensorStatus: '89c10004-6b3a-4c2d-a155-7b9865500001',
  motor: '89c10011-6b3a-4c2d-a155-7b9865500001',
  motorControl: '89c10012-6b3a-4c2d-a155-7b9865500001',
  motorStatus: '89c10013-6b3a-4c2d-a155-7b9865500001',
};
export const labels = ['CH2 / 0x46', 'CH2 / 0x47', 'CH6 / 0x46', 'CH6 / 0x47'];
export const colors = ['#5cc8ff', '#faad5c', '#c394ff', '#65ddb1'];
export const scale = pressure => Math.max(0, Math.min(1, pressure / 30));
export const motorDuty = values => Math.round(1023 * (0.2 + 0.8 * scale(Math.max(...values))));

export function decode(view) {
  if (view.byteLength < 19 || view.getUint8(0) !== 1) throw Error('Invalid pressure packet');
  const sensor = view.getUint8(1), count = view.getUint8(2), flags = view.getUint8(3);
  if (sensor > 3 || count < 1 || count > 16 || view.byteLength !== 16 + count * 3) throw Error('Invalid pressure packet length');
  const values = Array.from({ length: count }, (_, i) => {
    const offset = 16 + i * 3;
    return (view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16) / 64000;
  });
  return { sensor, count, flags, generation: flags >> 2, sequence: view.getUint32(4, true), time: view.getUint32(8, true),
    errors: view.getUint16(12, true), dropped: view.getUint16(14, true), values };
}

export function decodeBatch(view) {
  const packets = [];
  for (let offset = 0; offset < view.byteLength;) {
    if (view.byteLength - offset < 19) throw Error('Incomplete pressure batch');
    const size = 16 + view.getUint8(offset + 2) * 3;
    if (offset + size > view.byteLength) throw Error('Incomplete pressure packet');
    packets.push(decode(new DataView(view.buffer, view.byteOffset + offset, size)));
    offset += size;
  }
  if (!packets.length) throw Error('Empty pressure batch');
  return packets;
}

export class Pressures {
  constructor() { this.reset(); }
  reset() {
    this.raw = [NaN, NaN, NaN, NaN];
    this.baseline = [NaN, NaN, NaN, NaN];
    this.values = [0, 0, 0, 0];
    this.stamps = [-Infinity, -Infinity, -Infinity, -Infinity];
    this.next = [null, null, null, null];
    this.counts = [0, 0, 0, 0];
    this.gaps = [0, 0, 0, 0];
    this.faults = [0, 0, 0, 0];
    this.history = [[], [], [], []];
    this.zeroed = false;
    this.demo = false;
  }
  fresh(now) { return this.zeroed && this.stamps.every(stamp => now - stamp < 100); }
  zero() {
    if (!this.raw.every(Number.isFinite)) return false;
    this.baseline = [...this.raw];
    this.values.fill(0);
    this.history = [[], [], [], []];
    this.zeroed = true;
    return true;
  }
  ingest(packet, now) {
    const { sensor, count, sequence, values } = packet;
    const expected = this.next[sensor];
    if (expected !== null && sequence !== expected) this.gaps[sensor] += (sequence - expected) >>> 0;
    this.next[sensor] = (sequence + count) >>> 0;
    this.counts[sensor] += count;
    this.faults[sensor] = packet.errors + packet.dropped + ((packet.flags & 2) ? 1 : 0);
    this.demo = Boolean(packet.flags & 1);
    this.raw[sensor] = values.at(-1);
    this.stamps[sensor] = now;
    if (!this.zeroed) this.zero();
    // This is the only pressure processing: absolute kPa minus one shared baseline.
    const relative = values.map(value => value - this.baseline[sensor]);
    this.values[sensor] = this.zeroed ? relative.at(-1) : 0;
    if (this.zeroed) {
      const history = this.history[sensor];
      for (let i = 0; i < count; ++i) history.push([now - (count - 1 - i) * 2, relative[i]]);
      while (history.length && history[0][0] < now - 10000) history.shift();
    }
    return this.values;
  }
}

// One pending value: slow BLE writes never build a queue of old motor commands.
export class MotorWriter {
  constructor(write, onError) {
    this.write = write; this.onError = onError;
    this.pending = null; this.busy = false; this.sequence = 0;
    this.lastDuty = null; this.lastTime = -Infinity;
  }
  set(duty) {
    if (duty === this.lastDuty && performance.now() - this.lastTime < 40 && this.pending === null) return;
    this.pending = duty; return this.flush();
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending !== null) {
        const duty = this.pending; this.pending = null;
        this.lastDuty = duty; this.lastTime = performance.now();
        const packet = new DataView(new ArrayBuffer(6));
        packet.setUint16(0, duty, true); packet.setUint32(2, ++this.sequence, true);
        await this.write(packet);
      }
    } catch (error) { this.pending = null; this.onError(error); }
    finally { this.busy = false; }
  }
}
