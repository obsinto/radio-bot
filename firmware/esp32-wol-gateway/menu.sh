#!/usr/bin/env bash
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir" || exit 1

env_file="${script_dir}/.env"
env_example_file="${script_dir}/.env.example"
config_file="${script_dir}/include/config.h"
upload_port="${UPLOAD_PORT:-/dev/ttyUSB0}"
monitor_baud="${MONITOR_BAUD:-115200}"

pause() {
  if [[ -t 0 ]]; then
    echo
    read -r -p "Pressione Enter para voltar ao menu..." _
  fi
}

confirm() {
  local prompt="$1"
  local answer
  read -r -p "${prompt} [s/N] " answer
  case "$answer" in
    s|S|sim|SIM|Sim) return 0 ;;
    *) return 1 ;;
  esac
}

run_cmd() {
  echo
  printf '+'
  printf ' %q' "$@"
  echo

  "$@"
  local status=$?
  if [[ "$status" -eq 0 ]]; then
    echo
    echo "OK"
  else
    echo
    echo "Falhou com exit code ${status}"
  fi
  return "$status"
}

config_needs_update() {
  [[ -f "$env_file" ]] && { [[ ! -f "$config_file" ]] || [[ "$env_file" -nt "$config_file" ]]; }
}

ensure_env_exists() {
  if [[ -f "$env_file" ]]; then
    return 0
  fi

  if [[ ! -f "$env_example_file" ]]; then
    echo "Nao encontrei ${env_example_file}"
    return 1
  fi

  run_cmd cp "$env_example_file" "$env_file"
}

create_env_from_example() {
  if [[ ! -f "$env_example_file" ]]; then
    echo "Nao encontrei ${env_example_file}"
    return 1
  fi

  if [[ -f "$env_file" ]]; then
    echo ".env ja existe: ${env_file}"
    if ! confirm "Sobrescrever usando .env.example?"; then
      echo "Mantendo .env atual."
      return 0
    fi
  fi

  run_cmd cp "$env_example_file" "$env_file"
}

pick_editor() {
  if [[ -n "${EDITOR:-}" ]]; then
    printf '%s\n' "$EDITOR"
    return 0
  fi

  for candidate in nano vim vi; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

edit_env() {
  ensure_env_exists || return 1

  local editor_cmd
  if ! editor_cmd="$(pick_editor)"; then
    echo "Defina EDITOR ou edite manualmente: ${env_file}"
    return 1
  fi

  local -a editor_args
  read -r -a editor_args <<< "$editor_cmd"
  run_cmd "${editor_args[@]}" "$env_file" || return 1

  if confirm "Gerar include/config.h agora?"; then
    write_config
  else
    echo "Lembre de gerar config.h antes de build/upload."
  fi
}

write_config() {
  ensure_env_exists || return 1
  run_cmd "${script_dir}/write-config.sh"
}

ensure_config_current() {
  ensure_env_exists || return 1

  if config_needs_update; then
    echo ".env esta mais novo que include/config.h."
    if confirm "Gerar include/config.h agora?"; then
      write_config
    else
      echo "Continuando com include/config.h atual."
    fi
  fi
}

build_firmware() {
  ensure_config_current || return 1
  run_cmd pio run
}

upload_firmware() {
  ensure_config_current || return 1
  run_cmd pio run -t upload --upload-port "$upload_port"
}

monitor_device() {
  run_cmd pio device monitor -p "$upload_port" -b "$monitor_baud"
}

full_upload_flow() {
  write_config || return 1
  run_cmd pio run -t upload --upload-port "$upload_port" || return 1

  if confirm "Abrir monitor serial agora?"; then
    monitor_device
  fi
}

set_serial_options() {
  local next_port next_baud

  read -r -p "Porta de upload/monitor [${upload_port}]: " next_port
  if [[ -n "$next_port" ]]; then
    upload_port="$next_port"
  fi

  read -r -p "Baud do monitor [${monitor_baud}]: " next_baud
  if [[ -n "$next_baud" ]]; then
    monitor_baud="$next_baud"
  fi
}

list_serial_ports() {
  echo "Portas seriais encontradas:"
  find /dev -maxdepth 1 \( -name 'ttyUSB*' -o -name 'ttyACM*' \) -print 2>/dev/null | sort
}

status_line() {
  local env_status config_status

  if [[ -f "$env_file" ]]; then
    env_status="ok"
  else
    env_status="ausente"
  fi

  if [[ ! -f "$config_file" ]]; then
    config_status="ausente"
  elif config_needs_update; then
    config_status="desatualizado"
  else
    config_status="ok"
  fi

  echo ".env: ${env_status} | config.h: ${config_status} | porta: ${upload_port} | baud: ${monitor_baud}"
}

print_menu() {
  if [[ -t 1 ]] && command -v clear >/dev/null 2>&1; then
    clear
  fi

  echo "ESP32 WOL Gateway"
  status_line
  echo
  echo "1) Criar .env a partir de .env.example"
  echo "2) Editar .env"
  echo "3) Gerar include/config.h a partir do .env"
  echo "4) Build firmware"
  echo "5) Upload firmware"
  echo "6) Monitor serial"
  echo "7) Gerar config + upload + opcional monitor"
  echo "8) Alterar porta/baud"
  echo "9) Listar portas seriais"
  echo "0) Sair"
  echo
}

while true; do
  print_menu
  read -r -p "Opcao: " choice || exit 0

  case "$choice" in
    1) create_env_from_example ;;
    2) edit_env ;;
    3) write_config ;;
    4) build_firmware ;;
    5) upload_firmware ;;
    6) monitor_device ;;
    7) full_upload_flow ;;
    8) set_serial_options ;;
    9) list_serial_ports ;;
    0|q|Q) exit 0 ;;
    *) echo "Opcao invalida." ;;
  esac

  pause
done
