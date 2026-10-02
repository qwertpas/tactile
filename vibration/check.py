#!/usr/bin/env python3.11
"""Exercise firmware over USB at 20% duty. Close the GUI before running."""
import argparse
import json
import time

import serial


def command(port, text):
    port.write((text + '\n').encode())
    end = time.monotonic() + 2
    while time.monotonic() < end:
        line = port.readline().decode(errors='replace').strip()
        if line.startswith('ERR'):
            return line
        if line.startswith('{'):
            result = json.loads(line)
            assert result['device'] == 'vibration-v1', result
            return result
    raise RuntimeError(f'No response to {text}')


def check(port):
    command(port, 'STOP')
    time.sleep(0.02)
    assert command(port, 'STATUS')['duty'] == 0
    for wave in ('constant', 'square', 'sine'):
        for frequency in (0, 0.5, 10, 100, 500):
            reply = command(port, f'SET {wave} 20 {frequency} 1')
            assert reply['running'] and reply['wave'] == wave, reply
            duration = 2.1 if frequency == 0.5 and wave != 'constant' else 0.3
            start = time.monotonic()
            while time.monotonic() - start < duration:
                time.sleep(0.1)
                reply = command(port, 'PING')
                assert reply['running'], reply
            assert reply['amplitude'] == 20 and reply['frequency'] == frequency, reply
            if frequency == 0 or wave == 'constant':
                assert reply['min'] == reply['max'] == 205, reply
            else:
                assert reply['min'] <= 1 and reply['max'] >= 203, reply
            rate = reply['samples'] / (time.monotonic() - start)
            assert 9000 < rate < 11000, (rate, reply)
            print(f'{wave:8} {frequency:5g} Hz: duty {reply["min"]}–{reply["max"]}/1023, '
                  f'{rate:.0f} updates/s, max gap {reply["max_gap_us"]} us')
    for amplitude in (0, 5, 20):
        command(port, f'SET constant {amplitude} 0 1')
        time.sleep(0.02)
        reply = command(port, 'PING')
        assert abs(reply['duty'] - 1023 * amplitude / 100) <= 0.5, reply
    # Rapid settings must not restart the sine at zero on every update.
    duties = []
    start = time.monotonic()
    while time.monotonic() - start < 1.2:
        reply = command(port, 'SET sine 20 5 1')
        duties.append(reply['duty'])
        time.sleep(0.005)
    rate = len(duties) / (time.monotonic() - start)
    assert rate >= 100 and min(duties) <= 2 and max(duties) >= 203, (rate, min(duties), max(duties))
    print(f'Live settings: {rate:.0f} updates/s; sine continues through duty {min(duties)}–{max(duties)}/1023')
    for text in ('SET sine -1 10 1', 'SET sine 101 10 1', 'SET sine 20 501 1',
                 'SET sine 20 -1 1', 'SET sine nan 10 1', 'SET sine 20 inf 1',
                 'SET sine 20 10 2', 'SET unknown 20 10 1', 'SET sine 20 10 1 extra',
                 'a' * 200):
        assert str(command(port, text)).startswith('ERR'), text
    command(port, 'SET sine 100 500 0')
    time.sleep(0.02)
    assert command(port, 'STATUS')['duty'] == 0
    command(port, 'SET constant 20 0 1')
    time.sleep(2.2)  # STATUS must not renew the motor heartbeat.
    reply = command(port, 'STATUS')
    assert not reply['running'] and reply['duty'] == 0, reply
    command(port, 'PING')
    assert not command(port, 'STATUS')['running'], 'PING restarted an expired motor'
    command(port, 'SET constant 20 0 1')
    command(port, 'STOP')
    time.sleep(0.02)
    reply = command(port, 'STATUS')
    assert not reply['running'] and reply['duty'] == 0, reply
    print('PASS: waveforms, amplitude, 0–500 Hz, invalid commands, STOP, heartbeat expiry.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    args = parser.parse_args()
    with serial.Serial(args.port, 115200, timeout=0.2, write_timeout=1, exclusive=True) as port:
        port.reset_input_buffer()
        try:
            check(port)
        finally:
            command(port, 'STOP')
