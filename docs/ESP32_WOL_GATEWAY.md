# Gateway ESP32 Wake-on-LAN

Este firmware transforma um ESP32 em ponte entre a VPS/Coolify e a rede local da radio. A VPS nao envia Wake-on-LAN direto para o computador; ela cria um comando, e o ESP32 envia o magic packet dentro da LAN.

## Preparar Backend

No painel:

1. Entre em `Configuracoes > Gateways WOL`.
2. Clique em `Configurar ESP32 via USB`.
3. Crie um gateway novo ou selecione um existente.
4. Conecte o ESP32 no USB e permita o acesso serial no navegador.
5. Informe Wi-Fi, confira a URL da API e grave a configuracao.
6. Aguarde o painel validar `status` via serial e o gateway aparecer online.
7. Configure o MAC do computador.
8. Associe o computador ao gateway criado.

Se selecionar gateway existente, o painel rotaciona o token antes de configurar. O token antigo para de funcionar ate o ESP32 ser reconfigurado.

Por padrao, nenhum gateway ESP32 e criado automaticamente. Para manter o seed limpo:

```bash
WOL_GATEWAYS_JSON=[]
```

## Preparar Firmware Base

O caminho recomendado e gravar o firmware base uma vez e configurar pelo painel via USB:

```bash
cd firmware/esp32-wol-gateway
platformio run --target upload
```

Com `include/config.example.h`, o firmware base inicia sem credenciais persistentes e aguarda configuracao serial.

## Configuracao Via Painel

Requisitos:

- Chrome, Edge ou Brave desktop.
- Painel em HTTPS em producao.
- ESP32 com o firmware base gravado.

Fluxo serial:

1. O navegador abre a porta a 115200 baud.
2. O painel envia `hello` e valida `protocolVersion`.
3. O painel envia `configure` com Wi-Fi, URL da API, gateway ID e token.
4. O ESP32 salva em NVS (`Preferences`) e reinicia.
5. O painel consulta `status` e espera o gateway ficar online na API.

O firmware nunca retorna `wifiPassword` nem `gatewayToken` em respostas seriais.

## Fallback Por config.h

Opcionalmente, gere `config.h` a partir do `.env` do firmware:

```bash
cp firmware/esp32-wol-gateway/.env.example firmware/esp32-wol-gateway/.env
# edite firmware/esp32-wol-gateway/.env

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
#define WOL_GATEWAY_ID "seu-wol-gateway-id"
#define WOL_GATEWAY_TOKEN "token-gerado-no-painel"
#define USE_CONFIG_H_SEED 1
```

Nesse modo, o firmware grava esses valores como seed inicial na NVS no primeiro boot. Para voltar ao fluxo pelo painel, limpe a configuracao pelo wizard ou envie `reset_config` via serial.

## Build Manual

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

- `POST /api/wol-gateways/:id/rotate-token`
  - exige sessao admin;
  - gera novo token para reconfigurar gateway existente;
  - retorna o token somente nessa resposta.

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
