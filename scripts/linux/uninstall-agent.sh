#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="radio-bot-agent"
DISABLE_LINGER=0
REMOVE_ENV=0

print_usage() {
  cat <<USAGE
Uso:
  $(basename "$0") [opcoes]

Opcoes:
  --service-name NAME   Nome do servico (default: radio-bot-agent)
  --disable-linger      Desabilita linger do usuario (sudo)
  --remove-env          Remove tambem apps/agent/.env
  -h, --help            Mostra esta ajuda

USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --disable-linger) DISABLE_LINGER=1; shift ;;
    --remove-env) REMOVE_ENV=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Opcao desconhecida: $1" >&2; print_usage; exit 1 ;;
  esac
done

UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"

if systemctl --user list-unit-files 2>/dev/null | grep -q "^$SERVICE_NAME.service"; then
  echo "[systemd] parando e desabilitando $SERVICE_NAME"
  systemctl --user stop "$SERVICE_NAME.service" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME.service" 2>/dev/null || true
fi

if [[ -f "$UNIT_FILE" ]]; then
  echo "[systemd] removendo $UNIT_FILE"
  rm -f "$UNIT_FILE"
fi

systemctl --user daemon-reload

if [[ "$DISABLE_LINGER" -eq 1 ]]; then
  echo "[linger] desabilitando para $USER (precisa de sudo)"
  sudo loginctl disable-linger "$USER" || true
fi

if [[ "$REMOVE_ENV" -eq 1 ]]; then
  env_candidates=(
    "$(pwd)/apps/agent/.env"
    "$HOME/Repositories/Radio-BOT/apps/agent/.env"
  )
  for env_file in "${env_candidates[@]}"; do
    if [[ -f "$env_file" ]]; then
      echo "[env] removendo $env_file"
      rm -f "$env_file"
    fi
  done
fi

echo
echo "Desinstalacao concluida."
