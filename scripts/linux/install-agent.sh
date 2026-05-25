#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<USAGE
Uso:
  $(basename "$0") [opcoes]

Este instalador e interativo. Ele pergunta a URL WebSocket da API,
DEVICE_ID e DEVICE_TOKEN no terminal. Nao passe credenciais por argumentos.

Opcionais:
  --repo-dir PATH         Pasta do repositorio (default: pasta atual)
  --service-name NAME     Nome do servico systemd (default: radio-bot-agent)
  --no-linger             Nao habilita linger (servico so sobe se houver login)
  --skip-build            Pula instalacao de deps e build
  -h, --help              Mostra esta ajuda

USAGE
}

SERVER_URL=""
DEVICE_ID=""
DEVICE_TOKEN=""
REPO_DIR=""
HEADLESS=""
SHUTDOWN_DRY_RUN=""
SERVICE_NAME="radio-bot-agent"
ENABLE_LINGER=1
SKIP_BUILD=0

reject_inline_config() {
  echo "Parametro '$1' nao e mais aceito." >&2
  echo "Execute o instalador sem credenciais/configuracao do agente na linha de comando; ele vai perguntar os dados interativamente." >&2
  exit 1
}

prompt_required() {
  local label="$1"
  local default_value="${2:-}"
  local value=""

  while true; do
    if [[ -n "$default_value" ]]; then
      read -r -p "$label [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -r -p "$label: " value
    fi

    if [[ -n "${value//[[:space:]]/}" ]]; then
      printf '%s' "$value"
      return
    fi

    echo "Valor obrigatorio." >&2
  done
}

prompt_secret() {
  local label="$1"
  local current_value="${2:-}"
  local value=""

  while true; do
    if [[ -n "$current_value" ]]; then
      read -r -s -p "$label [ENTER para manter o atual]: " value
      echo
      if [[ -z "$value" ]]; then
        printf '%s' "$current_value"
        return
      fi
    else
      read -r -s -p "$label: " value
      echo
    fi

    if [[ -n "${value//[[:space:]]/}" ]]; then
      printf '%s' "$value"
      return
    fi

    echo "Valor obrigatorio." >&2
  done
}

prompt_bool() {
  local label="$1"
  local default_value="$2"
  local answer=""
  local suffix="s/N"

  if [[ "$default_value" == "true" ]]; then
    suffix="S/n"
  fi

  while true; do
    read -r -p "$label [$suffix]: " answer
    answer="${answer,,}"

    if [[ -z "$answer" ]]; then
      printf '%s' "$default_value"
      return
    fi

    case "$answer" in
      s|sim|y|yes|true|1)
        printf 'true'
        return
        ;;
      n|nao|no|false|0)
        printf 'false'
        return
        ;;
      *)
        echo "Responda sim ou nao." >&2
        ;;
    esac
  done
}

validate_ws_url_format() {
  local url="$1"
  case "$url" in
    ws://*|wss://*) ;;
    *)
      echo "SERVER_URL invalida: use ws:// ou wss:// e a rota /agent da API." >&2
      exit 1
      ;;
  esac

  if [[ "$url" != */agent* ]]; then
    echo "[aviso] A URL do agente normalmente termina com /agent." >&2
    echo "[aviso] Exemplo: wss://api.seu-dominio.com/agent" >&2
  fi
}

load_existing_agent_env() {
  local env_file="$1"
  EXISTING_SERVER_URL=""
  EXISTING_DEVICE_ID=""
  EXISTING_DEVICE_TOKEN=""
  EXISTING_HEADLESS=""
  EXISTING_SHUTDOWN_DRY_RUN=""

  if [[ ! -f "$env_file" ]]; then
    return
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      SERVER_URL) EXISTING_SERVER_URL="$value" ;;
      DEVICE_ID) EXISTING_DEVICE_ID="$value" ;;
      DEVICE_TOKEN) EXISTING_DEVICE_TOKEN="$value" ;;
      HEADLESS) EXISTING_HEADLESS="$value" ;;
      SHUTDOWN_DRY_RUN) EXISTING_SHUTDOWN_DRY_RUN="$value" ;;
    esac
  done < "$env_file"
}

