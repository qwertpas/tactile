#include <Arduino.h>
#include <Wire.h>
#include <esp_rom_crc.h>
#include <esp_timer.h>

constexpr int POWER = 8, CLOCK = 9, DATA = 10, RESET = 11, GROUND = 12;
constexpr uint8_t CHANNELS[] = {2, 6};
constexpr uint8_t ADDRESSES[] = {0x46, 0x47};

struct __attribute__((packed)) Header {
  char magic[4];
  uint16_t size;
  uint8_t sensor, count;
  uint32_t first;
  uint64_t time;
  uint32_t errors, full, dropped;
};
static_assert(sizeof(Header) == 32);
struct Packet { uint16_t size; uint8_t bytes[132]; };
QueueHandle_t packets;
bool streaming = false;
uint32_t samples[4] = {}, errors[4] = {}, full[4] = {}, dropped[4] = {};

bool selectChannel(uint8_t channel) {
  Wire.beginTransmission(0x70);
  Wire.write(1 << channel);
  return Wire.endTransmission() == 0;
}

bool writeReg(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readReg(uint8_t address, uint8_t reg, uint8_t *data, size_t size) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false)) return false;
  if (Wire.requestFrom(address, size) != size) return false;
  for (size_t i = 0; i < size; ++i) data[i] = Wire.read();
  return true;
}

bool configure() {
  xQueueReset(packets);
  for (int sensor = 0; sensor < 4; ++sensor) {
    samples[sensor] = errors[sensor] = full[sensor] = dropped[sensor] = 0;
    uint8_t address = ADDRESSES[sensor % 2];
    uint8_t id[2], status, settings[3];
    if (!selectChannel(CHANNELS[sensor / 2]) ||
        !readReg(address, 1, id, 2) || id[0] != 0x51 ||
        !readReg(address, 0x28, &status, 1) || (status & 0x0e) != 2 ||
        !writeReg(address, 0x37, 0x80)) return false;
    delay(4); // Finish any ongoing conversion before changing configuration.
    if (!writeReg(address, 0x18, 0) || // Flush FIFO.
        !writeReg(address, 0x36, 0x40) || // P+T, both OSR 1x.
        !writeReg(address, 0x31, 0) || // IIR bypass.
        !writeReg(address, 0x16, 0) || // Streaming FIFO.
        !writeReg(address, 0x18, 3) || // P+T FIFO, no decimation.
        !writeReg(address, 0x15, 2) || // Enable FIFO-full status.
        !writeReg(address, 0x37, 0x83) || // Continuous mode.
        !readReg(address, 0x36, settings, 3) ||
        settings[0] != 0x40 || settings[1] != 0x83) return false;
    Serial.printf("# sensor=%d channel=%d address=0x%02x id=0x%02x rev=0x%02x osr=0x%02x mode=0x%02x\n",
                  sensor, CHANNELS[sensor / 2], address, id[0], id[1], settings[0], settings[1]);
  }
  return true;
}

void sendUsb(void *) {
  Packet packet;
  for (;;) {
    if (xQueueReceive(packets, &packet, portMAX_DELAY) == pdTRUE && Serial) {
      size_t sent = 0;
      while (sent < packet.size && Serial) {
        size_t count = Serial.write(packet.bytes + sent, packet.size - sent);
        if (!count) { vTaskDelay(1); continue; }
        sent += count;
      }
    }
  }
}

void setup() {
  for (int pin = 9; pin <= 11; ++pin) pinMode(pin, INPUT);
  pinMode(GROUND, OUTPUT | INPUT); digitalWrite(GROUND, LOW);
  pinMode(POWER, OUTPUT | INPUT); digitalWrite(POWER, LOW);
  delay(100);
  digitalWrite(POWER, HIGH);
  delay(20);
  pinMode(RESET, OUTPUT_OPEN_DRAIN | INPUT);
  digitalWrite(RESET, LOW); delay(10);
  digitalWrite(RESET, HIGH); delay(10);
  Serial.setTxBufferSize(4096);
  Serial.setTxTimeoutMs(10);
  Serial.begin(115200); // Native USB; baud does not limit transfer speed.
  Wire.setBufferSize(128);
  Wire.begin(DATA, CLOCK, 400000);
  Wire.setTimeOut(10);
  packets = xQueueCreate(64, sizeof(Packet));
  if (!packets || xTaskCreatePinnedToCore(sendUsb, "usb", 4096, nullptr, 1, nullptr, 0) != pdPASS) {
    Serial.println("# ERROR USB queue/task allocation failed");
    for (;;) delay(1000);
  }
}

void loop() {
  while (Serial.available()) {
    int command = Serial.read();
    if (command == 's') {
      streaming = configure();
      Serial.println(streaming ? "# continuous P+T, 400kHz I2C" : "# ERROR sensor initialization failed");
    } else if (command == 'x') {
      streaming = false;
      xQueueReset(packets);
      for (uint8_t channel : CHANNELS) {
        if (selectChannel(channel)) for (uint8_t address : ADDRESSES) writeReg(address, 0x37, 0x80);
      }
    }
  }
  if (!streaming) { delay(1); return; }
  for (int pair = 0; pair < 2; ++pair) {
    if (!selectChannel(CHANNELS[pair])) {
      ++errors[pair * 2]; ++errors[pair * 2 + 1]; continue;
    }
    for (int side = 0; side < 2; ++side) {
      int sensor = pair * 2 + side;
      uint8_t address = ADDRESSES[side], count, status;
      if (!readReg(address, 0x27, &status, 1) || !readReg(address, 0x17, &count, 1)) {
        ++errors[sensor]; continue;
      }
      count &= 0x3f;
      if ((status & 2) || count == 16) ++full[sensor];
      if (!count) continue;
      if (count > 16) { ++errors[sensor]; continue; }
      Packet packet = {};
      packet.size = sizeof(Header) + count * 6 + 4;
      Header header = {{'B','M','P','1'}, packet.size, uint8_t(sensor), count,
                       samples[sensor], uint64_t(esp_timer_get_time()), errors[sensor], full[sensor], dropped[sensor]};
      memcpy(packet.bytes, &header, sizeof(header));
      if (!readReg(address, 0x29, packet.bytes + sizeof(header), count * 6)) {
        ++errors[sensor]; continue;
      }
      samples[sensor] += count;
      uint32_t crc = esp_rom_crc32_le(0, packet.bytes, packet.size - 4);
      memcpy(packet.bytes + packet.size - 4, &crc, 4);
      if (xQueueSend(packets, &packet, 0) != pdTRUE) dropped[sensor] += count;
    }
  }
  delay(4);
}
