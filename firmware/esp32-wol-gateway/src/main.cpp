#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>

#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

namespace {

WiFiUDP udp;
WiFiClient wifiClient;
WiFiClientSecure secureClient;

unsigned long lastPollAt = 0;

String apiBaseUrl() {
  String base = API_BASE_URL;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base;
}

String authHeader() {
  return String("Bearer ") + WOL_GATEWAY_TOKEN;
}

bool isHttps(const String& url) {
  return url.startsWith("https://");
}

bool beginHttp(HTTPClient& http, const String& url) {
  if (isHttps(url)) {
#if TLS_INSECURE
    secureClient.setInsecure();
#else
    secureClient.setCACert(ROOT_CA_PEM);
#endif
    return http.begin(secureClient, url);
  }

  return http.begin(wifiClient, url);
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.printf("[wifi] conectando em %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.printf("\n[wifi] conectado: %s\n", WiFi.localIP().toString().c_str());
}

uint8_t hexValue(char value) {
  if (value >= '0' && value <= '9') {
    return static_cast<uint8_t>(value - '0');
  }
  if (value >= 'a' && value <= 'f') {
    return static_cast<uint8_t>(10 + value - 'a');
  }
  if (value >= 'A' && value <= 'F') {
    return static_cast<uint8_t>(10 + value - 'A');
  }
  return 0xFF;
}

bool parseMac(const char* rawMac, uint8_t mac[6]) {
  char hex[12];
  size_t hexCount = 0;

  for (size_t index = 0; rawMac[index] != '\0'; index += 1) {
    const uint8_t value = hexValue(rawMac[index]);
    if (value == 0xFF) {
      if (rawMac[index] == ':' || rawMac[index] == '-' || rawMac[index] == ' ') {
        continue;
      }
      return false;
    }

    if (hexCount >= sizeof(hex)) {
      return false;
    }
    hex[hexCount] = rawMac[index];
    hexCount += 1;
  }

  if (hexCount != sizeof(hex)) {
    return false;
  }

  for (size_t index = 0; index < 6; index += 1) {
    const uint8_t high = hexValue(hex[index * 2]);
    const uint8_t low = hexValue(hex[index * 2 + 1]);
    if (high == 0xFF || low == 0xFF) {
      return false;
    }
    mac[index] = static_cast<uint8_t>((high << 4) | low);
  }

  return true;
}

bool sendWakeOnLan(const char* rawMac, const char* rawBroadcast) {
  uint8_t mac[6];
  if (!parseMac(rawMac, mac)) {
    Serial.printf("[wol] MAC invalido: %s\n", rawMac);
    return false;
  }

  IPAddress broadcastAddress(255, 255, 255, 255);
  if (rawBroadcast && rawBroadcast[0] != '\0') {
    IPAddress parsed;
    if (parsed.fromString(rawBroadcast)) {
      broadcastAddress = parsed;
    }
  }

  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (size_t repeat = 0; repeat < 16; repeat += 1) {
    memcpy(packet + 6 + repeat * 6, mac, sizeof(mac));
  }

  udp.begin(WOL_PORT);
  for (size_t index = 0; index < WOL_REPEAT_COUNT; index += 1) {
    udp.beginPacket(broadcastAddress, WOL_PORT);
    udp.write(packet, sizeof(packet));
    udp.endPacket();
    delay(150);
  }

  Serial.printf("[wol] magic packet enviado para %s via %s:%d\n",
                rawMac,
                broadcastAddress.toString().c_str(),
                WOL_PORT);
  return true;
}

void postCommandResult(const char* commandId,
                       const char* status,
                       const char* rawMac,
                       const char* rawBroadcast,
                       const char* errorMessage = nullptr) {
  HTTPClient http;
  String url = apiBaseUrl() + "/wol-gateway/commands/" + commandId +
               "/result?gatewayId=" + WOL_GATEWAY_ID;

  if (!beginHttp(http, url)) {
    Serial.println("[api] falha ao iniciar POST de resultado");
    return;
  }

  JsonDocument document;
  document["status"] = status;
  if (errorMessage) {
    document["error"] = errorMessage;
  }

  JsonObject output = document["output"].to<JsonObject>();
  output["macAddress"] = rawMac;
  output["broadcastAddress"] = rawBroadcast ? rawBroadcast : "";
  output["packetsSent"] = WOL_REPEAT_COUNT;
  output["firmwareVersion"] = RADIO_BOT_VERSION;

  String body;
  serializeJson(document, body);

  http.addHeader("Authorization", authHeader());
  http.addHeader("Content-Type", "application/json");
  const int statusCode = http.POST(body);
  Serial.printf("[api] resultado %s -> HTTP %d\n", commandId, statusCode);
  http.end();
}

void handleCommand(JsonObject command) {
  const char* commandId = command["id"] | "";
  const char* macAddress = command["macAddress"] | "";
  const char* broadcastAddress = command["broadcastAddress"] | "255.255.255.255";

  if (commandId[0] == '\0' || macAddress[0] == '\0') {
    Serial.println("[api] comando WOL incompleto");
    return;
  }

  const bool sent = sendWakeOnLan(macAddress, broadcastAddress);
  postCommandResult(
    commandId,
    sent ? "succeeded" : "failed",
    macAddress,
    broadcastAddress,
    sent ? nullptr : "Falha ao montar ou enviar magic packet."
  );
}

void pollServer() {
  HTTPClient http;
  String url = apiBaseUrl() + "/wol-gateway/poll?gatewayId=" + WOL_GATEWAY_ID;

  if (!beginHttp(http, url)) {
    Serial.println("[api] falha ao iniciar polling");
    return;
  }

  http.addHeader("Authorization", authHeader());
  const int statusCode = http.GET();
  if (statusCode != 200) {
    Serial.printf("[api] polling HTTP %d\n", statusCode);
    http.end();
    return;
  }

  const String body = http.getString();
  http.end();

  JsonDocument document;
  DeserializationError error = deserializeJson(document, body);
  if (error) {
    Serial.printf("[api] JSON invalido: %s\n", error.c_str());
    return;
  }

  JsonObject data = document["data"].as<JsonObject>();
  if (data.isNull() || data["command"].isNull()) {
    return;
  }

  handleCommand(data["command"].as<JsonObject>());
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n[radio-bot] ESP32 WOL gateway %s\n", RADIO_BOT_VERSION);
  connectWifi();
}

void loop() {
  connectWifi();

  const unsigned long now = millis();
  if (now - lastPollAt >= POLL_INTERVAL_MS || lastPollAt == 0) {
    lastPollAt = now;
    pollServer();
  }

  delay(50);
}
