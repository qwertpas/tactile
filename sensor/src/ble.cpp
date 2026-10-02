#include <Arduino.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include <esp_timer.h>
#include <atomic>
#include <cmath>
#include "../../ble/protocol.h"

constexpr int POWER = 8, CLOCK = 9, DATA = 10, RESET = 11, GROUND = 12;
constexpr uint8_t CHANNELS[] = {2, 6}, ADDRESSES[] = {0x46, 0x47};
NimBLECharacteristic *pressure, *status;
std::atomic<char> request{0};
std::atomic<bool> subscribed{false};
std::atomic<uint16_t> mtu{23}, interval{0};
bool streaming = false, demo = false;
uint8_t generation = 0;
uint32_t samples[4]{}, errors[4]{}, full[4]{}, dropped[4]{};
const char *message = "Ready";
char fault[128];
int64_t nextDemo = 0, demoStart = 0;
uint8_t notification[244];
size_t used = 0;
uint8_t pending[4]{};
uint8_t busError = 0;

bool selectChannel(uint8_t channel) {
  Wire.beginTransmission(0x70); Wire.write(1 << channel);
  busError = Wire.endTransmission();
  return busError == 0;
}
bool writeReg(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}
bool readReg(uint8_t address, uint8_t reg, uint8_t *data, size_t size) {
  Wire.beginTransmission(address); Wire.write(reg);
  if (Wire.endTransmission(false) || Wire.requestFrom(address, size) != size) return false;
  for (size_t i = 0; i < size; ++i) data[i] = Wire.read();
  return true;
}

void standby() {
  for (auto channel : CHANNELS)
    if (selectChannel(channel)) for (auto address : ADDRESSES) writeReg(address, 0x37, 0x80);
}

bool configure() {
  for (int sensor = 0; sensor < 4; ++sensor) {
    const uint8_t address = ADDRESSES[sensor % 2];
    uint8_t id[2], nvm, settings[2];
    auto fail = [sensor, address](const char *step, uint8_t value = 0) {
      snprintf(fault, sizeof(fault), "CH%u 0x%02x: %s (0x%02x)", CHANNELS[sensor / 2], address, step, value);
      message = fault;
      Serial.println(message);
      return false;
    };
    if (!selectChannel(CHANNELS[sensor / 2])) return fail("mux write failed", busError);
    if (!readReg(address, 1, id, 2)) return fail("chip ID read failed");
    if (id[0] != 0x51) return fail("unexpected chip ID", id[0]);
    if (!readReg(address, 0x28, &nvm, 1)) return fail("NVM status read failed");
    if ((nvm & 0x0e) != 2) return fail("NVM not ready", nvm);
    if (!writeReg(address, 0x37, 0x80)) return fail("standby write failed");
    delay(4);
    if (!writeReg(address, 0x18, 0) || !writeReg(address, 0x36, 0x40) ||
        !writeReg(address, 0x31, 0) || !writeReg(address, 0x16, 0) ||
        !writeReg(address, 0x18, 3) || !writeReg(address, 0x15, 2) ||
        !writeReg(address, 0x37, 0x83) || !readReg(address, 0x36, settings, 2) ||
        settings[0] != 0x40 || settings[1] != 0x83) return fail("configuration failed");
  }
  return true;
}

void updateStatus() {
  char text[640];
  snprintf(text, sizeof(text),
      "{\"generation\":%u,\"streaming\":%s,\"demo\":%s,\"message\":\"%s\",\"mtu\":%u,\"interval\":%u,"
      "\"samples\":[%lu,%lu,%lu,%lu],\"errors\":[%lu,%lu,%lu,%lu],"
      "\"full\":[%lu,%lu,%lu,%lu],\"dropped\":[%lu,%lu,%lu,%lu],\"pins\":[%d,%d,%d,%d,%d]}",
      generation, streaming ? "true" : "false", demo ? "true" : "false", message, mtu.load(), interval.load(),
      (unsigned long)samples[0], (unsigned long)samples[1], (unsigned long)samples[2], (unsigned long)samples[3],
      (unsigned long)errors[0], (unsigned long)errors[1], (unsigned long)errors[2], (unsigned long)errors[3],
      (unsigned long)full[0], (unsigned long)full[1], (unsigned long)full[2], (unsigned long)full[3],
      (unsigned long)dropped[0], (unsigned long)dropped[1], (unsigned long)dropped[2], (unsigned long)dropped[3],
      digitalRead(POWER), digitalRead(CLOCK), digitalRead(DATA), digitalRead(RESET), digitalRead(GROUND));
  status->setValue(text);
}

