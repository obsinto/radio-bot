# Agente Legado Para Windows 7

Este agente existe para maquinas antigas em que o Wake-on-LAN so funciona bem mantendo Windows 7.

Ele nao usa Node.js, npm nem Playwright. Em vez de WebSocket, ele faz polling HTTP na API e executa comandos basicos com PowerShell.

## Limitacoes

- Nao preenche login automaticamente.
- Nao controla DOM, botoes ou player via Playwright.
- `screenshot` captura a area de trabalho inteira, nao apenas a aba do navegador.
- `play_radio` e `stop_playback` usam teclas multimidia do Windows e dependem do navegador/site respeitar essas teclas.
- `click_action`, `discover_executables` e `configure_autostart_app` nao sao suportados neste agente.

O objetivo desta versao e validar e operar o fluxo minimo: online/offline, abrir URL, capturar tela, tocar/parar por tecla de midia e desligamento.

## Pre-requisitos

- Windows 7 SP1.
- PowerShell 3 ou superior. Recomendado: Windows Management Framework 5.1.
- .NET Framework atualizado com TLS 1.2.
- Navegador instalado. Se possivel, informe o caminho do navegador no instalador.
- Computador cadastrado no painel, com `DEVICE_ID` e `DEVICE_TOKEN`.
- API publicada em HTTP/HTTPS acessivel pela maquina.

Se usar HTTPS em Windows 7, confirme que TLS 1.2 esta habilitado no sistema. Caso contrario, use HTTP apenas em uma rede privada/VPN de teste.

## Instalacao

No PowerShell, dentro da pasta do projeto:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\install-agent.ps1
```

O instalador pergunta:

- URL da API, por exemplo `https://api.seu-dominio.com`.
- `DEVICE_ID`.
- `DEVICE_TOKEN`.
- Caminho do navegador, opcional.
- Nome da tarefa agendada.
- Se o desligamento deve ser simulado.
- Intervalo de polling.

Tambem e aceito colar a URL do agente moderno, como `wss://api.seu-dominio.com/agent`; o runner converte para `https://api.seu-dominio.com`.

Por padrao:

- Pasta: `C:\RadioBOTLegacy`
- Tarefa Agendada: `RadioBOTLegacyAgent`
- Log: `C:\RadioBOTLegacy\agent.log`
- `SHUTDOWN_DRY_RUN=true`
- Polling: 5 segundos

## Validacao

Confira a tarefa:

```powershell
schtasks.exe /Query /TN RadioBOTLegacyAgent
```

Acompanhe os logs:

```powershell
Get-Content C:\RadioBOTLegacy\agent.log -Tail 80 -Wait
```

No painel, o computador deve aparecer online alguns segundos depois.

Teste primeiro:

1. `Estado`
2. `Captura de tela`
3. `Abrir e tocar`
4. `Play`
5. `Stop`

Mantenha `SHUTDOWN_DRY_RUN=true` enquanto estiver validando. O comando `Desligar` vai retornar o comando que seria executado sem desligar a maquina.

## Desinstalacao

```powershell
.\scripts\windows7\uninstall-agent.ps1
```

Para remover tambem `C:\RadioBOTLegacy`:

```powershell
.\scripts\windows7\uninstall-agent.ps1 -RemoveFiles
```

## Quando Usar o Agente Normal

Use `scripts/windows/install-agent.ps1` em Windows 10/11. Ele continua sendo o agente completo, com Playwright, Chromium persistente e automacao de pagina.

Use este agente legado apenas quando a maquina precisa permanecer em Windows 7 por causa de Wake-on-LAN ou hardware antigo.
