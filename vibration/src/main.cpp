#include <Arduino.h>
#include <esp_timer.h>
#include <cmath>

constexpr uint8_t IN4 = D9;   // GPIO8: held low (coast during PWM off).
constexpr uint8_t IN3 = D10;  // GPIO9: PWM.
constexpr uint32_t PWM_HZ = 20000;
constexpr uint16_t PWM_MAX = 1023;
constexpr int64_t TIMEOUT_US = 2000000;
enum Wave { CONSTANT, SQUARE, SINE };
const char *names[] = {"constant", "square", "sine"};

struct Settings {
  Wave wave = CONSTANT;
  float amplitude = 0;
  float frequency = 0;
  bool running = false;
  int64_t start = 0;
  int64_t heartbeat = 0;
  uint32_t version = 0;
  double phase = 0;
};
struct Output {
  uint16_t duty = 0;
  uint16_t low = PWM_MAX;
  uint16_t high = 0;
  uint32_t samples = 0;
  uint32_t max_gap_us = 0;
};
Settings settings;
Output output;
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;

void update(void *) {
  static uint32_t version = UINT32_MAX;
  static int64_t previous = 0;
  const int64_t now = esp_timer_get_time();
  portENTER_CRITICAL(&lock);
  if (settings.running && now - settings.heartbeat > TIMEOUT_US)
    settings.running = false;
  const Settings current = settings;
  portEXIT_CRITICAL(&lock);

  float level = 1;
  if (current.frequency > 0 && current.wave != CONSTANT) {
    const double cycles = current.phase + (now - current.start) * current.frequency / 1e6;
    const float phase = cycles - floor(cycles);
    level = current.wave == SQUARE ? (phase < 0.5f ? 1.f : 0.f)
                                  : 0.5f - 0.5f * cosf(2.f * PI * phase);
  }
  const uint16_t duty = current.running
      ? lroundf(PWM_MAX * current.amplitude * level / 100.f) : 0;
  ledcWrite(IN3, duty);
  portENTER_CRITICAL(&lock);
  if (version != current.version) {
    output = Output{};
    version = current.version;
    previous = now;
  }
  output.duty = duty;
  output.low = min(output.low, duty);
  output.high = max(output.high, duty);
  output.samples++;
  output.max_gap_us = max(output.max_gap_us, uint32_t(now - previous));
  portEXIT_CRITICAL(&lock);
  previous = now;
}

void status() {
  portENTER_CRITICAL(&lock);
  const Settings current = settings;
  const Output measured = output;
  portEXIT_CRITICAL(&lock);
  Serial.printf("{\"device\":\"vibration-v1\",\"wave\":\"%s\","
                "\"amplitude\":%.3f,\"frequency\":%.3f,\"running\":%s,"
                "\"duty\":%u,\"min\":%u,\"max\":%u,\"samples\":%lu,"
                "\"max_gap_us\":%lu,\"pwm_hz\":%lu}\n",
                names[current.wave], current.amplitude, current.frequency,
                current.running ? "true" : "false", measured.duty,
                measured.low, measured.high, (unsigned long)measured.samples,
                (unsigned long)measured.max_gap_us, (unsigned long)PWM_HZ);
}

void command(const char *line) {
  if (!strcmp(line, "STATUS")) {
    status();
    return;
  }
  if (!strcmp(line, "PING")) {
    portENTER_CRITICAL(&lock);
    settings.heartbeat = esp_timer_get_time();
    portEXIT_CRITICAL(&lock);
    status();
    return;
  }
  if (!strcmp(line, "STOP")) {
    portENTER_CRITICAL(&lock);
    settings.running = false;
    settings.version++;
    portEXIT_CRITICAL(&lock);
    status();
    return;
  }
  char wave[16], extra;
  float amplitude, frequency;
  int running;
  if (sscanf(line, "SET %15s %f %f %d %c", wave, &amplitude, &frequency,
             &running, &extra) != 4 || !std::isfinite(amplitude) ||
      !std::isfinite(frequency) || amplitude < 0 || amplitude > 100 ||
      frequency < 0 || frequency > 500 || (running != 0 && running != 1)) {
    Serial.println("ERR Expected SET constant|square|sine amplitude(0-100) frequency(0-500) running(0|1)");
    return;
  }
  int mode = 0;
  while (mode < 3 && strcmp(wave, names[mode])) mode++;
  if (mode == 3) {
    Serial.println("ERR Unknown waveform");
    return;
  }
  const int64_t now = esp_timer_get_time();
  portENTER_CRITICAL(&lock);
  double phase = 0;
  if (settings.running && running && settings.wave != CONSTANT && mode != CONSTANT) {
    phase = settings.phase + (now - settings.start) * settings.frequency / 1e6;
    phase -= floor(phase);
  }
  settings = {Wave(mode), amplitude, frequency, bool(running), now, now,
              settings.version + 1, phase};
  portEXIT_CRITICAL(&lock);
  status();
}

void setup() {
  pinMode(IN4, OUTPUT);
  digitalWrite(IN4, LOW);
  pinMode(IN3, OUTPUT);
  digitalWrite(IN3, LOW);
  Serial.begin(115200);
  if (!ledcAttach(IN3, PWM_HZ, 10)) {
    Serial.println("ERR PWM initialization failed");
    while (true) delay(1000);
  }
  ledcWrite(IN3, 0);
  esp_timer_handle_t timer;
  esp_timer_create_args_t args{};
  args.callback = update;
  args.name = "wave";
  args.skip_unhandled_events = true;
  ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
  ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 100));  // 10 kHz envelope.
}

void loop() {
  static char line[128];
  static size_t used = 0;
  static bool overflow = false;
  while (Serial.available()) {
    const char c = Serial.read();
    if (c == '\n') {
      line[used] = 0;
      if (overflow) Serial.println("ERR Command too long");
      else command(line);
      Serial.flush();  // Complete native USB replies before accepting another command.
      used = 0;
      overflow = false;
    } else if (c != '\r') {
      if (used < sizeof(line) - 1) line[used++] = c;
      else overflow = true;
    }
  }
  delay(1);
}
