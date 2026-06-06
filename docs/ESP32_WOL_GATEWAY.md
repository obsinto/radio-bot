# Gateway ESP32 Wake-on-LAN

Este firmware transforma um ESP32 em ponte entre a VPS/Coolify e a rede local da radio. A VPS nao envia Wake-on-LAN direto para o computador; ela cria um comando, e o ESP32 envia o magic packet dentro da LAN.

## Preparar Backend

No painel, crie ou selecione o gateway para obter `WOL_GATEWAY_ID` e `WOL_GATEWAY_TOKEN`:

1. Entre em `Configuracoes > Gateways WOL`.
2. Crie um gateway novo ou selecione um existente.
3. Copie o ID e o token exibidos pelo painel.
4. Configure o MAC do computador.
5. Associe o computador ao gateway criado.

Se selecionar gateway existente, o painel rotaciona o token antes de configurar. O token antigo para de funcionar ate o ESP32 ser reconfigurado.

Por padrao, nenhum gateway ESP32 e criado automaticamente. Para manter o seed limpo:

```bash
WOL_GATEWAYS_JSON=[]
```

## Preparar Firmware Com config.h

O caminho recomendado agora e gerar `include/config.h` a partir do `.env` do firmware e gravar o ESP32 com esses valores embutidos. Sempre que mudar Wi-Fi, API, `WOL_GATEWAY_ID` ou `WOL_GATEWAY_TOKEN`, rode `./write-config.sh` novamente antes do upload:

```bash
cp firmware/esp32-wol-gateway/.env.example firmware/esp32-wol-gateway/.env
# edite firmware/esp32-wol-gateway/.env

cd firmware/esp32-wol-gateway
./write-config.sh
pio run -t upload --upload-port /dev/ttyUSB0
pio device monitor -p /dev/ttyUSB0 -b 115200
```

O `include/config.h` local e ignorado pelo Git e tem precedencia sobre valores antigos gravados na NVS quando contem credenciais reais.

## Configuracao Via Painel USB

A configuracao via painel/USB continua existindo no firmware para `hello`, `status`, `configure` e `reset_config`, mas deve ser tratada como experimental ate ser validada novamente em bancada. Para instalacao em producao, use o fluxo por `config.h`.

Requisitos do fluxo USB:

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

## Configuracao Manual Por config.h

Alternativa manual equivalente ao `write-config.sh`:

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

Nesse modo, o `config.h` local tem precedencia sobre a NVS. Ao atualizar token, gateway ou Wi-Fi no arquivo e regravar o firmware, o ESP32 passa a usar os novos valores mesmo se havia configuracao antiga gravada.

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

Se a confirmacao HTTP nao chegar a API, o mesmo comando volta a ser entregue
depois do lease. O reenvio e intencional: pacotes WOL duplicados sao seguros e
evitam que uma queda de rede deixe o computador desligado indefinidamente.

## Checklist Do PC

- Wake-on-LAN ativo na BIOS/UEFI.
- Placa de rede configurada para acordar o computador.
- Preferencialmente conectado por cabo Ethernet.
- ESP32 e PC na mesma rede/VLAN.
- Broadcast correto, como `192.168.1.255`; se vazio, o firmware usa `255.255.255.255`.
