# Instalacao do Agente no Linux (systemd user service)

Este guia instala o agente Radio BOT como um servico **do usuario** no systemd, com `linger` habilitado pra subir automaticamente no boot (mesmo sem login grafico). Modo headless (sem janela visivel).

## Pre-requisitos

- Linux com systemd (Pop!_OS, Ubuntu, Debian, Fedora, Arch, etc.)
- Node.js 22 ou superior
- `git`, `npm`, `sudo`
- Computador ja cadastrado no painel, com `DEVICE_ID` e `DEVICE_TOKEN` em maos

## 1. Clonar o repositorio

Se ainda nao tiver:

```bash
git clone <url-do-repo> ~/Repositories/Radio-BOT
cd ~/Repositories/Radio-BOT
```

Se ja tem, pula esse passo.

## 2. Rodar o instalador

```bash
./scripts/linux/install-agent.sh \
  --server-url wss://radio-api.agilytech.com/agent \
  --device-id <seu-device-id> \
  --device-token <seu-device-token>
```

O script faz:

1. `npm install` na raiz do repo.
2. Build de `@radio-bot/shared` + `@radio-bot/agent`.
3. `npx playwright install chromium` (~250MB no primeiro deploy).
4. Escreve `apps/agent/.env` com as credenciais (chmod 600).
5. Cria `~/.config/systemd/user/radio-bot-agent.service` apontando pra esta pasta.
6. `sudo loginctl enable-linger $USER` (pede senha) — faz o servico subir no boot mesmo sem login.
7. Habilita e inicia o servico.

## 3. Verificar

```bash
# Status
systemctl --user status radio-bot-agent

# Logs em tempo real
journalctl --user -u radio-bot-agent -f
```

Esperado nos logs: `[agent] conectado como <device-id>` e silencio (sem reconexao).

No painel da VPS, o computador deve aparecer **online**.

## Opcoes do instalador

| Flag | Default | O que faz |
| --- | --- | --- |
| `--server-url URL` | obrigatorio | WebSocket da API (`wss://...`) |
| `--device-id ID` | obrigatorio | ID do computador no painel |
| `--device-token TOKEN` | obrigatorio | Token gerado pelo painel |
| `--repo-dir PATH` | pasta atual | Raiz do repo Radio BOT |
| `--headless true\|false` | `true` | Modo do navegador Playwright |
| `--service-name NAME` | `radio-bot-agent` | Nome do servico systemd |
| `--no-linger` | linger ON | Pula `loginctl enable-linger` |
| `--skip-build` | build ON | Reaproveita build existente |

## Atualizar para uma versao nova

```bash
cd ~/Repositories/Radio-BOT
git pull
npm install
npm run build -w @radio-bot/shared
npm run build -w @radio-bot/agent
systemctl --user restart radio-bot-agent
```

Ou rode o instalador de novo passando `--skip-build` se quiser:

```bash
./scripts/linux/install-agent.sh \
  --server-url wss://radio-api.agilytech.com/agent \
  --device-id <id> \
  --device-token <token> \
  --skip-build
```

## Comandos uteis

```bash
# Parar temporariamente
systemctl --user stop radio-bot-agent

# Iniciar
systemctl --user start radio-bot-agent

# Reiniciar
systemctl --user restart radio-bot-agent

# Logs (ultimas 100 linhas)
journalctl --user -u radio-bot-agent -n 100 --no-pager

# Logs ao vivo
journalctl --user -u radio-bot-agent -f
```

## Desinstalar

```bash
cd ~/Repositories/Radio-BOT
./scripts/linux/uninstall-agent.sh
```

Faz:

1. `systemctl --user stop radio-bot-agent`
2. `systemctl --user disable radio-bot-agent`
3. Remove `~/.config/systemd/user/radio-bot-agent.service`
4. `systemctl --user daemon-reload`

**O que NAO e removido por padrao:**

- O repositorio clonado (`~/Repositories/Radio-BOT`).
- O `.env` com as credenciais (`apps/agent/.env`).
- O perfil persistente do Chromium (`apps/agent/.cache/browser/<device-id>`).
- O `linger` do seu usuario.

Pra fazer limpeza completa:

```bash
./scripts/linux/uninstall-agent.sh --remove-env --disable-linger
rm -rf ~/Repositories/Radio-BOT/apps/agent/.cache
# se quiser apagar o repo inteiro:
# rm -rf ~/Repositories/Radio-BOT
```

## Trocar de modo headless para visivel

Edita `apps/agent/.env` e troca `HEADLESS=true` por `HEADLESS=false`. Depois:

```bash
systemctl --user restart radio-bot-agent
```

**Importante:** modo visivel exige sessao grafica ativa. Se voce tiver auto-login configurado no GDM/Pop, funciona. Caso contrario, o navegador nao consegue iniciar e o agent reinicia em loop.

## Troubleshooting

**Servico falha com `npm: command not found`**

O `PATH` do user systemd nao tem o npm. Conferir com:

```bash
which npm
```

Se estiver em algo como `/home/$USER/.nvm/versions/node/...`, edita o unit pra usar o caminho completo:

```bash
nano ~/.config/systemd/user/radio-bot-agent.service
```

Troca a linha `ExecStart=` pra usar o caminho absoluto que o `which npm` mostrou. Depois:

```bash
systemctl --user daemon-reload
systemctl --user restart radio-bot-agent
```

**Servico reinicia em loop (codigo 1)**

Verifica os logs:

```bash
journalctl --user -u radio-bot-agent -n 200 --no-pager
```

Causas comuns:

- `DEVICE_TOKEN` errado ou nao cadastrado no painel.
- API offline ou domain DNS quebrado.
- Playwright nao instalou o Chromium — roda manualmente:
  ```bash
  cd ~/Repositories/Radio-BOT
  npx playwright install --with-deps chromium
  ```

**Servico nao sobe no boot**

Confirma que o linger esta habilitado:

```bash
loginctl show-user $USER | grep Linger
```

Esperado: `Linger=yes`. Se nao, roda:

```bash
sudo loginctl enable-linger $USER
```
