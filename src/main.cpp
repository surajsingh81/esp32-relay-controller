#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "secrets.h"

// Configuration
constexpr uint8_t RELAY1_PIN = 4;
constexpr uint8_t RELAY2_PIN = 5;
constexpr bool RELAY_ACTIVE_LOW = false;
constexpr uint32_t POLL_INTERVAL_MS = 3000;

bool relay1On = false;
bool relay2On = false;
uint32_t lastPollAt = 0;

static void setRelay(uint8_t pin, bool &state, bool turnOn, const char *name) {
  if (state == turnOn) {
    return;
  }

  state = turnOn;
  const uint8_t onLevel = RELAY_ACTIVE_LOW ? LOW : HIGH;
  const uint8_t offLevel = RELAY_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(pin, turnOn ? onLevel : offLevel);
  Serial.printf("%s turned %s\n", name, turnOn ? "ON" : "OFF");
}

static bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to Wi-Fi '%s'", WIFI_SSID);

  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 30000) {
    delay(500);
    Serial.print('.');
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWi-Fi connection failed; will retry.");
    return false;
  }

  Serial.printf("\nWi-Fi connected. IP address: %s\n",
                WiFi.localIP().toString().c_str());
  return true;
}

static void pollCloud() {
  WiFiClientSecure tlsClient;
  tlsClient.useBuiltinCACertBundle();

  HTTPClient https;
  https.setTimeout(5000);
  if (!https.begin(tlsClient, DEVICE_STATE_URL)) {
    Serial.println("Could not start HTTPS request.");
    return;
  }

  https.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  const int statusCode = https.GET();
  if (statusCode != HTTP_CODE_OK) {
    Serial.printf("Cloud poll failed (HTTP %d).\n", statusCode);
    https.end();
    return;
  }

  JsonDocument response;
  const DeserializationError error = deserializeJson(response, https.getStream());
  https.end();
  if (error) {
    Serial.printf("Invalid cloud response: %s\n", error.c_str());
    return;
  }

  JsonVariantConst relay1 = response["relay1"];
  JsonVariantConst relay2 = response["relay2"];
  if (!relay1.is<bool>() || !relay2.is<bool>()) {
    Serial.println("Cloud response is missing relay states.");
    return;
  }

  setRelay(RELAY1_PIN, relay1On, relay1.as<bool>(), "Relay 1");
  setRelay(RELAY2_PIN, relay2On, relay2.as<bool>(), "Relay 2");
}

// Setup
void setup() {
  Serial.begin(115200);

  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  // Set RELAY_ACTIVE_LOW to true for active-LOW relay modules.
  const uint8_t relayOffLevel = RELAY_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(RELAY1_PIN, relayOffLevel);
  digitalWrite(RELAY2_PIN, relayOffLevel);

  WiFi.mode(WIFI_STA);
  connectWiFi();
}

// Loop
void loop() {
  if (!connectWiFi()) {
    delay(1000);
    return;
  }

  const uint32_t now = millis();
  if (now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    pollCloud();
  }
}