validate_agent_connection() {
  echo "[check] validando WebSocket da API"
  local output=""
  local status=0

  set +e
  output="$(
    cd "$REPO_DIR" && SERVER_URL="$SERVER_URL" DEVICE_ID="$DEVICE_ID" DEVICE_TOKEN="$DEVICE_TOKEN" node --input-type=module -e '
import WebSocket from "ws";

const serverUrl = process.env.SERVER_URL ?? "";
const deviceId = process.env.DEVICE_ID ?? "";
const token = process.env.DEVICE_TOKEN ?? "";

let url;
try {
  url = new URL(serverUrl);
} catch (error) {
  console.error(`Falha WebSocket: SERVER_URL invalida (${error.message}).`);
  process.exit(2);
}

url.searchParams.set("deviceId", deviceId);
url.searchParams.set("token", token);

let settled = false;
let socket;
const finish = (code, message) => {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timer);
  if (message) {
    (code === 0 ? console.log : console.error)(message);
  }
  try {
    socket?.close();
  } catch {
  }
  process.exit(code);
};

const timer = setTimeout(() => {
  finish(3, "Falha WebSocket: timeout aguardando confirmacao da API.");
}, 8000);

socket = new WebSocket(url, { handshakeTimeout: 8000 });

socket.on("message", (raw) => {
  try {
    const message = JSON.parse(raw.toString());
    if (message.type === "registered") {
      finish(0, `[check] WebSocket registrado como ${message.deviceId}.`);
    }
  } catch {
  }
});

socket.on("unexpected-response", (_request, response) => {
  const contentType = String(response.headers["content-type"] ?? "");
  let message = `Falha WebSocket: servidor respondeu HTTP ${response.statusCode}`;
  if (contentType) {
    message += ` (${contentType})`;
  }
  message += ".";

  if (response.statusCode === 200 && contentType.includes("text/html")) {
    message += "\nEssa URL parece ser o painel web, nao a API. Use a URL WebSocket da API, por exemplo wss://api.seu-dominio.com/agent.";
  } else if (response.statusCode === 404) {
    message += "\nA rota /agent nao foi encontrada. Confira o dominio da API e o proxy.";
  } else if (response.statusCode === 502 || response.statusCode === 503 || response.statusCode === 504) {
    message += "\nA API ou o proxy reverso nao esta aceitando a conexao agora.";
  }

  finish(4, message);
});

socket.on("close", (code, reasonBuffer) => {
  if (settled) {
    return;
  }
  const reason = reasonBuffer.toString();
  if (code === 1008) {
    finish(5, "Falha WebSocket: DEVICE_ID ou DEVICE_TOKEN recusado pela API.");
    return;
  }
  finish(6, `Falha WebSocket: conexao fechada antes do registro (codigo ${code}${reason ? `, ${reason}` : ""}).`);
});

socket.on("error", (error) => {
  finish(7, `Falha WebSocket: ${error.message}`);
});
'
  )"
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "$output" >&2
    echo "[erro] Ajuste a URL/API/credenciais e rode o instalador novamente." >&2
    exit 1
  fi

  echo "$output"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url|--device-id|--device-token|--headless) reject_inline_config "$1" ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --no-linger) ENABLE_LINGER=0; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Opcao desconhecida: $1" >&2; print_usage; exit 1 ;;
  esac
done

if [[ -z "$REPO_DIR" ]]; then
  REPO_DIR="$(pwd)"
fi
REPO_DIR="$(cd "$REPO_DIR" && pwd)"

if [[ ! -f "$REPO_DIR/apps/agent/package.json" ]]; then
  echo "Pasta nao parece ser o repositorio Radio BOT: $REPO_DIR" >&2
  echo "Use --repo-dir apontando pra raiz do repo." >&2
  exit 1
fi

command -v node >/dev/null || { echo "node nao encontrado. Instale Node.js 22+ antes." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm nao encontrado." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd nao encontrado." >&2; exit 1; }

NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
NODE_VERSION="$(node -v)"
echo "[info] usando node $NODE_VERSION em $REPO_DIR"

ENV_FILE="$REPO_DIR/apps/agent/.env"
load_existing_agent_env "$ENV_FILE"

echo
echo "[config] Instalacao interativa do Radio BOT Agent"
echo "[config] Use a URL da API, nao a URL do painel."
echo "[config] Exemplo: wss://api.seu-dominio.com/agent"
echo

SERVER_URL="$(prompt_required "URL WebSocket da API" "$EXISTING_SERVER_URL")"
DEVICE_ID="$(prompt_required "Device ID do computador" "$EXISTING_DEVICE_ID")"
DEVICE_TOKEN="$(prompt_secret "Device token" "$EXISTING_DEVICE_TOKEN")"
HEADLESS="$(prompt_bool "Rodar navegador em modo headless (sem janela visivel)?" "${EXISTING_HEADLESS:-true}")"
SHUTDOWN_DRY_RUN="$(prompt_bool "Simular desligamento do computador (SHUTDOWN_DRY_RUN)?" "${EXISTING_SHUTDOWN_DRY_RUN:-false}")"

validate_ws_url_format "$SERVER_URL"

if [[ "$SKIP_BUILD" -ne 1 ]]; then
  echo "[install] npm install"
  (cd "$REPO_DIR" && npm install)
  echo "[build] shared + agent"
  (cd "$REPO_DIR" && npm run build -w @radio-bot/shared && npm run build -w @radio-bot/agent)
  echo "[playwright] instalando chromium + deps"
  (cd "$REPO_DIR" && npx playwright install chromium)
fi

validate_agent_connection

echo "[env] escrevendo $ENV_FILE"
cat > "$ENV_FILE" <<EOF
SERVER_URL=$SERVER_URL
DEVICE_ID=$DEVICE_ID
DEVICE_TOKEN=$DEVICE_TOKEN
BROWSER_PROFILE_PATH=.cache/browser/$DEVICE_ID
HEADLESS=$HEADLESS
SHUTDOWN_DRY_RUN=$SHUTDOWN_DRY_RUN
ACTION_MAP_JSON={}
EOF
chmod 600 "$ENV_FILE"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"

echo "[systemd] gerando $UNIT_FILE"

display_env=""
unit_after="network-online.target"
unit_wants="network-online.target"
if [[ "$HEADLESS" == "false" ]]; then
  detected_display="${DISPLAY:-:0}"
  detected_xauthority="${XAUTHORITY:-/run/user/$(id -u)/gdm/Xauthority}"
  detected_wayland="${WAYLAND_DISPLAY:-}"
  display_env="Environment=DISPLAY=$detected_display
Environment=XAUTHORITY=$detected_xauthority"
  if [[ -n "$detected_wayland" ]]; then
    display_env="$display_env
Environment=WAYLAND_DISPLAY=$detected_wayland"
  fi
  unit_after="$unit_after graphical-session.target"
  unit_wants="$unit_wants graphical-session.target"
fi

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Radio BOT Agent ($DEVICE_ID)
After=$unit_after
Wants=$unit_wants

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
$display_env
ExecStart=$NPM_BIN run start -w @radio-bot/agent
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

if [[ "$ENABLE_LINGER" -eq 1 ]]; then
  if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    echo "[linger] ja habilitado para $USER"
  else
    echo "[linger] habilitando (precisa de sudo)"
    sudo loginctl enable-linger "$USER"
  fi
fi

systemctl --user enable "$SERVICE_NAME.service"
systemctl --user restart "$SERVICE_NAME.service"

echo
echo "Servico '$SERVICE_NAME' instalado e iniciado."
echo "Status:  systemctl --user status $SERVICE_NAME"
echo "Logs:    journalctl --user -u $SERVICE_NAME -f"
echo "Parar:   systemctl --user stop $SERVICE_NAME"
echo "Remover: $REPO_DIR/scripts/linux/uninstall-agent.sh --service-name $SERVICE_NAME"
