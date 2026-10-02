"""Real two-board BLE integration check; mux absent by default, --sensors after wiring."""
import argparse
import asyncio
import json
import math
import struct
import time
from bleak import BleakClient, BleakScanner

BASE = '-6b3a-4c2d-a155-7b9865500001'
PRESSURE, SENSOR_CONTROL, SENSOR_STATUS = [f'89c1000{i}{BASE}' for i in (2, 3, 4)]
MOTOR_CONTROL, MOTOR_STATUS = [f'89c1001{i}{BASE}' for i in (2, 3)]


def motor_status(raw):
    sequence, stamp, commands, duty, interval = struct.unpack('<IIIHH', raw)
    return dict(sequence=sequence, stamp=stamp, commands=commands, duty=duty, interval_ms=interval * 1.25)


async def main(args):
    found = await BleakScanner.discover(timeout=5)
    devices = {d.name: d for d in found if d.name in ('Tactile Pressure', 'Tactile Vibration')}
    assert len(devices) == 2, [(d.name, d.address) for d in found]
    print('Found both boards over BLE', flush=True)
    counts, expected, gaps = [0]*4, [None]*4, [0]*4
    latest, times = [math.nan]*4, [0]*4
    low, high = [math.inf]*4, [-math.inf]*4
    demo_flags = set()
    notified, errors = [], []
    sequence = 0
    changed = asyncio.Event()
    async with BleakClient(devices['Tactile Pressure']) as sensor, BleakClient(devices['Tactile Vibration']) as motor:
        print('Connected both:', sensor.mtu_size, motor.mtu_size, 'MTU', flush=True)

        async def drive(duty, response=False):
            nonlocal sequence
            sequence += 1
            await motor.write_gatt_char(MOTOR_CONTROL, struct.pack('<HI', duty, sequence), response=response)
            return sequence

        async def read_motor():
            return motor_status(await motor.read_gatt_char(MOTOR_STATUS))

        await drive(0, True)
        # Acknowledged command + read bounds the BLE-to-PWM response from above.
        latency = []
        for duty in (205, 614, 1023, 0, 205, 0):
            start = time.perf_counter()
            sent = await drive(duty, True)
            actual = await read_motor()
            latency.append((time.perf_counter() - start) * 1000)
            assert actual['duty'] == duty and actual['sequence'] == sent, actual
        print('PWM endpoints and stop passed; write+read ms:', [round(v, 1) for v in latency], flush=True)
        before = await read_motor()
        await motor.write_gatt_char(MOTOR_CONTROL, struct.pack('<HI', 1024, 999999), response=True)
        assert (await read_motor())['sequence'] == before['sequence']
        await drive(205, True)
        await asyncio.sleep(.35)
        assert (await read_motor())['duty'] == 0
        print('Invalid duty rejected; 250 ms watchdog passed', flush=True)

        def pressure_packet(data):
            try:
                assert len(data) >= 19
                version, sensor_id, count, flags, first, stamp, faults, dropped = struct.unpack_from('<BBBBIIHH', data)
                assert version == 1 and sensor_id < 4 and 1 <= count <= 16 and len(data) == 16 + count * 3
                assert faults == dropped == 0, (faults, dropped)
                assert not flags & 2, flags
                demo_flags.add(bool(flags & 1))
                if expected[sensor_id] is not None and first != expected[sensor_id]:
                    gaps[sensor_id] += (first - expected[sensor_id]) & 0xffffffff
                expected[sensor_id] = (first + count) & 0xffffffff
                counts[sensor_id] += count
                values = [int.from_bytes(data[i:i+3], 'little') / 64000 for i in range(16, len(data), 3)]
                assert all(30 <= p <= 150 for p in values), values
                low[sensor_id] = min(low[sensor_id], *values)
                high[sensor_id] = max(high[sensor_id], *values)
                p = values[-1]
                latest[sensor_id] = p
                times[sensor_id] = time.perf_counter()
                notified.append((times[sensor_id], sensor_id, first, count, p))
            except Exception as e:
                errors.append(str(e))

        def pressure(_, data):
            offset = 0
            while offset < len(data):
                if len(data) - offset < 19:
                    errors.append('Short pressure batch')
                    return
                size = 16 + data[offset + 2] * 3
                pressure_packet(data[offset:offset + size])
                offset += size
            changed.set()

        await sensor.start_notify(PRESSURE, pressure)
        if not args.sensors:
            await sensor.write_gatt_char(SENSOR_CONTROL, b'S', response=True)
            await asyncio.sleep(.3)
            status = json.loads(await sensor.read_gatt_char(SENSOR_STATUS))
            assert not status['streaming'], status
            print('Absent mux reported correctly:', status['message'], flush=True)
        await sensor.write_gatt_char(SENSOR_CONTROL, b'S' if args.sensors else b'D', response=True)
        start = time.perf_counter()
        status = None
        writes = 0
        max_age = 0
        last_duty, last_write = None, 0
        baseline = None
        # The same first complete baseline and highest relative pressure as the page.
        try:
            await asyncio.sleep(.2)
            status = json.loads(await sensor.read_gatt_char(SENSOR_STATUS))
            assert status['streaming'], status
            while time.perf_counter() - start < args.seconds:
                try:
                    await asyncio.wait_for(changed.wait(), timeout=.04)
                except asyncio.TimeoutError:
                    pass
                changed.clear()
                now = time.perf_counter()
                if all(math.isfinite(p) for p in latest):
                    if baseline is None:
                        baseline = latest.copy()
                    max_age = max(max_age, (now - min(times)) * 1000)
                    relative = [p - zero for p, zero in zip(latest, baseline)]
                    duty = 0 if now - min(times) >= .1 else round(1023 * (.2 + .8 * max(0, min(1, max(relative) / 30))))
                    if duty != last_duty or now - last_write >= .04:
                        await drive(duty)
                        last_duty, last_write = duty, now
                        writes += 1
            await drive(0, True)
            status = json.loads(await sensor.read_gatt_char(SENSOR_STATUS))
            print('Sensor status:', status, flush=True)
            assert (await read_motor())['duty'] == 0
        finally:
            await drive(0, True)
            await sensor.write_gatt_char(SENSOR_CONTROL, b'X', response=True)
        elapsed = time.perf_counter() - start
        rates = [count / elapsed for count in counts]
        assert not errors, errors[:5]
        assert gaps == [0]*4, gaps
        assert demo_flags == {not args.sensors}, demo_flags
        assert all(450 < rate < 520 for rate in rates), rates
        assert all(v == 0 for key in ('errors', 'full', 'dropped') for v in status[key]), status
        print(f'PASS {sum(counts)} samples; per-sensor Hz {[round(r,1) for r in rates]}; gaps={gaps}', flush=True)
        print(f'Motor updates {writes / elapsed:.1f} Hz; max oldest-sensor age {max_age:.1f} ms', flush=True)
        print('Absolute pressure ranges kPa:', list(zip(low, high)), flush=True)
        print('Motor:', await read_motor(), flush=True)
        # Stop on link loss, independent of laptop keepalive.
        await drive(205, True)
    async with BleakClient(devices['Tactile Vibration']) as motor:
        status = motor_status(await motor.read_gatt_char(MOTOR_STATUS))
        assert status['duty'] == 0, status
    print('PASS disconnect stops motor; both devices reconnect', flush=True)
    if args.capture:
        with open(args.capture, 'w') as file:
            json.dump(notified, file)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=float, default=30)
    parser.add_argument('--sensors', action='store_true')
    parser.add_argument('--capture')
    asyncio.run(main(parser.parse_args()))
