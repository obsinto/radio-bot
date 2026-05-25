# Instalacao do Agente no Windows

## Decisao Importante

O agente deve rodar como **Tarefa Agendada no logon do usuario**, nao como servico tradicional do Windows.

Motivo: o Chromium precisa ficar visivel para o operador local. Servicos do Windows rodam em uma sessao isolada e normalmente nao conseguem mostrar janelas na tela do usuario.

## Pre-requisitos

- Windows 10 ou 11.
- Node.js LTS instalado.
- Acesso ao painel/API publicado na VPS.
- Computador cadastrado no painel, com `DEVICE_ID` e `DEVICE_TOKEN`.
- PowerShell aberto no projeto do Radio BOT.
- Execute o instalador no usuario Windows que vai operar a maquina, porque a janela do Chromium aparece na sessao desse usuario.

## Instalacao

No PowerShell, dentro da pasta do projeto:

```powershell
Set-ExecutionPolicy -Scope Process Bypass

.\scripts\windows\install-agent.ps1
```

O instalador vai perguntar, interativamente:

- URL WebSocket da API, por exemplo `wss://api.seu-dominio.com/agent`.
- `DEVICE_ID` do computador cadastrado no painel.
- `DEVICE_TOKEN` do computador. O token nao aparece na tela.
- Nome da tarefa agendada.
- Pasta do perfil persistente do Chromium.
- Se o navegador roda headless.
- Se desligamento deve ser simulado com `SHUTDOWN_DRY_RUN`.

Importante: use a URL da **API**, nao a URL do painel web. Se o painel for `https://radio.agilytech.com` e a API for `https://radio-api.agilytech.com`, o agente deve usar `wss://radio-api.agilytech.com/agent`.

O instalador recusa `-ServerUrl`, `-DeviceId`, `-DeviceToken`, `-Headless` e `-ShutdownDryRun`; esses dados sao informados apenas pelo prompt interativo.

Por padrao, o instalador usa:

- Pasta: `C:\RadioBOT`
- Tarefa Agendada: `RadioBOTAgent`
- Perfil Chromium: `C:\RadioBOT\browser-profile`
- Browser visivel: `HEADLESS=false`
- Desligamento real: `SHUTDOWN_DRY_RUN=false`

Para validar sem permitir desligamento da maquina, responda `sim` na pergunta de `SHUTDOWN_DRY_RUN`.

## Instalacao Local Para Teste

```powershell
.\scripts\windows\install-agent.ps1
```

Quando o instalador perguntar a URL WebSocket da API, use `ws://localhost:3000/agent`.

## O Que o Instalador Faz

- Copia o projeto para `C:\RadioBOT`.
- Cria o arquivo `.env` do agente.
- Executa `npm install`.
- Instala o Chromium do Playwright.
- Compila `@radio-bot/shared` e `@radio-bot/agent`.
- Valida a conexao WebSocket com a API antes de registrar a tarefa.
- Cria uma Tarefa Agendada no logon do usuario atual.
- Inicia o agente imediatamente.

Se `npm install`, Playwright ou build falhar, o instalador para com erro e nao segue silenciosamente.

## Validacao

Confira se a tarefa existe:

```powershell
Get-ScheduledTask -TaskName RadioBOTAgent
```

Acompanhe os logs:

```powershell
Get-Content C:\RadioBOT\logs\agent.log -Tail 80 -Wait
```

Esperado no log:

```text
[agent] conectado como <device-id>
```

No painel, o computador deve aparecer como online em ate alguns segundos.

## Logs

O log local fica em:

```text
C:\RadioBOT\logs\agent.log
```

## Desinstalacao

Remove a tarefa agendada e para o processo do agente:

```powershell
.\scripts\windows\uninstall-agent.ps1
```

Para remover tambem os arquivos:

```powershell
.\scripts\windows\uninstall-agent.ps1 -RemoveFiles
```

## Reinstalacao ou Troca de Token

Execute o instalador novamente e informe os novos dados no prompt. Ele substitui a tarefa agendada e recria o `.env`.
