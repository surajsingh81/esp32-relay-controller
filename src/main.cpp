#include <Arduino.h>
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>

#include "secrets.h"

// Configuration
constexpr uint8_t RELAY1_PIN = 4;
constexpr uint8_t RELAY2_PIN = 5;
constexpr bool RELAY_ACTIVE_LOW = false;
constexpr uint32_t POLL_INTERVAL_MS = 3000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 30000;
constexpr uint32_t WIFI_STATUS_LOG_INTERVAL_MS = 5000;
constexpr char WIFI_SETTINGS_NAMESPACE[] = "relay-wifi";
constexpr char SETUP_AP_PASSWORD_ALPHABET[] =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

static const char SETUP_PAGE[] PROGMEM = R"rawliteral(
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f3f6f7">
  <title>ESP32 Wi-Fi Setup</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:24px 14px;background:#f3f6f7;color:#172b32;font-family:system-ui,-apple-system,sans-serif}
    main{max-width:480px;margin:0 auto}.brand{margin:8px 0 24px;color:#147d58;font-size:.75rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
    h1{margin:0;font-size:clamp(1.7rem,7vw,2.2rem);letter-spacing:-.04em}p{color:#62747a;line-height:1.55}
    form,.card{margin-top:20px;padding:20px;border:1px solid #dce5e7;border-radius:20px;background:#fff;box-shadow:0 12px 32px rgba(27,54,62,.08)}
    label{display:block;margin:16px 0 7px;font-size:.88rem;font-weight:750}input{width:100%;min-height:50px;padding:0 13px;border:1px solid #cbd7da;border-radius:12px;font:inherit}
    button{min-height:48px;border:0;border-radius:12px;padding:0 15px;font:inherit;font-weight:750;cursor:pointer}
    .scan{margin-top:10px;background:#edf1f2;color:#42565d}.save{width:100%;margin-top:18px;background:#147d58;color:#fff}
    select{width:100%;min-height:48px;margin-top:10px;padding:0 12px;border:1px solid #cbd7da;border-radius:12px;background:#fff;color:#172b32;font:inherit}
    #status{min-height:24px;margin:12px 0 0;font-size:.9rem}.note{font-size:.82rem}.card{padding:16px;background:#edf7f3;border-color:#d5e9e1}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style>
</head>
<body>
  <main>
    <div class="brand">ESP32-C3 · Device setup</div>
    <h1>Connect to your home Wi-Fi</h1>
    <p>Choose your 2.4 GHz Wi-Fi network and enter its password. The ESP32 will save these details and connect automatically after restarting.</p>
    <div class="card">Your Wi-Fi password is sent only to this ESP32 over its setup network. It is not sent to GitHub or the cloud service.</div>
    <form method="post" action="/save">
      <label for="ssid">Wi-Fi name (SSID)</label>
      <input id="ssid" name="ssid" type="text" maxlength="32" autocomplete="off" value="%SSID%" required>
      <button id="scan" class="scan" type="button">Find Wi-Fi networks</button>
      <select id="network-list" aria-label="Nearby Wi-Fi networks" hidden>
        <option value="">Select a nearby network</option>
      </select>
      <label for="password">Wi-Fi password</label>
      <input id="password" name="password" type="password" maxlength="63" autocomplete="new-password">
      <p class="note">Leave the password empty only for an open Wi-Fi network. The ESP32-C3 supports 2.4 GHz Wi-Fi.</p>
      <button class="save" type="submit">Save and connect</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
  </main>
  <script>
    const scanButton=document.querySelector("#scan");
    const ssidInput=document.querySelector("#ssid");
    const networkList=document.querySelector("#network-list");
    const statusText=document.querySelector("#status");
    scanButton.addEventListener("click",async()=>{
      scanButton.disabled=true;statusText.textContent="Scanning nearby networks…";
      try{
        const response=await fetch("/scan",{cache:"no-store"});
        const result=await response.json();
        if(!response.ok)throw new Error(result.error||"Network scan failed");
        if(!result.networks.length){statusText.textContent="No Wi-Fi networks found. Enter the network name manually.";return}
        networkList.replaceChildren(new Option("Select a nearby network", ""));
        for(const network of result.networks){
          const option=new Option(`${network.ssid} · ${network.secure?"secured":"open"} · ${network.rssi} dBm`,network.ssid);
          networkList.add(option);
        }
        networkList.hidden=false;
        statusText.textContent="Choose your home network from the list, or enter its name above.";
      }catch(error){statusText.textContent=error.message}
      finally{scanButton.disabled=false}
    });
    networkList.addEventListener("change",()=>{
      if(networkList.value){ssidInput.value=networkList.value;statusText.textContent=`Selected ${networkList.value}. Enter its password.`}
    });
    document.querySelector("form").addEventListener("submit",event=>{
      const password=document.querySelector("#password").value;
      if(password&&password.length<8){event.preventDefault();statusText.textContent="Wi-Fi passwords must be at least 8 characters, or empty for an open network."}
    });
  </script>
</body>
</html>
)rawliteral";

bool relay1On = false;
bool relay2On = false;
uint32_t lastPollAt = 0;
uint32_t lastWiFiAttemptAt = 0;
uint32_t lastWiFiStatusLogAt = 0;
bool wifiWasConnected = false;
String wifiSsid;
String wifiPassword;
String setupApName;
String setupApPassword;
Preferences wifiPreferences;
DNSServer captiveDns;
WebServer setupServer(80);

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

static String escapeHtml(const String &value) {
  String escaped;
  escaped.reserve(value.length());
  for (const char character : value) {
    switch (character) {
    case '&':
      escaped += F("&amp;");
      break;
    case '<':
      escaped += F("&lt;");
      break;
    case '>':
      escaped += F("&gt;");
      break;
    case '"':
      escaped += F("&quot;");
      break;
    case '\'':
      escaped += F("&#39;");
      break;
    default:
      escaped += character;
    }
  }
  return escaped;
}

static bool isSetupAccessPointClient() {
  return setupServer.client().localIP() == WiFi.softAPIP();
}

static void sendSetupError(int statusCode, const String &message) {
  String page = F(
      "<!doctype html><html lang=\"en\"><meta name=\"viewport\" "
      "content=\"width=device-width,initial-scale=1\"><title>Wi-Fi setup</title>"
      "<body style=\"font:16px system-ui;max-width:32rem;margin:3rem auto;padding:1rem\">"
      "<h1>Could not save Wi-Fi</h1><p>");
  page += escapeHtml(message);
  page += F("</p><p><a href=\"/\">Back to setup</a></p></body></html>");
  setupServer.sendHeader("Cache-Control", "no-store");
  setupServer.send(statusCode, "text/html; charset=utf-8", page);
}

static void handleSetupPage() {
  if (!isSetupAccessPointClient()) {
    setupServer.send(403, "text/plain", "Connect to the ESP32 setup Wi-Fi to change credentials.");
    return;
  }
  String page = FPSTR(SETUP_PAGE);
  page.replace("%SSID%", escapeHtml(wifiSsid));
  setupServer.sendHeader("Cache-Control", "no-store");
  setupServer.send(200, "text/html; charset=utf-8", page);
}

static void handleNetworkScan() {
  if (!isSetupAccessPointClient()) {
    setupServer.send(403, "application/json", "{\"error\":\"Connect to the ESP32 setup Wi-Fi.\"}");
    return;
  }

  Serial.println("Scanning for nearby 2.4 GHz Wi-Fi networks...");
  const int16_t networkCount = WiFi.scanNetworks(false, true);
  if (networkCount < 0) {
    setupServer.send(500, "application/json", "{\"error\":\"Wi-Fi scan failed. Enter the name manually.\"}");
    return;
  }

  JsonDocument response;
  JsonArray networks = response["networks"].to<JsonArray>();
  for (int16_t index = 0; index < networkCount; ++index) {
    const String name = WiFi.SSID(index);
    if (name.isEmpty()) {
      continue;
    }
    JsonObject network = networks.add<JsonObject>();
    network["ssid"] = name;
    network["rssi"] = WiFi.RSSI(index);
    network["secure"] = WiFi.encryptionType(index) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();

  String json;
  serializeJson(response, json);
  setupServer.sendHeader("Cache-Control", "no-store");
  setupServer.send(200, "application/json", json);
  Serial.printf("Wi-Fi scan completed; found %u networks.\n",
                static_cast<unsigned>(networks.size()));
}

static void handleSaveWiFi() {
  if (!isSetupAccessPointClient()) {
    setupServer.send(403, "text/plain", "Connect to the ESP32 setup Wi-Fi to change credentials.");
    return;
  }

  const String newSsid = setupServer.arg("ssid");
  const String newPassword = setupServer.arg("password");
  if (newSsid.isEmpty() || newSsid.length() > 32) {
    sendSetupError(400, "Enter a Wi-Fi name no longer than 32 characters.");
    return;
  }
  if (newPassword.length() > 63 ||
      (!newPassword.isEmpty() && newPassword.length() < 8)) {
    sendSetupError(400, "A Wi-Fi password must be 8–63 characters, or empty for an open network.");
    return;
  }

  if (!wifiPreferences.begin(WIFI_SETTINGS_NAMESPACE, false)) {
    sendSetupError(500, "The device could not open secure Wi-Fi storage. Restart the ESP32 and try again.");
    return;
  }
  const size_t ssidBytes = wifiPreferences.putString("ssid", newSsid);
  const size_t passwordBytes = wifiPreferences.putString("password", newPassword);
  wifiPreferences.end();
  if (ssidBytes == 0 || passwordBytes == 0) {
    sendSetupError(500, "The ESP32 could not save the Wi-Fi settings. Restart and try again.");
    return;
  }

  wifiSsid = newSsid;
  wifiPassword = newPassword;
  Serial.printf("Wi-Fi credentials saved for network '%s'. Password not logged.\n",
                wifiSsid.c_str());
  setupServer.sendHeader("Cache-Control", "no-store");
  setupServer.send(
      200, "text/html; charset=utf-8",
      F("<!doctype html><html lang=\"en\"><meta name=\"viewport\" "
        "content=\"width=device-width,initial-scale=1\"><title>Settings saved</title>"
        "<body style=\"font:16px system-ui;max-width:32rem;margin:3rem auto;padding:1rem\">"
        "<h1>Wi-Fi settings saved</h1><p>The ESP32 is restarting and will connect to your Wi-Fi.</p>"
        "<p>You can close this page. If it cannot connect, its setup Wi-Fi will remain available.</p>"
        "</body></html>"));
  delay(800);
  ESP.restart();
}

static void handleCaptiveCheck() {
  handleSetupPage();
}

static void handleNotFound() {
  if (!isSetupAccessPointClient()) {
    setupServer.send(404, "text/plain", "Not found");
    return;
  }
  setupServer.sendHeader("Location", "http://192.168.4.1/");
  setupServer.send(302, "text/plain", "Opening ESP32 Wi-Fi setup");
}

static void startSetupPortal() {
  const String macAddress = WiFi.softAPmacAddress();
  String suffix;
  for (size_t index = 0; index < macAddress.length(); ++index) {
    if (macAddress[index] != ':') {
      suffix += macAddress[index];
    }
  }
  setupApName = "ESP32-Relay-Setup-" + suffix.substring(suffix.length() - 6);

  const size_t alphabetLength = sizeof(SETUP_AP_PASSWORD_ALPHABET) - 1;
  setupApPassword.reserve(12);
  for (uint8_t index = 0; index < 12; ++index) {
    setupApPassword += SETUP_AP_PASSWORD_ALPHABET[esp_random() % alphabetLength];
  }

  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAP(setupApName.c_str(), setupApPassword.c_str(), 1, false, 4)) {
    Serial.println("Could not start the Wi-Fi setup hotspot.");
  } else {
    const IPAddress setupIp = WiFi.softAPIP();
    captiveDns.start(53, "*", setupIp);
    Serial.printf("Wi-Fi setup hotspot: %s\n", setupApName.c_str());
    Serial.printf("Setup hotspot password: %s\n", setupApPassword.c_str());
    Serial.printf("Connect to the hotspot and open http://%s/\n",
                  setupIp.toString().c_str());
  }

  setupServer.on("/", HTTP_GET, handleSetupPage);
  setupServer.on("/scan", HTTP_GET, handleNetworkScan);
  setupServer.on("/save", HTTP_POST, handleSaveWiFi);
  setupServer.on("/generate_204", HTTP_GET, handleCaptiveCheck);
  setupServer.on("/gen_204", HTTP_GET, handleCaptiveCheck);
  setupServer.on("/hotspot-detect.html", HTTP_GET, handleCaptiveCheck);
  setupServer.on("/library/test/success.html", HTTP_GET, handleCaptiveCheck);
  setupServer.on("/connecttest.txt", HTTP_GET, handleCaptiveCheck);
  setupServer.on("/ncsi.txt", HTTP_GET, handleCaptiveCheck);
  setupServer.on("/favicon.ico", HTTP_GET, []() {
    setupServer.send(204, "image/x-icon", "");
  });
  setupServer.onNotFound(handleNotFound);
  setupServer.begin();
  Serial.println("Local Wi-Fi setup page is ready.");
}

static bool loadWiFiCredentials() {
  if (!wifiPreferences.begin(WIFI_SETTINGS_NAMESPACE, true)) {
    Serial.println("Could not open Wi-Fi settings storage.");
    return false;
  }
  wifiSsid = wifiPreferences.getString("ssid", "");
  wifiPassword = wifiPreferences.getString("password", "");
  wifiPreferences.end();

  if (!wifiSsid.isEmpty()) {
    Serial.printf("Loaded Wi-Fi settings for '%s' from device storage.\n",
                  wifiSsid.c_str());
    return true;
  }

  // Migrate credentials from older firmware builds into NVS once.
  if (strlen(WIFI_SSID) > 0) {
    wifiSsid = WIFI_SSID;
    wifiPassword = WIFI_PASSWORD;
    if (!wifiPreferences.begin(WIFI_SETTINGS_NAMESPACE, false)) {
      Serial.println("Could not migrate Wi-Fi settings to device storage.");
      return true;
    }
    wifiPreferences.putString("ssid", wifiSsid);
    wifiPreferences.putString("password", wifiPassword);
    wifiPreferences.end();
    Serial.printf("Migrated Wi-Fi settings for '%s' into device storage.\n",
                  wifiSsid.c_str());
    return true;
  }

  Serial.println("No Wi-Fi network configured. Use the ESP32 setup hotspot.");
  return false;
}

static void beginWiFiConnection() {
  if (wifiSsid.isEmpty()) {
    Serial.println("No Wi-Fi SSID saved; configure Wi-Fi at http://192.168.4.1/.");
    return;
  }
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  lastWiFiAttemptAt = millis();
  Serial.printf("Connecting to Wi-Fi '%s'...\n", wifiSsid.c_str());
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

  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  loadWiFiCredentials();
  startSetupPortal();
  if (!wifiSsid.isEmpty()) {
    beginWiFiConnection();
  }
}

// Loop
void loop() {
  captiveDns.processNextRequest();
  setupServer.handleClient();

  const uint32_t now = millis();
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (wifiConnected) {
    if (!wifiWasConnected) {
      Serial.printf("Wi-Fi connected. IP address: %s\n",
                    WiFi.localIP().toString().c_str());
      wifiWasConnected = true;
      lastPollAt = now - POLL_INTERVAL_MS;
    }
    if (now - lastPollAt >= POLL_INTERVAL_MS) {
      lastPollAt = now;
      pollCloud();
    }
    return;
  }

  if (wifiWasConnected) {
    Serial.printf("Wi-Fi connection lost: %s.\n", wifiStatusName(WiFi.status()));
    wifiWasConnected = false;
  }
  if (wifiSsid.isEmpty()) {
    delay(2);
    return;
  }
  if (now - lastWiFiStatusLogAt >= WIFI_STATUS_LOG_INTERVAL_MS) {
    lastWiFiStatusLogAt = now;
    Serial.printf("Wi-Fi status: %s (%d); setup hotspot remains available.\n",
                  wifiStatusName(WiFi.status()), static_cast<int>(WiFi.status()));
  }
  if (now - lastWiFiAttemptAt >= WIFI_RETRY_INTERVAL_MS) {
    beginWiFiConnection();
  }
}
