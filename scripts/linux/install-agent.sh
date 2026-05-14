#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<USAGE
Uso:
  $(basename "$0") --server-url <wss://...> --device-id <id> --device-token <token> [opcoes]

Obrigatorios:
  --server-url URL        URL WebSocket da API (ex: wss://radio-api.agilytech.com/agent)
  --device-id ID          ID do computador cadastrado no painel
  --device-token TOKEN    Token do computador

Opcionais:
  --repo-dir PATH         Pasta do repositorio (default: pasta atual)
  --headless true|false   Modo do navegador (default: true)
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
HEADLESS="true"
SERVICE_NAME="radio-bot-agent"
ENABLE_LINGER=1
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --device-id) DEVICE_ID="$2"; shift 2 ;;
    --device-token) DEVICE_TOKEN="$2"; shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --headless) HEADLESS="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --no-linger) ENABLE_LINGER=0; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Opcao desconhecida: $1" >&2; print_usage; exit 1 ;;
  esac
done

if [[ -z "$SERVER_URL" || -z "$DEVICE_ID" || -z "$DEVICE_TOKEN" ]]; then
  echo "Faltam parametros obrigatorios." >&2
  print_usage
  exit 1
fi

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

if [[ "$SKIP_BUILD" -ne 1 ]]; then
  echo "[install] npm install"
  (cd "$REPO_DIR" && npm install)
  echo "[build] shared + agent"
  (cd "$REPO_DIR" && npm run build -w @radio-bot/shared && npm run build -w @radio-bot/agent)
  echo "[playwright] instalando chromium + deps"
  (cd "$REPO_DIR" && npx playwright install chromium)
fi

ENV_FILE="$REPO_DIR/apps/agent/.env"
echo "[env] escrevendo $ENV_FILE"
cat > "$ENV_FILE" <<EOF
SERVER_URL=$SERVER_URL
DEVICE_ID=$DEVICE_ID
DEVICE_TOKEN=$DEVICE_TOKEN
BROWSER_PROFILE_PATH=.cache/browser/$DEVICE_ID
HEADLESS=$HEADLESS
ACTION_MAP_JSON={}
EOF
chmod 600 "$ENV_FILE"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"

echo "[systemd] gerando $UNIT_FILE"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Radio BOT Agent ($DEVICE_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
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
