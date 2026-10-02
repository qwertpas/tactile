#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_timer.h>
#include "../../ble/protocol.h"

constexpr uint8_t IN4 = D9, IN3 = D10;
constexpr int64_t TIMEOUT_US = 250000;
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
MotorStatus state{};
int64_t lastCommand = 0;
NimBLECharacteristic *status;

void stop() {
  portENTER_CRITICAL(&lock);
  state.duty = 0;
  ledcWrite(IN3, 0);
  portEXIT_CRITICAL(&lock);
}

class Commands : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    auto value = c->getValue();
    if (value.size() != sizeof(MotorCommand)) return;
    MotorCommand command;
    memcpy(&command, value.data(), sizeof(command));
    if (command.duty > 1023) return;
    const auto now = esp_timer_get_time();
    portENTER_CRITICAL(&lock);
    state.sequence = command.sequence;
    state.time = uint32_t(now);
    state.commands++;
    state.duty = command.duty;
    lastCommand = now;
    ledcWrite(IN3, command.duty);
    portEXIT_CRITICAL(&lock);
  }
};

class ReadStatus : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    portENTER_CRITICAL(&lock);
    const MotorStatus current = state;
    portEXIT_CRITICAL(&lock);
    c->setValue(reinterpret_cast<const uint8_t *>(&current), sizeof(current));
  }
};

class Connections : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *server, NimBLEConnInfo &info) override {
    server->setDataLen(info.getConnHandle(), 251);
    server->updatePhy(info.getConnHandle(), BLE_GAP_LE_PHY_2M, BLE_GAP_LE_PHY_2M, 0);
    server->updateConnParams(info.getConnHandle(), 12, 12, 0, 200);
  }
  void onConnParamsUpdate(NimBLEConnInfo &info) override {
    portENTER_CRITICAL(&lock);
    state.interval = info.getConnInterval();
    portEXIT_CRITICAL(&lock);
  }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override { stop(); }
};

void watchdog(void *) {
  portENTER_CRITICAL(&lock);
  if (state.duty && esp_timer_get_time() - lastCommand > TIMEOUT_US) {
    state.duty = 0;
    ledcWrite(IN3, 0);
  }
  portEXIT_CRITICAL(&lock);
}

void setup() {
  pinMode(IN4, OUTPUT); digitalWrite(IN4, LOW);
  pinMode(IN3, OUTPUT); digitalWrite(IN3, LOW);
  Serial.begin(115200);
  if (!ledcAttach(IN3, 20000, 10)) for (;;) delay(1000);
  ledcWrite(IN3, 0);
  esp_timer_handle_t timer;
  esp_timer_create_args_t args{};
  args.callback = watchdog;
  args.name = "stop";
  args.skip_unhandled_events = true;
  ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
  ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1000));
  NimBLEDevice::init("Tactile Vibration");
  NimBLEDevice::setMTU(247);
  auto *server = NimBLEDevice::createServer();
  server->setCallbacks(new Connections);
  server->advertiseOnDisconnect(true);
  auto *service = server->createService(MOTOR_SERVICE);
  auto *control = service->createCharacteristic(MOTOR_CONTROL, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  control->setCallbacks(new Commands);
  status = service->createCharacteristic(MOTOR_STATUS, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  status->setCallbacks(new ReadStatus);
  status->setValue(reinterpret_cast<const uint8_t *>(&state), sizeof(state));
  service->start();
  auto *advertising = NimBLEDevice::getAdvertising();
  advertising->enableScanResponse(true);
  advertising->addServiceUUID(MOTOR_SERVICE);
  advertising->setName("Tactile Vibration");
  advertising->setPreferredParams(12, 12);
  if (!advertising->start()) { Serial.println("ERROR BLE advertising failed"); for (;;) delay(1000); }
  Serial.println("Tactile Vibration BLE ready; D9=GPIO8 low, D10=GPIO9 PWM");
}

void loop() {
  static uint32_t previous = 0;
  if (millis() - previous >= 100) {
    previous = millis();
    portENTER_CRITICAL(&lock);
    const MotorStatus current = state;
    portEXIT_CRITICAL(&lock);
    status->setValue(reinterpret_cast<const uint8_t *>(&current), sizeof(current));
    if (NimBLEDevice::getServer()->getConnectedCount()) status->notify();
  }
  delay(1);
}
