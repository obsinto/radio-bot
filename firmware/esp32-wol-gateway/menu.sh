#!/usr/bin/env bash
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir" || exit 1

env_file="${script_dir}/.env"
env_example_file="${script_dir}/.env.example"
config_file="${script_dir}/include/config.h"
upload_port="${UPLOAD_PORT:-/dev/ttyUSB0}"
monitor_baud="${MONITOR_BAUD:-115200}"
platformio_venv_dir="${PLATFORMIO_VENV_DIR:-${HOME:-${script_dir}}/.local/share/radio-bot/platformio-venv}"
platformio_cmd=()
platformio_source=""

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

try_platformio_command() {
  local source="$1"
  shift
  local -a candidate=("$@")

  if [[ "${#candidate[@]}" -eq 0 ]]; then
    return 1
  fi

  if "${candidate[@]}" --version >/dev/null 2>&1; then
    platformio_cmd=("${candidate[@]}")
    platformio_source="$source"
    return 0
  fi

  return 1
}

resolve_platformio() {
  platformio_cmd=()
  platformio_source=""

  if [[ -n "${PLATFORMIO_CMD:-}" ]]; then
    local -a configured_cmd
    read -r -a configured_cmd <<< "$PLATFORMIO_CMD"
    if try_platformio_command "PLATFORMIO_CMD" "${configured_cmd[@]}"; then
      return 0
    fi
  fi

  local managed_platformio="${platformio_venv_dir}/bin/platformio"
  if [[ -x "$managed_platformio" ]] &&
    try_platformio_command "ambiente do menu" "$managed_platformio"; then
    return 0
  fi

  local standard_platformio="${HOME:-}/.platformio/penv/bin/platformio"
  if [[ -n "${HOME:-}" && -x "$standard_platformio" ]] &&
    try_platformio_command "ambiente padrao" "$standard_platformio"; then
    return 0
  fi

  local executable
  for executable in pio platformio; do
    if command -v "$executable" >/dev/null 2>&1 &&
      try_platformio_command "$(command -v "$executable")" "$executable"; then
      return 0
    fi
  done

  if command -v python3 >/dev/null 2>&1 &&
    python3 -c "import platformio" >/dev/null 2>&1 &&
    try_platformio_command "modulo Python" python3 -m platformio; then
    return 0
  fi

  return 1
}

install_platformio() {
  if resolve_platformio; then
    echo "PlatformIO ja esta funcional: $("${platformio_cmd[@]}" --version)"
    echo "Origem: ${platformio_source}"
    if ! confirm "Atualizar/reinstalar a copia isolada mesmo assim?"; then
      return 0
    fi
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 nao foi encontrado. Instale python3 e python3-venv."
    return 1
  fi

  echo "O PlatformIO sera instalado em um ambiente isolado:"
  echo "  ${platformio_venv_dir}"
  echo "Isso nao altera os pacotes Python globais do sistema."

  run_cmd mkdir -p "$(dirname "$platformio_venv_dir")" || return 1
  if ! run_cmd python3 -m venv "$platformio_venv_dir"; then
    echo
    echo "Nao foi possivel criar o ambiente virtual."
    echo "Em Debian/Ubuntu, instale o suporte com: sudo apt install python3-venv"
    return 1
  fi

  run_cmd "${platformio_venv_dir}/bin/python" -m pip install --upgrade platformio ||
    return 1

  if ! resolve_platformio; then
    echo "A instalacao terminou, mas o PlatformIO ainda nao responde."
    return 1
  fi

  echo "PlatformIO pronto: $("${platformio_cmd[@]}" --version)"
}

ensure_platformio() {
  if resolve_platformio; then
    return 0
  fi

  echo "PlatformIO nao esta funcional."
  if command -v pio >/dev/null 2>&1; then
    echo "O comando encontrado em $(command -v pio) esta quebrado ou incompleto."
  fi
  echo "O menu pode instalar uma copia isolada sem alterar o Python do sistema."

  if confirm "Instalar/reparar o PlatformIO agora?"; then
    install_platformio
  else
    echo "Use a opcao 10 quando quiser instalar ou reparar o PlatformIO."
    return 1
  fi
}

run_pio() {
  ensure_platformio || return 1
  run_cmd "${platformio_cmd[@]}" "$@"
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
  run_pio run
}

upload_firmware() {
  ensure_config_current || return 1
  run_pio run -t upload --upload-port "$upload_port"
}

monitor_device() {
  run_pio device monitor -p "$upload_port" -b "$monitor_baud"
}

full_upload_flow() {
  write_config || return 1
  run_pio run -t upload --upload-port "$upload_port" || return 1

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
  local env_status config_status platformio_status

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

  if resolve_platformio; then
    platformio_status="$("${platformio_cmd[@]}" --version 2>/dev/null) [${platformio_source}]"
  else
    platformio_status="ausente ou quebrado"
  fi

  echo ".env: ${env_status} | config.h: ${config_status} | porta: ${upload_port} | baud: ${monitor_baud}"
  echo "PlatformIO: ${platformio_status}"
}

print_menu() {
  if [[ -t 1 ]] && command -v clear >/dev/null 2>&1; then
    clear
  fi

  echo "ESP32 WOL Gateway"
  status_line
  echo
  echo "1) Criar .env             - Copia o modelo inicial de configuracao."
  echo "2) Editar .env            - Abre Wi-Fi, API, gateway e token no editor."
  echo "3) Gerar config.h         - Converte o .env em include/config.h."
  echo "4) Build firmware         - Compila o firmware sem gravar o ESP32."
  echo "5) Upload firmware        - Compila e grava pela porta selecionada."
  echo "6) Monitor serial         - Exibe os logs do ESP32 em tempo real."
  echo "7) Config + upload        - Gera config.h, grava e oferece o monitor."
  echo "8) Alterar porta/baud     - Troca porta USB e velocidade do monitor."
  echo "9) Listar portas seriais  - Procura dispositivos ttyUSB e ttyACM."
  echo "10) Reparar PlatformIO    - Instala uma copia isolada e funcional."
  echo "0) Sair                   - Fecha este menu."
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
    10) install_platformio ;;
    0|q|Q) exit 0 ;;
    *) echo "Opcao invalida." ;;
  esac

  pause
done
