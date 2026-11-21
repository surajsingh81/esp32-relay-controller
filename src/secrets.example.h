#pragma once

// Copy this file to secrets.h and fill in the device token locally.
// Wi-Fi credentials can be entered later on the ESP32's local setup page.
// These optional legacy values are migrated once if you already configured
// Wi-Fi in an older firmware build; leave both empty for a new installation.
constexpr char WIFI_SSID[] = "";
constexpr char WIFI_PASSWORD[] = "";
constexpr char DEVICE_TOKEN[] = "SET_THE_SAME_RANDOM_TOKEN_AS_CLOUDFLARE_DEVICE_TOKEN";
constexpr char DEVICE_STATE_URL[] =
    "https://esp32-relay-api.surajupes-fd1.workers.dev/api/device/state";
