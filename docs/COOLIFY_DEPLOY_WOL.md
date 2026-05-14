# Deploy Coolify + ESP32 WOL

Este roteiro coloca a API e o painel no ar e depois gera o firmware do ESP32 apontando para o servidor real.

## 1. Criar Recursos No Coolify

Crie:

- PostgreSQL.
- App API usando `apps/api/Dockerfile`, porta `3000`.
- App Web usando `apps/web/Dockerfile`, porta `4173`.

Dominios sugeridos:

- API: `https://api.seu-dominio.com`
- Web: `https://painel.seu-dominio.com`

## 2. Variaveis Da API

Configure no app da API:

```bash
PORT=3000
HOST=0.0.0.0
APP_URL=https://painel.seu-dominio.com
DATABASE_URL=postgresql://usuario:senha@host:5432/radio_bot
JWT_SECRET=troque-por-uma-chave-longa
ENCRYPTION_KEY=troque-por-uma-chave-longa-de-32-ou-mais-caracteres
ADMIN_EMAIL=admin@radio.local
ADMIN_PASSWORD=troque-esta-senha
SITE_PROFILES_JSON=[{"id":"oliveira-fm","name":"Oliveira FM","siteUrl":"https://site-da-radio.example","username":"","password":""}]
DEVICES_JSON=[{"id":"studio-01","name":"Studio 01","location":"Local principal","token":"troque-token-agent","profileIds":["oliveira-fm"],"wolGatewayId":"esp-studio-01"}]
WOL_GATEWAYS_JSON=[{"id":"esp-studio-01","name":"Gateway ESP32 Studio 01","location":"Local principal","token":"troque-token-esp32"}]
```

Depois do primeiro deploy com PostgreSQL, novos cadastros feitos no painel ficam no banco.

## 3. Variaveis Do Web

Configure no app web:

```bash
VITE_API_URL=https://api.seu-dominio.com
```

Importante: `VITE_API_URL` entra no build do frontend. Se mudar a URL da API, rode novo deploy/build do app web.

## 4. Validar API

Depois do deploy:

```bash
curl -I https://api.seu-dominio.com/health
```

Esperado: HTTP 200.

## 5. Gerar Config Do Firmware

Na maquina onde voce vai compilar/gravar o ESP32:

```bash
export WIFI_SSID="nome-da-rede-local-da-radio"
export WIFI_PASSWORD="senha-do-wifi"
export API_BASE_URL="https://api.seu-dominio.com"
export WOL_GATEWAY_ID="esp-studio-01"
export WOL_GATEWAY_TOKEN="troque-token-esp32"

./scripts/firmware/write-esp32-config.sh
```

Isso cria `firmware/esp32-wol-gateway/include/config.h`, ignorado pelo Git.

## 6. Build E Upload Do ESP32

```bash
cd firmware/esp32-wol-gateway
platformio run
platformio run --target upload
platformio device monitor
```

No monitor serial, o ESP32 deve mostrar Wi-Fi conectado e chamadas de polling para a API.

## 7. Teste Do Botao Ligar

No painel:

1. Abra `Configurar Wake on LAN`.
2. Confirme que o gateway ESP32 aparece online.
3. Configure o MAC do computador.
4. Associe o computador ao gateway.
5. Clique em `Ligar computador`.

O historico deve sair de `queued` para `succeeded` quando o ESP32 postar o resultado.

## Checklist Do Computador

- Wake-on-LAN ativo na BIOS/UEFI.
- Placa de rede configurada para acordar o computador.
- Computador preferencialmente ligado por cabo Ethernet.
- ESP32 e computador na mesma rede/VLAN.
- Broadcast correto, por exemplo `192.168.1.255`.
