#pragma once
#include <cstdint>

constexpr char SENSOR_SERVICE[] = "89c10001-6b3a-4c2d-a155-7b9865500001";
constexpr char PRESSURE_CHAR[] = "89c10002-6b3a-4c2d-a155-7b9865500001";
constexpr char SENSOR_CONTROL[] = "89c10003-6b3a-4c2d-a155-7b9865500001";
constexpr char SENSOR_STATUS[] = "89c10004-6b3a-4c2d-a155-7b9865500001";
constexpr char MOTOR_SERVICE[] = "89c10011-6b3a-4c2d-a155-7b9865500001";
constexpr char MOTOR_CONTROL[] = "89c10012-6b3a-4c2d-a155-7b9865500001";
constexpr char MOTOR_STATUS[] = "89c10013-6b3a-4c2d-a155-7b9865500001";

struct __attribute__((packed)) PressureHeader {
  uint8_t version, sensor, count, flags; // flags: 1=test, 2=FIFO full observed.
  uint32_t sequence, time; // First sequence; FIFO readout time in microseconds.
  uint16_t errors, dropped;
};
struct __attribute__((packed)) MotorCommand {
  uint16_t duty; // 0..1023; constant 20 kHz PWM, never waveform modulation.
  uint32_t sequence;
};
struct __attribute__((packed)) MotorStatus {
  uint32_t sequence, time, commands;
  uint16_t duty, interval; // BLE interval in 1.25 ms units.
};
static_assert(sizeof(PressureHeader) == 16);
static_assert(sizeof(MotorCommand) == 6);
static_assert(sizeof(MotorStatus) == 16);
