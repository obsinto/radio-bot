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

.\scripts\windows\install-agent.ps1 `
  -ServerUrl "wss://api.seu-dominio.com/agent" `
  -DeviceId "studio-01" `
  -DeviceToken "token-gerado-no-painel"
```

Por padrao, o instalador usa:

- Pasta: `C:\RadioBOT`
- Tarefa Agendada: `RadioBOTAgent`
- Perfil Chromium: `C:\RadioBOT\browser-profile`
- Browser visivel: `HEADLESS=false`

## Instalacao Local Para Teste

```powershell
.\scripts\windows\install-agent.ps1 `
  -ServerUrl "ws://localhost:3000/agent" `
  -DeviceId "studio-01" `
  -DeviceToken "change-studio-01-token"
```

## O Que o Instalador Faz

- Copia o projeto para `C:\RadioBOT`.
- Cria o arquivo `.env` do agente.
- Executa `npm install`.
- Instala o Chromium do Playwright.
- Compila `@radio-bot/shared` e `@radio-bot/agent`.
- Cria uma Tarefa Agendada no logon do usuario atual.
- Inicia o agente imediatamente.

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

Execute o instalador novamente com os novos parametros. Ele substitui a tarefa agendada e recria o `.env`.
