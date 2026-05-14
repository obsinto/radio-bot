# Radio BOT

MVP para controlar, pelo navegador, um site de radio em computadores locais diferentes, usando uma VPS como central de comando.

## Estrutura

- `apps/api`: backend HTTP/WebSocket.
- `apps/web`: painel web.
- `apps/agent`: agente local que controla o navegador com Playwright.
- `packages/shared`: tipos compartilhados entre API, painel e agente.
- `firmware/esp32-wol-gateway`: firmware PlatformIO do ESP32 para Wake-on-LAN.

## Rodando Localmente

1. Instale as dependencias:

```bash
npm install
```

2. Crie o ambiente local:

```bash
cp .env.example .env
```

3. Edite `.env` com usuarios, senha do painel, perfis de radio e tokens dos agentes.

4. Em terminais separados:

```bash
npm run dev:api
npm run dev:web
npm run dev:agent
```

URLs locais:

- Painel: `http://localhost:5173`
- API: `http://localhost:3000`
- Healthcheck: `http://localhost:3000/health`

## Banco de Dados

O projeto suporta dois modos:

- Sem `DATABASE_URL`: usa armazenamento em memoria. Serve para teste rapido, mas tudo e perdido ao reiniciar a API.
- Com `DATABASE_URL`: usa PostgreSQL, cria as tabelas automaticamente e persiste radios, computadores, comandos e historico.

Para o uso real com VPS/Coolify, use PostgreSQL. SQLite serviria para um MVP pequeno em uma unica maquina, mas PostgreSQL lida melhor com deploy em container, backups, conexoes simultaneas, crescimento do painel e manutencao em producao.

Variaveis principais:

```bash
DATABASE_URL=postgresql://usuario:senha@host:5432/radio_bot
ENCRYPTION_KEY=uma-chave-longa-com-32-ou-mais-caracteres
```

As credenciais dos perfis de radio sao salvas criptografadas com `ENCRYPTION_KEY`. Nao troque essa chave depois que houver perfis cadastrados, ou os logins salvos nao poderao ser descriptografados.

## Configuracao de Radios

`SITE_PROFILES_JSON` recebe uma lista de perfis. Cada perfil representa uma radio ou conta do site:

```json
[{"id":"oliveira-fm","name":"Oliveira FM","siteUrl":"http://app.radios.srv.br","username":"","password":""}]
```

Com PostgreSQL ativo, essa lista funciona como seed inicial. Novas radios cadastradas pelo painel ficam salvas no banco.

## Configuracao de Computadores

Cada computador local precisa de um `DEVICE_ID` e `DEVICE_TOKEN` proprios. O painel tambem consegue gerar novos tokens ao cadastrar um computador:

```json
[{"id":"studio-01","name":"Studio 01","location":"Local principal","token":"change-studio-01-token","profileIds":["oliveira-fm"],"wolGatewayId":"esp-studio-01"}]
```

No computador local, configure:

```bash
SERVER_URL=wss://seu-dominio.com/agent
DEVICE_ID=studio-01
DEVICE_TOKEN=token-do-computador
BROWSER_PROFILE_PATH=.cache/browser/studio-01
HEADLESS=false
```

## Wake-on-LAN com ESP32

O botao "Ligar computador" cria um comando `power_on` na API. O ESP32, instalado na mesma rede local do computador da radio, consulta a API e envia o magic packet por UDP.

Fluxo:

1. Cadastre um gateway ESP32 no painel em "Configurar Wake on LAN".
2. Anote `WOL_GATEWAY_ID` e `WOL_GATEWAY_TOKEN` mostrados no painel.
3. Configure o MAC do computador e associe ele ao gateway ESP32.
4. Copie `firmware/esp32-wol-gateway/include/config.example.h` para `firmware/esp32-wol-gateway/include/config.h`.
5. Preencha Wi-Fi, `API_BASE_URL`, `WOL_GATEWAY_ID` e `WOL_GATEWAY_TOKEN`.
6. Grave o ESP32:

```bash
cd firmware/esp32-wol-gateway
platformio run --target upload
```

Para seed via ambiente, use:

```bash
WOL_GATEWAYS_JSON=[{"id":"esp-studio-01","name":"Gateway ESP32 Studio 01","location":"Local principal","token":"change-esp-studio-01-token"}]
```

O computador precisa ter Wake-on-LAN habilitado na BIOS/UEFI e no sistema operacional. Use cabo Ethernet sempre que possivel; WOL por Wi-Fi costuma ser limitado.

## Instalacao do Agente no Windows

O instalador Windows esta em `scripts/windows/install-agent.ps1`.

Documentacao completa: `docs/WINDOWS_AGENT_INSTALL.md`.

## Comandos do MVP

- `open_site`: abre a URL do perfil.
- `login`: tenta preencher usuario/senha automaticamente.
- `reload`: recarrega a pagina.
- `screenshot`: captura uma imagem do navegador local.
- `get_state`: retorna URL e titulo atual.
- `click_action`: clica em uma acao mapeada em `ACTION_MAP_JSON`.

## Simultaneidade

Se um perfil ja estiver ativo em outro computador, a API nao bloqueia automaticamente. O painel exibe alerta e exige duas confirmacoes antes de enviar o comando.

## Coolify

Roteiro detalhado com ESP32/WOL: `docs/COOLIFY_DEPLOY_WOL.md`.

Crie um recurso PostgreSQL e dois apps no Coolify usando este repositorio:

- API: Dockerfile `apps/api/Dockerfile`, porta `3000`.
- Web: Dockerfile `apps/web/Dockerfile`, porta `4173`.

Variaveis da API no Coolify:

```bash
PORT=3000
HOST=0.0.0.0
APP_URL=https://painel.seu-dominio.com
DATABASE_URL=postgresql://...
JWT_SECRET=...
ENCRYPTION_KEY=...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
SITE_PROFILES_JSON=[...]
DEVICES_JSON=[...]
WOL_GATEWAYS_JSON=[...]
```

Variaveis do painel web:

```bash
VITE_API_URL=https://api.seu-dominio.com
```

Configure HTTPS no dominio publico e use `wss://api.seu-dominio.com/agent` nos agentes locais.
# radio-bot
