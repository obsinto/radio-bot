#pragma once

#define WIFI_SSID "sua-rede-wifi"
#define WIFI_PASSWORD "senha-da-rede"

#define API_BASE_URL "https://api.seu-dominio.com"
#define WOL_GATEWAY_ID "seu-wol-gateway-id"
#define WOL_GATEWAY_TOKEN "token-gerado-no-painel"

#define POLL_INTERVAL_MS 5000
#define WOL_PORT 9
#define WOL_REPEAT_COUNT 3

// MVP: facilita teste com HTTPS/Coolify sem embutir CA no firmware.
// Para producao endurecida, defina como 0 e configure ROOT_CA_PEM.
#define TLS_INSECURE 1
#define ROOT_CA_PEM ""
