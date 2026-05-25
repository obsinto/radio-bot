#!/usr/bin/env bash
set -euo pipefail

env_file="${ENV_FILE:-firmware/esp32-wol-gateway/.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

required_vars=(
  WIFI_SSID
  WIFI_PASSWORD
  API_BASE_URL
  WOL_GATEWAY_ID
  WOL_GATEWAY_TOKEN
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Variavel obrigatoria ausente: ${var_name}" >&2
    exit 1
  fi
done

escape_c_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

output_path="${1:-firmware/esp32-wol-gateway/include/config.h}"
mkdir -p "$(dirname "$output_path")"

cat > "$output_path" <<EOF
#pragma once

#define WIFI_SSID "$(escape_c_string "$WIFI_SSID")"
#define WIFI_PASSWORD "$(escape_c_string "$WIFI_PASSWORD")"

#define API_BASE_URL "$(escape_c_string "$API_BASE_URL")"
#define WOL_GATEWAY_ID "$(escape_c_string "$WOL_GATEWAY_ID")"
#define WOL_GATEWAY_TOKEN "$(escape_c_string "$WOL_GATEWAY_TOKEN")"
#define USE_CONFIG_H_SEED ${USE_CONFIG_H_SEED:-1}

#define POLL_INTERVAL_MS ${POLL_INTERVAL_MS:-5000}
#define WOL_PORT ${WOL_PORT:-9}
#define WOL_REPEAT_COUNT ${WOL_REPEAT_COUNT:-3}

#define TLS_INSECURE ${TLS_INSECURE:-1}
#define ROOT_CA_PEM "$(escape_c_string "${ROOT_CA_PEM:-}")"
EOF

echo "Config do ESP32 gerada em ${output_path}"
