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

#ifndef RADIO_BOT_VERSION
#define RADIO_BOT_VERSION "0.1.0"
#endif

#ifndef USE_CONFIG_H_SEED
#define USE_CONFIG_H_SEED 1
#endif

#ifndef SERIAL_CONFIG_ONLY
#define SERIAL_CONFIG_ONLY 0
#endif

#ifndef POLL_INTERVAL_MS
#define POLL_INTERVAL_MS 5000
#endif

#ifndef WOL_PORT
#define WOL_PORT 9
#endif

#ifndef WOL_REPEAT_COUNT
#define WOL_REPEAT_COUNT 3
#endif

#ifndef TLS_INSECURE
#define TLS_INSECURE 1
#endif

#ifndef ROOT_CA_PEM
#define ROOT_CA_PEM ""
#endif

namespace {

constexpr uint8_t SERIAL_PROTOCOL_VERSION = 1;
constexpr const char* NVS_NAMESPACE = "radio_bot";
constexpr size_t SERIAL_MAX_LINE_LENGTH = 1024;
constexpr unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
constexpr unsigned long SERIAL_RESTART_DELAY_MS = 700;

struct GatewayConfig {
  String wifiSsid;
  String wifiPassword;
  String apiBaseUrl;
  String gatewayId;
  String gatewayToken;
  String configuredAt;
};

WiFiUDP udp;
WiFiClient wifiClient;
WiFiClientSecure secureClient;
Preferences preferences;

GatewayConfig currentConfig;
String serialLine;
String lastError;
unsigned long lastPollAt = 0;
unsigned long wifiConnectStartedAt = 0;
bool wifiConnecting = false;
bool printedWaitingConfig = false;
bool printedWifiConnected = false;

String normalizeApiBaseUrl(String base) {
  base.trim();
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base;
}

bool isConfigured(const GatewayConfig& config) {
  return config.wifiSsid.length() > 0 &&
         config.apiBaseUrl.length() > 0 &&
         config.gatewayId.length() > 0 &&
         config.gatewayToken.length() > 0;
}

String chipId() {
  char value[17];
  snprintf(value, sizeof(value), "%04X%08X",
           static_cast<uint16_t>(ESP.getEfuseMac() >> 32),
           static_cast<uint32_t>(ESP.getEfuseMac()));
  return String(value);
}

String isoLikeTimestamp() {
  return String(millis());
}

String configString(const char* value) {
  return value ? String(value) : String("");
}

bool hasExampleBuildValues(const GatewayConfig& config) {
  return config.wifiSsid == "sua-rede-wifi" ||
         config.wifiPassword == "senha-da-rede" ||
         config.apiBaseUrl == "https://api.seu-dominio.com" ||
         config.gatewayId == "seu-wol-gateway-id" ||
         config.gatewayId == "esp-studio-01" ||
         config.gatewayToken == "token-gerado-no-painel";
}

bool shouldUseBuildConfig(const GatewayConfig& config) {
#if SERIAL_CONFIG_ONLY
  (void)config;
  return false;
#elif USE_CONFIG_H_SEED
  (void)config;
  return true;
#elif RADIO_BOT_HAS_LOCAL_CONFIG
  return isConfigured(config) && !hasExampleBuildValues(config);
#else
  (void)config;
  return false;
#endif
}

GatewayConfig readBuildConfig() {
  GatewayConfig config;
  config.wifiSsid = configString(WIFI_SSID);
  config.wifiPassword = configString(WIFI_PASSWORD);
  config.apiBaseUrl = normalizeApiBaseUrl(configString(API_BASE_URL));
  config.gatewayId = configString(WOL_GATEWAY_ID);
  config.gatewayToken = configString(WOL_GATEWAY_TOKEN);
  config.configuredAt = "build-seed";
  return config;
}

GatewayConfig configFromBuildFlags() {
  GatewayConfig config = readBuildConfig();
  if (shouldUseBuildConfig(config)) {
    return config;
  }

  return GatewayConfig{};
}

bool sameRuntimeConfig(const GatewayConfig& left, const GatewayConfig& right) {
  return left.wifiSsid == right.wifiSsid &&
         left.wifiPassword == right.wifiPassword &&
         left.apiBaseUrl == right.apiBaseUrl &&
         left.gatewayId == right.gatewayId &&
         left.gatewayToken == right.gatewayToken;
}

void saveConfig(const GatewayConfig& config) {
  preferences.begin(NVS_NAMESPACE, false);
  preferences.putString("wifi_ssid", config.wifiSsid);
  preferences.putString("wifi_password", config.wifiPassword);
  preferences.putString("api_base_url", normalizeApiBaseUrl(config.apiBaseUrl));
  preferences.putString("gateway_id", config.gatewayId);
  preferences.putString("gateway_token", config.gatewayToken);
  preferences.putString("configured_at", config.configuredAt);
  preferences.end();
}

String storedString(const char* key) {
  return preferences.isKey(key) ? preferences.getString(key, "") : "";
}

GatewayConfig loadStoredConfig() {
  GatewayConfig config;
  preferences.begin(NVS_NAMESPACE, true);
  config.wifiSsid = storedString("wifi_ssid");
  config.wifiPassword = storedString("wifi_password");
  config.apiBaseUrl = normalizeApiBaseUrl(storedString("api_base_url"));
  config.gatewayId = storedString("gateway_id");
  config.gatewayToken = storedString("gateway_token");
  config.configuredAt = storedString("configured_at");
  preferences.end();
  return config;
}

GatewayConfig loadConfig() {
  GatewayConfig config = loadStoredConfig();
  GatewayConfig buildConfig = configFromBuildFlags();
  if (isConfigured(buildConfig)) {
    if (!sameRuntimeConfig(config, buildConfig)) {
      saveConfig(buildConfig);
    }
    return buildConfig;
  }

  if (isConfigured(config)) {
    return config;
  }

  return config;
}

void clearConfig() {
  preferences.begin(NVS_NAMESPACE, false);
  preferences.clear();
  preferences.end();
}

void writeJson(JsonDocument& document) {
  serializeJson(document, Serial);
  Serial.println();
}

void writeError(const char* code, const char* message, const char* responseType = "error") {
  JsonDocument response;
  response["type"] = responseType;
  response["ok"] = false;
  response["code"] = code;
  response["message"] = message;
  writeJson(response);
}

void writeHelloResult() {
  JsonDocument response;
  response["type"] = "hello_result";
  response["ok"] = true;
  response["protocolVersion"] = SERIAL_PROTOCOL_VERSION;
  response["firmwareVersion"] = RADIO_BOT_VERSION;
  response["configured"] = isConfigured(currentConfig);
  response["chipId"] = chipId();
  writeJson(response);
}

void writeStatusResult() {
  JsonDocument response;
  response["type"] = "status_result";
  response["ok"] = true;
  response["configured"] = isConfigured(currentConfig);
  response["wifiConnected"] = WiFi.status() == WL_CONNECTED;
  response["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
  if (lastError.length() > 0) {
    response["lastError"] = lastError;
  } else {
    response["lastError"] = nullptr;
  }
  response["apiBaseUrl"] = currentConfig.apiBaseUrl;
  response["gatewayId"] = currentConfig.gatewayId;
  response["gatewayTokenSet"] = currentConfig.gatewayToken.length() > 0;
  writeJson(response);
}

bool hasValidLength(const String& value, size_t minLength, size_t maxLength) {
  return value.length() >= minLength && value.length() <= maxLength;
}

bool hasValidApiUrl(const String& value) {
  return hasValidLength(value, 8, 200) &&
         (value.startsWith("https://") || value.startsWith("http://"));
}

void handleConfigure(JsonObject request) {
  GatewayConfig config;
  config.wifiSsid = request["wifiSsid"] | "";
  config.wifiPassword = request["wifiPassword"] | "";
  config.apiBaseUrl = normalizeApiBaseUrl(String(request["apiBaseUrl"] | ""));
  config.gatewayId = request["gatewayId"] | "";
  config.gatewayToken = request["gatewayToken"] | "";
  config.configuredAt = isoLikeTimestamp();

  if (!hasValidLength(config.wifiSsid, 1, 64)) {
    writeError("INVALID_WIFI_SSID", "SSID Wi-Fi invalido.", "configure_result");
    return;
  }

  if (config.wifiPassword.length() > 128) {
    writeError("INVALID_WIFI_PASSWORD", "Senha Wi-Fi excede o limite.", "configure_result");
    return;
  }

  if (!hasValidApiUrl(config.apiBaseUrl)) {
    writeError("INVALID_API_BASE_URL", "URL da API invalida.", "configure_result");
    return;
  }

  if (!hasValidLength(config.gatewayId, 1, 80)) {
    writeError("INVALID_GATEWAY_ID", "ID do gateway invalido.", "configure_result");
    return;
  }

  if (!hasValidLength(config.gatewayToken, 10, 160)) {
    writeError("INVALID_GATEWAY_TOKEN", "Token do gateway invalido.", "configure_result");
    return;
  }

  saveConfig(config);
  currentConfig = config;
  lastError = "";

  JsonDocument response;
  response["type"] = "configure_result";
  response["ok"] = true;
  response["saved"] = true;
  response["restarting"] = true;
  writeJson(response);
  Serial.flush();
  delay(SERIAL_RESTART_DELAY_MS);
  ESP.restart();
}

void handleResetConfig() {
  clearConfig();
  JsonDocument response;
  response["type"] = "reset_config_result";
  response["ok"] = true;
  response["cleared"] = true;
  response["restarting"] = true;
  writeJson(response);
  Serial.flush();
  delay(SERIAL_RESTART_DELAY_MS);
  ESP.restart();
}

void handleSerialCommand(const String& rawLine) {
  JsonDocument request;
  DeserializationError error = deserializeJson(request, rawLine);
  if (error) {
    writeError("INVALID_JSON", "Comando serial nao e JSON valido.");
    return;
  }

  const char* type = request["type"] | "";
  if (strcmp(type, "hello") == 0) {
    writeHelloResult();
    return;
  }

  if (strcmp(type, "status") == 0) {
    writeStatusResult();
    return;
  }

  if (strcmp(type, "configure") == 0) {
    handleConfigure(request.as<JsonObject>());
    return;
  }

  if (strcmp(type, "reset_config") == 0) {
    handleResetConfig();
    return;
  }

  writeError("UNKNOWN_COMMAND", "Comando serial desconhecido.");
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\r') {
      continue;
    }

    if (value == '\n') {
      serialLine.trim();
      if (serialLine.length() > 0) {
        handleSerialCommand(serialLine);
      }
      serialLine = "";
      continue;
    }

    if (serialLine.length() >= SERIAL_MAX_LINE_LENGTH) {
      serialLine = "";
      writeError("LINE_TOO_LONG", "Comando serial excede o limite.");
      continue;
    }

    serialLine += value;
  }
}