class Subscription : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, NimBLEConnInfo &, uint16_t value) override { subscribed = value & 1; }
};
class Commands : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    auto value = c->getValue();
    if (value.size() == 1 && (value[0] == 'S' || value[0] == 'D' || value[0] == 'X')) request = value[0];
  }
};
class Connections : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *server, NimBLEConnInfo &info) override {
    mtu = info.getMTU(); interval = info.getConnInterval();
    server->setDataLen(info.getConnHandle(), 251);
    server->updatePhy(info.getConnHandle(), BLE_GAP_LE_PHY_2M, BLE_GAP_LE_PHY_2M, 0);
    server->updateConnParams(info.getConnHandle(), 12, 12, 0, 200);
  }
  void onMTUChange(uint16_t value, NimBLEConnInfo &) override { mtu = value; }
  void onConnParamsUpdate(NimBLEConnInfo &info) override { interval = info.getConnInterval(); }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override { subscribed = false; request = 'X'; }
};

void flush() {
  if (!used) return;
  if (!pressure->notify(notification, used))
    for (int sensor = 0; sensor < 4; ++sensor) dropped[sensor] += pending[sensor];
  used = 0;
  memset(pending, 0, sizeof(pending));
}

void send(int sensor, uint8_t count, const uint8_t *raw, uint32_t time) {
  const int limit = min(16, (int(mtu.load()) - 3 - int(sizeof(PressureHeader))) / 3);
  for (int first = 0; first < count; first += limit) {
    const uint8_t n = min(int(count) - first, limit);
    uint8_t bytes[64];
    PressureHeader header{1, uint8_t(sensor), n, uint8_t((generation << 2) | (demo ? 1 : 0) | (full[sensor] ? 2 : 0)),
                          samples[sensor], time, uint16_t(errors[sensor]), uint16_t(dropped[sensor])};
    memcpy(bytes, &header, sizeof(header));
    memcpy(bytes + sizeof(header), raw + first * 3, n * 3);
    samples[sensor] += n;
    const size_t size = sizeof(header) + n * 3;
    if (used + size > min(size_t(mtu.load() - 3), sizeof(notification))) flush();
    memcpy(notification + used, bytes, size);
    used += size;
    pending[sensor] += n;
  }
}

void setup() {
  for (int pin = 9; pin <= 11; ++pin) pinMode(pin, INPUT);
  pinMode(GROUND, OUTPUT | INPUT); digitalWrite(GROUND, LOW);
  pinMode(POWER, OUTPUT | INPUT); digitalWrite(POWER, LOW);
  delay(100); digitalWrite(POWER, HIGH); delay(20);
  pinMode(RESET, OUTPUT_OPEN_DRAIN | INPUT);
  digitalWrite(RESET, LOW); delay(10); digitalWrite(RESET, HIGH); delay(10);
  Serial.begin(115200);
  Wire.setBufferSize(128); Wire.begin(DATA, CLOCK, 400000); Wire.setTimeOut(10);
  NimBLEDevice::init("Tactile Pressure"); NimBLEDevice::setMTU(247);
  auto *server = NimBLEDevice::createServer();
  server->setCallbacks(new Connections); server->advertiseOnDisconnect(true);
  auto *service = server->createService(SENSOR_SERVICE);
  pressure = service->createCharacteristic(PRESSURE_CHAR, NIMBLE_PROPERTY::NOTIFY);
  pressure->setCallbacks(new Subscription);
  auto *control = service->createCharacteristic(SENSOR_CONTROL, NIMBLE_PROPERTY::WRITE);
  control->setCallbacks(new Commands);
  status = service->createCharacteristic(SENSOR_STATUS, NIMBLE_PROPERTY::READ);
  updateStatus(); service->start();
  auto *advertising = NimBLEDevice::getAdvertising();
  advertising->enableScanResponse(true);
  advertising->addServiceUUID(SENSOR_SERVICE); advertising->setName("Tactile Pressure");
  advertising->setPreferredParams(12, 12);
  if (!advertising->start()) { Serial.println("ERROR BLE advertising failed"); for (;;) delay(1000); }
  Serial.println("Tactile Pressure BLE ready; GPIO8=3V3 9=SCL 10=SDA 11=RST 12=GND");
}

