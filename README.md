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

2. Crie os ambientes locais conforme o app:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/agent/.env.example apps/agent/.env
```

3. Edite:

- `apps/api/.env`: usuarios, senha do painel, perfis, computadores, gateways e banco.
- `apps/web/.env`: URL da API usada pelo painel.
- `apps/agent/.env`: URL WebSocket da API e token do computador local.

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

Por padrao, nenhuma radio e criada automaticamente. Cadastre as radios manualmente no painel.

Se um dia quiser importar radios por ambiente, `SITE_PROFILES_JSON` aceita uma lista de perfis. Para manter o seed limpo:

```json
[]
```

Com PostgreSQL ativo, novas radios cadastradas pelo painel ficam salvas no banco.

## Configuracao de Computadores

Por padrao, nenhum computador e criado automaticamente. Cadastre cada computador manualmente no painel para gerar `DEVICE_ID` e `DEVICE_TOKEN`.

```json
[]
```

`profileIds` pode ter mais de uma radio para o mesmo computador. O painel usa essa lista para limitar quais radios aparecem nos comandos e agendamentos daquele computador.

No computador local, prefira os instaladores interativos. Eles perguntam a URL WebSocket da API, `DEVICE_ID` e `DEVICE_TOKEN` no terminal e nao exigem token na linha de comando.

Use sempre a URL da **API**, nao a URL do painel. Exemplo:

- Painel web: `https://painel.seu-dominio.com`
- API HTTP: `https://api.seu-dominio.com`
- Agent WebSocket: `wss://api.seu-dominio.com/agent`

As variaveis gravadas pelo instalador ficam assim:

```bash
SERVER_URL=wss://api.seu-dominio.com/agent
DEVICE_ID=seu-device-id
DEVICE_TOKEN=token-do-computador
BROWSER_PROFILE_PATH=.cache/browser/seu-device-id
HEADLESS=false
SHUTDOWN_DRY_RUN=false
```

## Wake-on-LAN com ESP32

O botao "Ligar computador" cria um comando `power_on` na API. O ESP32, instalado na mesma rede local do computador da radio, consulta a API e envia o magic packet por UDP.

Fluxo:

1. Grave o firmware base do ESP32 uma vez:

```bash
cd firmware/esp32-wol-gateway
platformio run --target upload
```

2. No painel, entre em `Configuracoes > Gateways WOL`.
3. Clique em `Configurar ESP32 via USB`.
4. Crie um gateway novo ou selecione um existente.
5. Conecte o ESP32 no USB e permita o acesso serial no navegador.
6. Confira a URL da API que sera gravada, informe Wi-Fi e grave.
7. Aguarde o painel validar o `status` serial e o gateway aparecer online.
8. Configure o MAC do computador e associe ele ao gateway ESP32.

Ao reconfigurar gateway existente, o painel rotaciona o token. O token antigo para de funcionar ate o ESP32 ser configurado novamente.

O fallback por `config.h` ainda existe para bancada ou ambientes sem Web Serial. Para usar esse modo, gere `include/config.h` com:

```bash
cp firmware/esp32-wol-gateway/.env.example firmware/esp32-wol-gateway/.env
cd firmware/esp32-wol-gateway
./write-config.sh
```

Por padrao, nenhum gateway ESP32 e criado automaticamente. Cadastre o gateway manualmente em `Configuracoes > Gateways WOL`.

Para manter o seed limpo:

```bash
WOL_GATEWAYS_JSON=[]
```

O computador precisa ter Wake-on-LAN habilitado na BIOS/UEFI e no sistema operacional. Use cabo Ethernet sempre que possivel; WOL por Wi-Fi costuma ser limitado.

## Instalacao do Agente

Linux:

```bash
./scripts/linux/install-agent.sh
```

Windows:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install-agent.ps1
```

Os instaladores sao interativos e validam a conexao WebSocket antes de registrar o servico/tarefa. Se a URL apontar para o painel, a validacao mostra uma mensagem explicita como "essa URL parece ser o painel web, nao a API".

Documentacao completa:

- `docs/LINUX_AGENT_INSTALL.md`
- `docs/WINDOWS_AGENT_INSTALL.md`

## Comandos do MVP

- `open_site`: abre a URL do perfil.
- `login`: tenta preencher usuario/senha automaticamente.
- `reload`: recarrega a pagina.
- `screenshot`: captura uma imagem do navegador local.
- `get_state`: retorna URL e titulo atual.
- `click_action`: clica em uma acao mapeada em `ACTION_MAP_JSON`.
- `play_radio`: tenta acionar o player da radio no navegador local.
- `stop_playback`: pausa audio/video e tenta acionar botoes de pause/stop.
- `shutdown`: agenda o desligamento do computador local pelo agente.

Para validar o fluxo de desligamento sem desligar a maquina, configure `SHUTDOWN_DRY_RUN=true` no agente. Em producao, use `false`.

## Agendamentos

O painel possui a secao "Agendamentos" para criar rotinas de ligar e tocar ou desligar.

- `Ligar e tocar`: envia Wake-on-LAN quando necessario, aguarda o agente ficar online, abre a radio e executa `play_radio`.
- `Desligar`: envia `shutdown` para um computador online.

Cada rotina de `Ligar e tocar` escolhe explicitamente um computador e uma radio. Assim, o mesmo computador pode ligar as 10:00 na Palmeirinha FM e as 17:30 em outra radio cadastrada.

O horario usa timezone configuravel por agendamento; o padrao recomendado para operacao local e `America/Sao_Paulo`.

## Simultaneidade

Se um perfil ja estiver ativo em outro computador, a API nao bloqueia automaticamente. O painel exibe alerta e exige duas confirmacoes antes de enviar o comando.

## Coolify

Roteiro detalhado com ESP32/WOL: `docs/COOLIFY_DEPLOY_WOL.md`.

Crie um recurso PostgreSQL e dois apps no Coolify usando este repositorio:

- API: Dockerfile `apps/api/Dockerfile`, porta `3000`.
- Web: Dockerfile `apps/web/Dockerfile`, porta `80` (nginx servindo estatico).

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

Configure HTTPS no dominio publico e use `wss://api.seu-dominio.com/agent` nos agentes locais. Nao use a URL do painel web como `SERVER_URL` do agente.
