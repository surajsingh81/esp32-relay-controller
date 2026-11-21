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

static const char *wifiStatusName(wl_status_t status) {
  switch (status) {
  case WL_IDLE_STATUS:
    return "idle";
  case WL_NO_SSID_AVAIL:
    return "SSID not found";
  case WL_CONNECTED:
    return "connected";
  case WL_CONNECT_FAILED:
    return "connection failed";
  case WL_CONNECTION_LOST:
    return "connection lost";
  case WL_DISCONNECTED:
    return "disconnected";
  default:
    return "unknown";
  }
}

static void setRelay(uint8_t pin, bool &state, bool turnOn, const char *name) {
  if (state == turnOn) {
    return;
  }

  state = turnOn;
  const uint8_t onLevel = RELAY_ACTIVE_LOW ? LOW : HIGH;
  const uint8_t offLevel = RELAY_ACTIVE_LOW ? HIGH : LOW;
  const uint8_t outputLevel = turnOn ? onLevel : offLevel;
  digitalWrite(pin, outputLevel);
  Serial.printf("%s command applied: %s, GPIO %u set %s\n", name,
                turnOn ? "ON" : "OFF", pin,
                outputLevel == HIGH ? "HIGH" : "LOW");
}

static bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to Wi-Fi '%s'...\n", WIFI_SSID);

  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 30000) {
    delay(500);
    const wl_status_t status = WiFi.status();
    Serial.printf("Wi-Fi status: %s (%d); waiting to connect...\n",
                  wifiStatusName(status), static_cast<int>(status));
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi connection timed out; retrying shortly.");
    return false;
  }

  Serial.printf("Wi-Fi connected. IP address: %s\n",
                WiFi.localIP().toString().c_str());
  return true;
}

static void pollCloud() {
  WiFiClientSecure tlsClient;
  tlsClient.useBuiltinCACertBundle();

  HTTPClient https;
  https.setTimeout(5000);
  Serial.println("Polling relay states from the cloud over HTTPS (TCP port 443)...");
  if (!https.begin(tlsClient, DEVICE_STATE_URL)) {
    Serial.println("Could not start HTTPS request.");
    return;
  }

  https.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  const int statusCode = https.GET();
  if (statusCode != HTTP_CODE_OK) {
    const String error = https.errorToString(statusCode);
    Serial.printf("Cloud poll failed (HTTP %d): %s\n", statusCode, error.c_str());
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

  const bool requestedRelay1 = relay1.as<bool>();
  const bool requestedRelay2 = relay2.as<bool>();
  Serial.printf("Cloud command received: Relay 1=%s, Relay 2=%s\n",
                requestedRelay1 ? "ON" : "OFF",
                requestedRelay2 ? "ON" : "OFF");
  setRelay(RELAY1_PIN, relay1On, requestedRelay1, "Relay 1");
  setRelay(RELAY2_PIN, relay2On, requestedRelay2, "Relay 2");
}

// Setup
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nESP32-C3 relay controller starting.");

  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  // Set RELAY_ACTIVE_LOW to true for active-LOW relay modules.
  const uint8_t relayOffLevel = RELAY_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(RELAY1_PIN, relayOffLevel);
  digitalWrite(RELAY2_PIN, relayOffLevel);
  Serial.printf("Relay 1: GPIO %u, initialized OFF (%s).\n", RELAY1_PIN,
                relayOffLevel == HIGH ? "HIGH" : "LOW");
  Serial.printf("Relay 2: GPIO %u, initialized OFF (%s).\n", RELAY2_PIN,
                relayOffLevel == HIGH ? "HIGH" : "LOW");
  Serial.printf("Cloud endpoint: %s (HTTPS/TCP port 443); poll interval: %lu ms.\n",
                DEVICE_STATE_URL, static_cast<unsigned long>(POLL_INTERVAL_MS));

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
