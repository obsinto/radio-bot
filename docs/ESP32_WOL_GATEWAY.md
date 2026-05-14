# Gateway ESP32 Wake-on-LAN

Este firmware transforma um ESP32 em ponte entre a VPS/Coolify e a rede local da radio. A VPS nao envia Wake-on-LAN direto para o computador; ela cria um comando, e o ESP32 envia o magic packet dentro da LAN.

## Preparar Backend

No painel:

1. Entre em `Configurar Wake on LAN`.
2. Crie um gateway ESP32.
3. Guarde o `WOL_GATEWAY_ID` e `WOL_GATEWAY_TOKEN`.
4. Configure o MAC do computador.
5. Associe o computador ao gateway criado.

Tambem e possivel fazer seed por ambiente:

```bash
WOL_GATEWAYS_JSON=[{"id":"esp-studio-01","name":"Gateway ESP32 Studio 01","location":"Local principal","token":"change-esp-studio-01-token"}]
```

## Preparar Firmware

Opcao recomendada, gerando `config.h` por variaveis de ambiente:

```bash
export WIFI_SSID="nome-da-rede"
export WIFI_PASSWORD="senha-da-rede"
export API_BASE_URL="https://api.seu-dominio.com"
export WOL_GATEWAY_ID="esp-studio-01"
export WOL_GATEWAY_TOKEN="token-gerado-no-painel"

./scripts/firmware/write-esp32-config.sh
```

Ou manualmente:

```bash
cd firmware/esp32-wol-gateway
cp include/config.example.h include/config.h
```

Edite `include/config.h`:

```cpp
#define WIFI_SSID "nome-da-rede"
#define WIFI_PASSWORD "senha-da-rede"
#define API_BASE_URL "https://api.seu-dominio.com"
#define WOL_GATEWAY_ID "esp-studio-01"
#define WOL_GATEWAY_TOKEN "token-gerado-no-painel"
```

Compile:

```bash
platformio run
```

Grave:

```bash
platformio run --target upload
```

Monitore logs:

```bash
platformio device monitor
```

## Como Funciona

- `GET /wol-gateway/poll?gatewayId=...`
  - autentica com `Authorization: Bearer <token>`;
  - marca o ESP32 como online;
  - retorna o proximo comando `power_on` pendente, se existir.

- `POST /wol-gateway/commands/:commandId/result?gatewayId=...`
  - autentica com o mesmo token;
  - registra sucesso ou falha do envio do magic packet.

## Checklist Do PC

- Wake-on-LAN ativo na BIOS/UEFI.
- Placa de rede configurada para acordar o computador.
- Preferencialmente conectado por cabo Ethernet.
- ESP32 e PC na mesma rede/VLAN.
- Broadcast correto, como `192.168.1.255`; se vazio, o firmware usa `255.255.255.255`.
