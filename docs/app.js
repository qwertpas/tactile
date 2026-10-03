import { ids, colors, scale, decodeBatch, Pressures, motorDuty, MotorWriter } from './pressure.js';

const $ = id => document.getElementById(id);
const pressures = new Pressures();
let generation = null;
let sensorDevice, sensorControl, sensorStatus, sensorCharacteristic;
let motorDevice, motorControl, writer;
let audio, player, soundEnabled = false, hapticEnabled = false, switching = false;
let malformed = 0, motorDutyValue = 0, motorCommands = 0, motorInterval = 0;
let rateTime = performance.now(), rateCounts = [0, 0, 0, 0], rates = [0, 0, 0, 0];
let sensorBusy = false, motorBusy = false;

function error(value) { $('error').textContent = value.message || String(value); $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function supported() {
  if (!navigator.bluetooth) throw Error('Open this page in Chrome or Edge with Bluetooth enabled. Web Bluetooth requires HTTPS or localhost.');
}
function fresh() { return !switching && pressures.fresh(performance.now()) && !document.hidden; }
function output() {
  const valid = fresh();
  if (player) player.port.postMessage(valid ? { pressures: [...pressures.values] } : { stale: true });
  if (hapticEnabled && writer) writer.set(valid ? motorDuty(pressures.values) : 0);
}
function stopHaptics() {
  hapticEnabled = false;
  $('haptic').textContent = 'Start haptics'; $('haptic').classList.remove('danger');
  return writer?.set(0);
}
function motorLost() {
  stopHaptics(); writer = null; motorControl = null; motorDevice = null;
  motorDutyValue = 0; $('motorState').textContent = 'XIAO · disconnected';
  $('motorConnect').textContent = 'Connect vibration';
}
function sensorLost() {
  stopHaptics(); sensorControl = null; sensorStatus = null; sensorCharacteristic = null; sensorDevice = null;
  generation = null; pressures.reset(); rates.fill(0); rateCounts.fill(0); rateTime = performance.now(); output(); $('sensorState').textContent = 'SuperMini · disconnected';
  $('sensorConnect').textContent = 'Connect pressures';
}

async function connectSensors() {
  if (sensorBusy) return;
  if (sensorDevice?.gatt.connected) { sensorDevice.gatt.disconnect(); return; }
  sensorBusy = true;
  try {
    supported(); clearError();
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [ids.sensor] }] });
    sensorDevice = device; device.addEventListener('gattserverdisconnected', sensorLost);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(ids.sensor);
    sensorCharacteristic = await service.getCharacteristic(ids.pressure);
    sensorControl = await service.getCharacteristic(ids.sensorControl);
    sensorStatus = await service.getCharacteristic(ids.sensorStatus);
    sensorCharacteristic.addEventListener('characteristicvaluechanged', ({ target }) => {
      try {
        const now = performance.now();
        for (const packet of decodeBatch(target.value)) {
          if (packet.generation === generation) pressures.ingest(packet, now);
        }
        output();
      }
      catch (e) { ++malformed; error(e); stopHaptics(); }
    });
    await sensorCharacteristic.startNotifications();
    $('sensorConnect').textContent = 'Disconnect pressures';
    $('sensorState').textContent = 'SuperMini · connected';
    await startStream('S');
  } catch (e) { error(e); sensorDevice?.gatt.disconnect(); if (!sensorDevice?.gatt.connected) sensorLost(); }
  finally { sensorBusy = false; }
}

async function startStream(command) {
  if (!sensorControl || switching) return;
  switching = true; generation = null; stopHaptics(); pressures.reset(); output();
  rateCounts = [0, 0, 0, 0]; rates = [0, 0, 0, 0]; rateTime = performance.now();
  try {
    await sensorControl.writeValueWithResponse(new TextEncoder().encode(command));
    // Configuration happens on the sensor loop; read after it has finished.
    await new Promise(resolve => setTimeout(resolve, 200));
    const view = await sensorStatus.readValue();
    const state = JSON.parse(new TextDecoder().decode(view));
    if (!state.streaming) {
      $('sensorState').textContent = 'SuperMini · sensors stopped';
      throw Error(state.message);
    }
    generation = state.generation;
    clearError(); $('sensorState').textContent = `SuperMini · ${state.demo ? 'BLE test stream' : 'sensors running'} · ${(state.interval * 1.25).toFixed(1)} ms interval`;
  } catch (e) { error(e); }
  finally { switching = false; output(); }
}