void loop() {
  if (const char command = request.exchange(0)) {
    streaming = false;
    if (!demo) standby();
    demo = command == 'D';
    if (command != 'X') {
      generation = (generation + 1) & 63;
      memset(samples, 0, sizeof(samples)); memset(errors, 0, sizeof(errors));
      memset(full, 0, sizeof(full)); memset(dropped, 0, sizeof(dropped));
      streaming = subscribed.load() && (demo || configure());
      if (!streaming && !demo) standby();
      if (streaming) message = demo ? "Test stream" : "Sensors running";
      nextDemo = demoStart = esp_timer_get_time();
    } else message = "Stopped";
    updateStatus();
  }
  static uint32_t statusTime = 0;
  if (millis() - statusTime >= 100) { statusTime = millis(); updateStatus(); }
  if (!streaming || !subscribed.load()) { delay(1); return; }
  // Two sends per radio interval preserve every sample without filling the BLE queue.
  // Read the hardware FIFO immediately before sending; never average pressure values.
  static int64_t poll = 0;
  const int64_t now = esp_timer_get_time();
  const int64_t period = max(2000, int(interval.load()) * 1250 / 2);
  if (now - poll < period) { delay(1); return; }
  poll = now;
  if (demo) {
    const auto now = esp_timer_get_time();
    if (now < nextDemo) { delay(1); return; }
    const uint8_t count = min(int64_t(16), (now - nextDemo) / 2000 + 1);
    for (int sensor = 0; sensor < 4; ++sensor) {
      uint8_t raw[48];
      for (int i = 0; i < count; ++i) {
        const double t = (nextDemo + i * 2000 - demoStart) / 1e6;
        const float relative = 15000 * (1 - cos(2 * PI * (0.7 + sensor * 0.3) * t));
        const uint32_t value = lroundf((100000 + relative) * 64);
        for (int b = 0; b < 3; ++b) raw[i * 3 + b] = value >> (8 * b);
      }
      send(sensor, count, raw, uint32_t(now));
    }
    nextDemo += count * 2000;
  } else {
    for (int pair = 0; pair < 2; ++pair) {
      if (!selectChannel(CHANNELS[pair])) { ++errors[pair * 2]; ++errors[pair * 2 + 1]; continue; }
      for (int side = 0; side < 2; ++side) {
        const int sensor = pair * 2 + side;
        uint8_t count, flags, frames[96], raw[48];
        const uint8_t address = ADDRESSES[side];
        if (!readReg(address, 0x27, &flags, 1) || !readReg(address, 0x17, &count, 1)) { ++errors[sensor]; continue; }
        count &= 0x3f;
        if ((flags & 2) || count == 16) ++full[sensor];
        if (!count) continue;
        if (count > 16) { ++errors[sensor]; continue; }
        const uint32_t time = esp_timer_get_time();
        if (!readReg(address, 0x29, frames, count * 6)) { ++errors[sensor]; continue; }
        for (int i = 0; i < count; ++i) memcpy(raw + i * 3, frames + i * 6 + 3, 3);
        send(sensor, count, raw, time);
      }
    }
  }
  flush();
  delay(1);
}
