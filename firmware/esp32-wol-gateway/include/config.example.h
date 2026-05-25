#pragma once

#define WIFI_SSID "sua-rede-wifi"
#define WIFI_PASSWORD "senha-da-rede"

#define API_BASE_URL "https://api.seu-dominio.com"
#define WOL_GATEWAY_ID "seu-wol-gateway-id"
#define WOL_GATEWAY_TOKEN "token-gerado-no-painel"

// Use 1 apenas quando quiser gravar esses valores como seed inicial da NVS.
// O firmware base para configuracao pelo painel deve manter 0.
// Um include/config.h local com valores reais tambem e usado como seed
// para manter compatibilidade com o fluxo antigo por arquivo.
#define USE_CONFIG_H_SEED 0

// Use 1 para forcar configuracao somente via serial mesmo com config.h local.
#define SERIAL_CONFIG_ONLY 0

#define POLL_INTERVAL_MS 5000
#define WOL_PORT 9
#define WOL_REPEAT_COUNT 3

// MVP: facilita teste com HTTPS/Coolify sem embutir CA no firmware.
// Para producao endurecida, defina como 0 e configure ROOT_CA_PEM.
#define TLS_INSECURE 1
#define ROOT_CA_PEM ""