String authHeader() {
  return String("Bearer ") + currentConfig.gatewayToken;
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

bool ensureWifi() {
  if (!isConfigured(currentConfig)) {
    if (!printedWaitingConfig) {
      Serial.println("[config] aguardando configuracao via Serial");
      printedWaitingConfig = true;
    }
    return false;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnecting = false;
    if (!printedWifiConnected) {
      Serial.printf("[wifi] conectado: %s\n", WiFi.localIP().toString().c_str());
      printedWifiConnected = true;
      lastError = "";
    }
    return true;
  }

  printedWifiConnected = false;
  const unsigned long now = millis();
  if (!wifiConnecting || now - wifiConnectStartedAt > WIFI_CONNECT_TIMEOUT_MS) {
    Serial.println("[wifi] conectando");
    WiFi.mode(WIFI_STA);
    WiFi.begin(currentConfig.wifiSsid.c_str(), currentConfig.wifiPassword.c_str());
    wifiConnecting = true;
    wifiConnectStartedAt = now;
  }

  if (now - wifiConnectStartedAt > WIFI_CONNECT_TIMEOUT_MS) {
    lastError = "Wi-Fi nao conectou dentro do timeout.";
    wifiConnecting = false;
  }

  return false;
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
    lastError = "MAC invalido no comando WOL.";
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
  lastError = "";
  return true;
}

void postCommandResult(const char* commandId,
                       const char* status,
                       const char* rawMac,
                       const char* rawBroadcast,
                       const char* errorMessage = nullptr) {
  HTTPClient http;
  String url = currentConfig.apiBaseUrl + "/wol-gateway/commands/" + commandId +
               "/result?gatewayId=" + currentConfig.gatewayId;

  if (!beginHttp(http, url)) {
    Serial.println("[api] falha ao iniciar POST de resultado");
    lastError = "Falha ao iniciar POST de resultado.";
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
  if (statusCode < 200 || statusCode >= 300) {
    lastError = String("POST de resultado HTTP ") + statusCode;
  }
  http.end();
}

void handleCommand(JsonObject command) {
  const char* commandId = command["id"] | "";
  const char* macAddress = command["macAddress"] | "";
  const char* broadcastAddress = command["broadcastAddress"] | "255.255.255.255";

  if (commandId[0] == '\0' || macAddress[0] == '\0') {
    Serial.println("[api] comando WOL incompleto");
    lastError = "Comando WOL incompleto.";
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
  String url = currentConfig.apiBaseUrl + "/wol-gateway/poll?gatewayId=" + currentConfig.gatewayId;

  if (!beginHttp(http, url)) {
    Serial.println("[api] falha ao iniciar polling");
    lastError = "Falha ao iniciar polling.";
    return;
  }

  http.addHeader("Authorization", authHeader());
  const int statusCode = http.GET();
  if (statusCode != 200) {
    Serial.printf("[api] polling HTTP %d\n", statusCode);
    lastError = String("Polling HTTP ") + statusCode;
    http.end();
    return;
  }

  const String body = http.getString();
  http.end();
  lastError = "";

  JsonDocument document;
  DeserializationError error = deserializeJson(document, body);
  if (error) {
    Serial.printf("[api] JSON invalido: %s\n", error.c_str());
    lastError = "Resposta JSON invalida.";
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
  currentConfig = loadConfig();
  if (isConfigured(currentConfig)) {
    Serial.println("[config] configuracao carregada");
  } else {
    Serial.println("[config] sem configuracao persistente");
  }
}

void loop() {
  readSerialCommands();

  if (!ensureWifi()) {
    delay(50);
    return;
  }

  const unsigned long now = millis();
  if (now - lastPollAt >= POLL_INTERVAL_MS || lastPollAt == 0) {
    lastPollAt = now;
    pollServer();
  }

  delay(50);
}
