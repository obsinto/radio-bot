# Deploy Coolify + ESP32 WOL

Este roteiro coloca a API e o painel no ar e depois gera o firmware do ESP32 apontando para o servidor real.

## 1. Criar Recursos No Coolify

Crie:

- PostgreSQL.
- App API usando `apps/api/Dockerfile`, porta `3000`.
- App Web usando `apps/web/Dockerfile`, porta `80` (nginx servindo estatico).

No Coolify, use o caminho do arquivo Dockerfile, nao a pasta:

| App | Base Directory | Dockerfile Location | Porta |
| --- | --- | --- | --- |
| API | vazio / raiz do repo | `apps/api/Dockerfile` | `3000` |
| Web | vazio / raiz do repo | `apps/web/Dockerfile` | `80` |

Mantenha o `Base Directory` na raiz do repositorio. Os Dockerfiles copiam `packages/shared`, `package.json` e os workspaces a partir da raiz. Nao use `web` como Dockerfile, porque esse caminho aponta para uma pasta e o build falha com `failed to read dockerfile: .../web: is a directory`.

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
SITE_PROFILES_JSON=[]
DEVICES_JSON=[]
WOL_GATEWAYS_JSON=[]
AUTO_RECOVER_ENABLED=true
AUTO_RECOVER_GRACE_MS=90000
AUTO_RECOVER_BACKOFF_MS=300000
AUTO_RECOVER_INTENTIONAL_WINDOW_MS=900000
AUTO_RECOVER_SCAN_INTERVAL_MS=30000
```

Referencia local: `apps/api/.env.example`.

Com esses seeds vazios, apenas o acesso admin inicial e criado pelas variaveis acima. Cadastre radios, computadores e gateways ESP32 manualmente pelo painel. Com PostgreSQL, os cadastros feitos no painel ficam no banco.

## 3. Variaveis Do Web

Configure no app web:

```bash
VITE_API_URL=https://api.seu-dominio.com
VITE_ALLOWED_HOSTS=painel.seu-dominio.com
```

Importante: `VITE_API_URL` entra no build do frontend. Se mudar a URL da API, rode novo deploy/build do app web.

Referencia local: `apps/web/.env.example`.

## 4. Validar API

Depois do deploy:

```bash
curl -I https://api.seu-dominio.com/health
```

Esperado: HTTP 200.

## 5. Gravar Firmware Base Do ESP32

Na maquina onde voce vai compilar/gravar o ESP32:

```bash
cd firmware/esp32-wol-gateway
platformio run --target upload
platformio device monitor
```

Para producao, prefira gravar o ESP32 ja com `config.h` gerado. O fluxo via USB pelo painel existe, mas deve ser tratado como experimental ate nova validacao em bancada.

## 6. Configurar Pelo Painel USB

1. Abra o painel em producao usando HTTPS.
2. Entre em `Configuracoes > Gateways WOL`.
3. Clique em `Configurar ESP32 via USB`.
4. Crie um gateway ou selecione um existente.
5. Conecte o ESP32 no USB e permita o acesso serial no navegador.
6. Confira se a URL exibida e a API, por exemplo `https://api.seu-dominio.com`.
7. Informe Wi-Fi e grave a configuracao.
8. Aguarde o gateway aparecer online.

Se escolher gateway existente, o painel rotaciona o token. Reconfigure o ESP32 logo em seguida, porque o token antigo deixa de autenticar.

## 7. Gerar Config Do Firmware

Use este caminho para instalacao em producao:

```bash
cp firmware/esp32-wol-gateway/.env.example firmware/esp32-wol-gateway/.env
```

Edite `firmware/esp32-wol-gateway/.env`:

```bash
WIFI_SSID=nome-da-rede-local-da-radio
WIFI_PASSWORD=senha-do-wifi
API_BASE_URL=https://api.seu-dominio.com
WOL_GATEWAY_ID=seu-wol-gateway-id
WOL_GATEWAY_TOKEN=troque-token-esp32
USE_CONFIG_H_SEED=1
```

Gere o `config.h` sempre que alterar `.env`:

```bash
cd firmware/esp32-wol-gateway
./write-config.sh
```

Isso cria `firmware/esp32-wol-gateway/include/config.h`, ignorado pelo Git.

## 8. Build E Upload Com config.h

```bash
cd firmware/esp32-wol-gateway
pio run
pio run -t upload --upload-port /dev/ttyUSB0
pio device monitor -p /dev/ttyUSB0 -b 115200
```

No monitor serial, o ESP32 deve mostrar Wi-Fi conectado e chamadas de polling para a API.

## 9. Teste Do Botao Ligar

No painel:

1. Abra `Configuracoes > Gateways WOL`.
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