async function connectMotor() {
  if (motorBusy) return;
  if (motorDevice?.gatt.connected) { await stopHaptics(); motorDevice.gatt.disconnect(); return; }
  motorBusy = true;
  try {
    supported(); clearError();
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [ids.motor] }] });
    motorDevice = device; device.addEventListener('gattserverdisconnected', motorLost);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(ids.motor);
    motorControl = await service.getCharacteristic(ids.motorControl);
    const status = await service.getCharacteristic(ids.motorStatus);
    const read = view => {
      if (view.byteLength !== 16) { error('Invalid motor status'); return; }
      motorCommands = view.getUint32(8, true); motorDutyValue = view.getUint16(12, true);
      motorInterval = view.getUint16(14, true) * 1.25;
    };
    status.addEventListener('characteristicvaluechanged', ({ target }) => read(target.value));
    await status.startNotifications(); read(await status.readValue());
    const control = motorControl;
    writer = new MotorWriter(packet => control.writeValueWithoutResponse(packet), e => {
      error(e); hapticEnabled = false; device.gatt.disconnect();
    });
    await writer.set(0);
    $('motorConnect').textContent = 'Disconnect vibration'; $('motorState').textContent = 'XIAO · connected';
  } catch (e) { error(e); motorDevice?.gatt.disconnect(); motorLost(); }
  finally { motorBusy = false; }
}

async function toggleSound() {
  try {
    if (!audio) {
      audio = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      await audio.audioWorklet.addModule(new URL('./audio.js?v=4', import.meta.url));
      const vowels = await Promise.all(['ah', 'ee', 'oh', 'oo'].map(async vowel => {
        const response = await fetch(new URL(`./vowels/${vowel}.wav?v=4`, import.meta.url));
        if (!response.ok) throw Error(`Could not load the ${vowel} recording.`);
        const buffer = await audio.decodeAudioData(await response.arrayBuffer());
        return buffer.getChannelData(0);
      }));
      player = new AudioWorkletNode(audio, 'pressure-audio', { outputChannelCount: [2], processorOptions: { vowels } });
      player.connect(audio.destination);
      controls();
    }
    await audio.resume(); soundEnabled = !soundEnabled;
    player.port.postMessage({ enabled: soundEnabled }); output();
    $('sound').textContent = soundEnabled ? 'Stop sound' : 'Start sound';
    $('sound').classList.toggle('active', soundEnabled);
  } catch (e) { error(e); }
}
function controls() {
  $('volumeValue').textContent = `${$('volume').value}%`;
  player?.port.postMessage({ volume: Number($('volume').value) / 100, mode: $('mode').selectedIndex });
  $('soundInfo').textContent = [
    'Four noise pitches: 220, 660, 1980, 5940 Hz. Each pressure controls its voice.',
    'Four continuous vowels: ah, ee, oh, oo, synthesized from human vocal cycles. Each pressure controls only volume.',
    'Four rhythms: 2, 3, 5, 7 pulses/second. Each pressure controls its rhythm.',
    'Low left, low right, high left, high right. Each pressure controls its position.',
    'Four pure sine tones: 220, 660, 1980, 5940 Hz. Each pressure controls only volume.',
  ][$('mode').selectedIndex];
}

$('sensorConnect').onclick = connectSensors;
$('motorConnect').onclick = connectMotor;
$('restart').onclick = () => startStream('S');
$('demo').onclick = () => startStream('D');
$('zero').onclick = () => { if (pressures.zero()) output(); };
$('sound').onclick = toggleSound;
$('volume').oninput = controls; $('mode').onchange = controls;
$('haptic').onclick = () => {
  if (hapticEnabled) { stopHaptics(); return; }
  if (!writer || !fresh()) return;
  hapticEnabled = true; $('haptic').textContent = 'Stop haptics'; $('haptic').classList.add('danger'); output();
};
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopHaptics(); output(); } });
window.addEventListener('pagehide', () => { stopHaptics(); sensorDevice?.gatt.disconnect(); motorDevice?.gatt.disconnect(); });

setInterval(() => {
  if (hapticEnabled && !fresh()) { stopHaptics(); }
  else if (hapticEnabled) output(); // Refresh the firmware watchdog when pressure is unchanged.
  if (!fresh()) player?.port.postMessage({ stale: true });
}, 50);

