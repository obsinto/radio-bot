#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>

#if __has_include("config.h")
#define RADIO_BOT_HAS_LOCAL_CONFIG 1
#include "config.h"
#else
#define RADIO_BOT_HAS_LOCAL_CONFIG 0
#include "config.example.h"
#endif

// Configuracoes de protocolo e versoes
#ifndef SERIAL_PROTOCOL_VERSION
#define SERIAL_PROTOCOL_VERSION 1
#endif

namespace {

WiFiUDP udp;
Preferences preferences;

// Cache de configuracoes em memoria
struct {
  String wifiSsid;
  String wifiPassword;
  String apiBaseUrl;
  String gatewayId;
  String gatewayToken;
  bool configured = false;
} config;

unsigned long lastPollAt = 0;
String lastError = "";

// Prototypes
void loadSettings();
bool saveSettings(const JsonObject& doc);
void connectWifi();
void pollServer();
void handleSerial();
void sendStatus();
void sendHello();

String apiBaseUrl() {
  String base = config.apiBaseUrl;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base;
}

String authHeader() {
  return String("Bearer ") + config.gatewayToken;
}

bool isHttps(const String& url) {
  return url.startsWith("https://");
}

bool hasUsableSettings(const String& wifiSsid,
                       const String& apiBaseUrl,
                       const String& gatewayId,
                       const String& gatewayToken) {
  return wifiSsid.length() > 0 &&
         wifiSsid != "sua-rede-wifi" &&
         apiBaseUrl.length() > 0 &&
         (apiBaseUrl.startsWith("http://") || apiBaseUrl.startsWith("https://")) &&
         apiBaseUrl != "https://api.seu-dominio.com" &&
         gatewayId.length() > 0 &&
         gatewayId != "seu-wol-gateway-id" &&
         gatewayId != "esp-studio-01" &&
         gatewayToken.length() > 0 &&
         gatewayToken != "token-gerado-no-painel";
}

bool hasUsableSettings() {
  return hasUsableSettings(
    config.wifiSsid,
    config.apiBaseUrl,
    config.gatewayId,
    config.gatewayToken
  );
}

void loadSettings() {
  preferences.begin("radio_bot", true);
  config.wifiSsid = preferences.getString("wifi_ssid", WIFI_SSID);
  config.wifiPassword = preferences.getString("wifi_password", WIFI_PASSWORD);
  config.apiBaseUrl = preferences.getString("api_base_url", API_BASE_URL);
  config.gatewayId = preferences.getString("gateway_id", WOL_GATEWAY_ID);
  config.gatewayToken = preferences.getString("gateway_token", WOL_GATEWAY_TOKEN);
  preferences.end();

  bool shouldUseBuildConfig = false;
#ifdef USE_CONFIG_H_SEED
  shouldUseBuildConfig = shouldUseBuildConfig || USE_CONFIG_H_SEED;
#endif
#if RADIO_BOT_HAS_LOCAL_CONFIG
  shouldUseBuildConfig =
    shouldUseBuildConfig ||
    hasUsableSettings(
      String(WIFI_SSID),
      String(API_BASE_URL),
      String(WOL_GATEWAY_ID),
      String(WOL_GATEWAY_TOKEN)
    );
#endif

  if (shouldUseBuildConfig) {
    config.wifiSsid = WIFI_SSID;
    config.wifiPassword = WIFI_PASSWORD;
    config.apiBaseUrl = API_BASE_URL;
    config.gatewayId = WOL_GATEWAY_ID;
    config.gatewayToken = WOL_GATEWAY_TOKEN;
  }

  config.configured = hasUsableSettings();

  Serial.println("[nvs] configuracoes carregadas");
}

bool saveSettings(const JsonObject& doc) {
  String nextWifiSsid = config.wifiSsid;
  String nextWifiPassword = config.wifiPassword;
  String nextApiBaseUrl = config.apiBaseUrl;
  String nextGatewayId = config.gatewayId;
  String nextGatewayToken = config.gatewayToken;

  if (doc["wifiSsid"].is<const char*>()) {
    nextWifiSsid = doc["wifiSsid"].as<String>();
  }
  if (doc["wifiPassword"].is<const char*>()) {
    nextWifiPassword = doc["wifiPassword"].as<String>();
  }
  if (doc["apiBaseUrl"].is<const char*>()) {
    nextApiBaseUrl = doc["apiBaseUrl"].as<String>();
  }
  if (doc["gatewayId"].is<const char*>()) {
    nextGatewayId = doc["gatewayId"].as<String>();
  }
  if (doc["gatewayToken"].is<const char*>()) {
    nextGatewayToken = doc["gatewayToken"].as<String>();
  }

  while (nextApiBaseUrl.endsWith("/")) {
    nextApiBaseUrl.remove(nextApiBaseUrl.length() - 1);
  }

  if (!hasUsableSettings(nextWifiSsid, nextApiBaseUrl, nextGatewayId, nextGatewayToken)) {
    lastError = "Configuracao serial incompleta ou usando placeholders.";
    Serial.println("[nvs] configuracao serial recusada");
    return false;
  }

  preferences.begin("radio_bot", false);
  preferences.putString("wifi_ssid", nextWifiSsid);
  preferences.putString("wifi_password", nextWifiPassword);
  preferences.putString("api_base_url", nextApiBaseUrl);
  preferences.putString("gateway_id", nextGatewayId);
  preferences.putString("gateway_token", nextGatewayToken);
  preferences.end();

  config.wifiSsid = nextWifiSsid;
  config.wifiPassword = nextWifiPassword;
  config.apiBaseUrl = nextApiBaseUrl;
  config.gatewayId = nextGatewayId;
  config.gatewayToken = nextGatewayToken;
  config.configured = true;
  lastError = "";
  Serial.println("[nvs] configuracoes salvas");
  return true;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (!config.configured) {
    return; // Nao tenta se nao tiver SSID valido
  }

  Serial.printf("[wifi] conectando em %s\n", config.wifiSsid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(config.wifiSsid.c_str(), config.wifiPassword.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
    handleSerial(); // Continua ouvindo serial durante a espera
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[wifi] conectado: %s\n", WiFi.localIP().toString().c_str());
    lastError = "";
  } else {
    Serial.println("\n[wifi] falha ao conectar");
    lastError = "Falha ao conectar no Wi-Fi";
  }
}

uint8_t hexValue(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return 10 + value - 'a';
  if (value >= 'A' && value <= 'F') return 10 + value - 'A';
  return 0xFF;
}

bool parseMac(const char* rawMac, uint8_t mac[6]) {
  char hex[12];
  size_t hexCount = 0;
  for (size_t i = 0; rawMac[i] != '\0'; i++) {
    uint8_t v = hexValue(rawMac[i]);
    if (v == 0xFF) continue;
    if (hexCount >= 12) return false;
    hex[hexCount++] = rawMac[i];
  }
  if (hexCount != 12) return false;
  for (size_t i = 0; i < 6; i++) {
    mac[i] = (hexValue(hex[i * 2]) << 4) | hexValue(hex[i * 2 + 1]);
  }
  return true;
}

size_t sendWakeOnLan(const char* rawMac, const char* rawBroadcast) {
  uint8_t mac[6];
  if (!parseMac(rawMac, mac)) return 0;

  IPAddress broadcastAddress(255, 255, 255, 255);
  if (rawBroadcast && rawBroadcast[0] != '\0') {
    IPAddress parsed;
    if (parsed.fromString(rawBroadcast)) broadcastAddress = parsed;
  }

  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (size_t i = 0; i < 16; i++) memcpy(packet + 6 + i * 6, mac, 6);

  udp.begin(WOL_PORT);
  size_t packetsSent = 0;
  for (size_t i = 0; i < WOL_REPEAT_COUNT; i++) {
    const bool packetStarted = udp.beginPacket(broadcastAddress, WOL_PORT) == 1;
    const size_t bytesWritten = packetStarted ? udp.write(packet, sizeof(packet)) : 0;
    const bool packetFinished = packetStarted && udp.endPacket() == 1;
    if (bytesWritten == sizeof(packet) && packetFinished) {
      packetsSent++;
    }
    delay(100);
  }
  Serial.printf(
    "[wol] %u/%u magic packets enviados para %s\n",
    static_cast<unsigned int>(packetsSent),
    static_cast<unsigned int>(WOL_REPEAT_COUNT),
    rawMac
  );
  return packetsSent;
}

void postCommandResult(const char* commandId, const char* status, const char* rawMac, const char* rawBroadcast, size_t packetsSent, const char* errorMessage = nullptr) {
  HTTPClient http;
  WiFiClient client;
  WiFiClientSecure secureClient;
  String url = apiBaseUrl() + "/wol-gateway/commands/" + commandId + "/result?gatewayId=" + config.gatewayId;

  bool ok = false;
  if (isHttps(url)) {
    secureClient.setInsecure();
    ok = http.begin(secureClient, url);
  } else {
    ok = http.begin(client, url);
  }

  if (!ok) return;

  JsonDocument doc;
  doc["status"] = status;
  if (errorMessage) doc["error"] = errorMessage;
  JsonObject output = doc["output"].to<JsonObject>();
  output["macAddress"] = rawMac;
  output["broadcastAddress"] = rawBroadcast ? rawBroadcast : "";
  output["packetsSent"] = packetsSent;
  output["packetsAttempted"] = WOL_REPEAT_COUNT;
  output["firmwareVersion"] = RADIO_BOT_VERSION;

  String body;
  serializeJson(doc, body);
  http.addHeader("Authorization", authHeader());
  http.addHeader("Content-Type", "application/json");
  http.POST(body);
  http.end();
}

void handleWolCommand(JsonObject command) {
  const char* commandId = command["id"] | "";
  const char* macAddress = command["macAddress"] | "";
  const char* broadcastAddress = command["broadcastAddress"] | "255.255.255.255";

  if (commandId[0] == '\0' || macAddress[0] == '\0') return;

  size_t packetsSent = sendWakeOnLan(macAddress, broadcastAddress);
  postCommandResult(
    commandId,
    packetsSent > 0 ? "succeeded" : "failed",
    macAddress,
    broadcastAddress,
    packetsSent,
    packetsSent > 0 ? nullptr : "Erro ao enviar pacote."
  );
}

void pollServer() {
  if (WiFi.status() != WL_CONNECTED || !config.configured) {
    return;
  }

  HTTPClient http;
  WiFiClient client;
  WiFiClientSecure secureClient;
  String url = apiBaseUrl() + "/wol-gateway/poll?gatewayId=" + config.gatewayId;

  bool ok = false;
  if (isHttps(url)) {
    secureClient.setInsecure();
    ok = http.begin(secureClient, url);
  } else {
    ok = http.begin(client, url);
  }

  if (!ok) {
    lastError = "Falha ao iniciar HTTP";
    return;
  }

  http.addHeader("Authorization", authHeader());
  int statusCode = http.GET();

  if (statusCode == 200) {
    String body = http.getString();
    JsonDocument doc;
    if (!deserializeJson(doc, body)) {
      JsonObject data = doc["data"].as<JsonObject>();
      if (!data["command"].isNull()) {
        handleWolCommand(data["command"].as<JsonObject>());
      }
    }
    lastError = "";
  } else if (statusCode > 0) {
    lastError = "HTTP Error " + String(statusCode);
  } else {
    lastError = http.errorToString(statusCode);
    Serial.printf("[api] erro: %s\n", lastError.c_str());
  }
  http.end();
}

void sendHello() {
  JsonDocument doc;
  doc["type"] = "hello_result";
  doc["ok"] = true;
  doc["protocolVersion"] = SERIAL_PROTOCOL_VERSION;
  doc["firmwareVersion"] = RADIO_BOT_VERSION;
  doc["configured"] = config.configured;
  doc["chipId"] = String((uint32_t)ESP.getEfuseMac(), HEX);
  serializeJson(doc, Serial);
  Serial.println();
}

void sendStatus() {
  JsonDocument doc;
  doc["type"] = "status_result";
  doc["ok"] = true;
  doc["configured"] = config.configured;
  doc["wifiConnected"] = (WiFi.status() == WL_CONNECTED);
  doc["ip"] = WiFi.localIP().toString();

  if (lastError.length() > 0) {
    doc["lastError"] = lastError;
  } else {
    doc["lastError"] = nullptr;
  }

  doc["apiBaseUrl"] = config.apiBaseUrl;
  doc["gatewayId"] = config.gatewayId;
  doc["gatewayTokenSet"] = hasUsableSettings(
    config.wifiSsid,
    config.apiBaseUrl,
    config.gatewayId,
    config.gatewayToken
  );
  serializeJson(doc, Serial);
  Serial.println();
}

void handleSerial() {
  if (!Serial.available()) return;

  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, line);
  if (error) return;

  String type = doc["type"] | "";
  if (type == "hello") {
    sendHello();
  } else if (type == "status") {
    sendStatus();
  } else if (type == "configure") {
    JsonDocument res;
    res["type"] = "configure_result";
    if (saveSettings(doc.as<JsonObject>())) {
      res["ok"] = true;
      res["saved"] = true;
      res["restarting"] = true;
      serializeJson(res, Serial);
      Serial.println();
      delay(500);
      ESP.restart();
      return;
    }
    res["ok"] = false;
    res["saved"] = false;
    res["restarting"] = false;
    res["code"] = "INVALID_CONFIG";
    res["message"] = lastError;
    serializeJson(res, Serial);
    Serial.println();
  } else if (type == "reset_config") {
    preferences.begin("radio_bot", false);
    preferences.clear();
    preferences.end();
    JsonDocument res;
    res["type"] = "reset_config_result";
    res["ok"] = true;
    res["cleared"] = true;
    res["restarting"] = true;
    serializeJson(res, Serial);
    Serial.println();
    delay(500);
    ESP.restart();
  }
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n[radio-bot] ESP32 WOL gateway %s\n", RADIO_BOT_VERSION);

  loadSettings();
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED && config.configured) {
    connectWifi();
  }

  handleSerial();

  unsigned long now = millis();
  if (config.configured && (now - lastPollAt >= POLL_INTERVAL_MS || lastPollAt == 0)) {
    lastPollAt = now;
    pollServer();
  }

  delay(20);
}