function draw(now) {
  const canvas = $('plot'), context = canvas.getContext('2d');
  const width = canvas.clientWidth, height = canvas.clientHeight, ratio = devicePixelRatio;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  const left = 50, right = width - 18, top = 20, bottom = height - 30;
  const x = t => left + (t - now + 10000) / 10000 * (right - left);
  const y = p => bottom - (p + 2) / 34 * (bottom - top);
  context.font = '12px system-ui'; context.lineWidth = 1;
  for (let pressure = 0; pressure <= 30; pressure += 10) {
    context.strokeStyle = '#293549'; context.beginPath(); context.moveTo(left, y(pressure)); context.lineTo(right, y(pressure)); context.stroke();
    context.fillStyle = '#95a3b7'; context.fillText(String(pressure), 17, y(pressure) + 4);
  }
  context.fillText('kPa', 12, 15);
  for (let seconds = -10; seconds <= 0; seconds += 2) {
    context.fillText(`${seconds}s`, x(now + seconds * 1000) - 10, height - 9);
  }
  context.save(); context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip();
  for (let sensor = 0; sensor < 4; ++sensor) {
    context.strokeStyle = colors[sensor]; context.lineWidth = 1.5; context.beginPath();
    let started = false, previous = -Infinity;
    for (const [time, pressure] of pressures.history[sensor]) {
      if (time < now - 10000) continue;
      if (!started || time - previous > 100) { context.moveTo(x(time), y(pressure)); started = true; }
      else context.lineTo(x(time), y(pressure));
      previous = time;
    }
    context.stroke();
  }
  context.restore();
}

function render(now) {
  draw(now);
  const valid = fresh();
  $('zero').disabled = !valid;
  $('sound').disabled = !valid && !soundEnabled;
  $('haptic').disabled = !hapticEnabled && !(valid && writer);
  $('restart').disabled = !sensorControl || switching; $('demo').disabled = !sensorControl || switching;
  $('sensorConnect').disabled = sensorBusy; $('motorConnect').disabled = motorBusy;
  if (now - rateTime >= 1000) {
    rates = pressures.counts.map((count, i) => (count - rateCounts[i]) * 1000 / (now - rateTime));
    rateCounts = [...pressures.counts]; rateTime = now;
  }
  for (let i = 0; i < 4; ++i) {
    $(`p${i}`).textContent = pressures.zeroed ? `${pressures.values[i].toFixed(2)} kPa` : '—';
    $(`rate${i}`).textContent = `${rates[i].toFixed(0)} Hz`;
    const level = scale(pressures.values[i]);
    $(`p${i}`).parentElement.style.backgroundColor = valid ? `hsl(${220 * (1 - level)} 70% ${20 + 22 * level}%)` : '#18212d';
  }
  $('heatState').textContent = valid ? 'Live' : pressures.zeroed ? 'Stale' : 'Waiting for data';
  $('streamState').textContent = pressures.demo ? (valid ? 'BLE TEST STREAM' : 'TEST STREAM · stale') : (valid ? 'Live pressures' : (sensorControl ? 'Waiting for pressures' : 'Disconnected'));
  $('baseline').textContent = pressures.zeroed ? `Zero: ${pressures.baseline.map(p => p.toFixed(2)).join(' / ')} kPa absolute` : 'Release sensors before zeroing.';
  $('duty').textContent = `${(motorDutyValue / 1023 * 100).toFixed(1)}%`;
  $('motorInfo').textContent = writer ? `${motorCommands} commands · ${motorInterval.toFixed(1)} ms BLE interval${hapticEnabled ? '' : ' · stopped'}` : 'Motor stopped';
  $('audioInfo').textContent = audio ? `${audio.sampleRate / 1000} kHz · 128-frame blocks · ${(audio.baseLatency * 1000).toFixed(1)} ms base${Number.isFinite(audio.outputLatency) ? ` + ${(audio.outputLatency * 1000).toFixed(1)} ms output` : ''}` : 'Audio stopped';
  const age = Math.max(...pressures.stamps.map(stamp => now - stamp));
  $('stats').textContent = `${pressures.counts.reduce((a, b) => a + b, 0)} samples · ${Number.isFinite(age) ? age.toFixed(0) : '—'} ms oldest sensor · ${pressures.gaps.reduce((a, b) => a + b, 0)} gaps · ${pressures.faults.reduce((a, b) => a + b, 0) + malformed} faults`;
  requestAnimationFrame(render);
}
controls(); requestAnimationFrame(render);
