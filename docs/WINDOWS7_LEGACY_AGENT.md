# Agente Legado Para Windows 7

Este agente existe para maquinas antigas em que o Wake-on-LAN so funciona bem mantendo Windows 7.

Ele nao usa Node.js, npm nem Playwright. Em vez de WebSocket, ele faz polling HTTP na API e executa comandos basicos com PowerShell.

## Como Funciona

O agente cria uma tarefa agendada no logon do usuario e executa `run-agent.ps1` em loop.

No Chrome, ele abre a radio com:

```text
--remote-debugging-port=9222
--user-data-dir=C:\RadioBOTLegacy\chrome-profile
```

Quando recebe `play_radio` ou `stop_playback`, ele tenta controlar a pagina pelo Chrome DevTools local (`127.0.0.1:9222`), procurando botoes de play/stop e chamando `play()` ou `pause()` em elementos `audio`/`video`. Se isso falhar, usa teclas multimidia como fallback.

## Limitacoes

- Nao preenche login automaticamente.
- Nao usa Playwright; o controle de pagina e limitado ao Chrome DevTools local.
- `screenshot` captura a area de trabalho inteira, nao apenas a aba do navegador.
- `play_radio` e `stop_playback` tentam Chrome DevTools primeiro e depois teclas multimidia.
- `click_action`, `discover_executables` e `configure_autostart_app` nao sao suportados neste agente.

O objetivo desta versao e validar e operar o fluxo minimo: online/offline, abrir URL, capturar tela, tocar/parar por tecla de midia e desligamento.

## Pre-requisitos

- Windows 7 SP1.
- PowerShell 3 ou superior. Recomendado: Windows Management Framework 5.1.
- .NET Framework atualizado com TLS 1.2.
- Chrome instalado. Se possivel, informe o caminho do `chrome.exe` no instalador.
- Computador cadastrado no painel, com `DEVICE_ID` e `DEVICE_TOKEN`.
- API publicada em HTTP/HTTPS acessivel pela maquina.

Se usar HTTPS em Windows 7, confirme que TLS 1.2 esta habilitado no sistema. Caso contrario, use HTTP apenas em uma rede privada/VPN de teste.

## Instalacao

Copie para o Windows 7 a pasta:

```text
scripts\windows7\
```

Uma estrutura simples para pendrive ou copia local:

```text
C:\RadioBOTInstaller\scripts\windows7\
```

Abra o PowerShell:

```powershell
cd C:\RadioBOTInstaller
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\install-agent.ps1
```

O instalador pergunta:

- URL da API, por exemplo `https://api.seu-dominio.com`.
- `DEVICE_ID`.
- `DEVICE_TOKEN`.
- Caminho do Chrome, opcional se o instalador detectar automaticamente.
- Nome da tarefa agendada.
- Se o desligamento deve ser simulado.
- Porta local do Chrome DevTools. Default: `9222`.
- Intervalo de polling.

Tambem e aceito colar a URL do agente moderno, como `wss://api.seu-dominio.com/agent`; o runner converte para `https://api.seu-dominio.com`.

Por padrao:

- Pasta: `C:\RadioBOTLegacy`
- Tarefa Agendada: `RadioBOTLegacyAgent`
- Log: `C:\RadioBOTLegacy\agent.log`
- Perfil Chrome: `C:\RadioBOTLegacy\chrome-profile`
- Porta DevTools: `9222`
- `SHUTDOWN_DRY_RUN=true`
- Polling: 5 segundos

Quando o Chrome esta configurado, o agente abre o navegador com `--remote-debugging-port` e tenta executar o play/stop por Chrome DevTools antes de usar o fallback de teclas multimidia.

O agente trabalha em modo exclusivo: antes de abrir uma nova radio, ele fecha as abas antigas do Chrome controlado pela porta DevTools. A operacao esperada e sempre uma radio por computador.

As regras atuais cobrem, entre outros casos:

- Modal com texto `Clique no botao abaixo para iniciar o player` e botao `Ok`.
- Player com botao `#ap-toggle`.
- Player com classe `.play-btn`.
- Botoes com texto ou atributos contendo `Play`, `Ouvir`, `Ao vivo`, `Iniciar` ou `Tocar`.

## Respostas Recomendadas

```text
Pasta de instalacao: C:\RadioBOTLegacy
URL da API: https://api.seu-dominio.com
Device ID do computador: cole o DEVICE_ID
Device token: cole o DEVICE_TOKEN
Caminho do Chrome: deixe vazio para detectar automaticamente ou informe o chrome.exe
Nome da tarefa agendada: RadioBOTLegacyAgent
Simular desligamento: sim
Porta local do Chrome DevTools: 9222
Intervalo de polling: 5
```

Exemplos de caminho do Chrome:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
```

Use a URL da API, nao a URL do painel, e nao precisa colocar `/agent`.

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

Para conferir se o play usou Chrome DevTools, veja o historico do comando no painel. O resultado deve incluir dados em `output.chrome`. Se aparecer `fallback=true`, o agente nao conseguiu controlar o Chrome pela porta local e usou teclas multimidia.

## Atualizacao

Se voce ja instalou uma versao anterior:

1. Copie novamente a pasta `scripts\windows7\` atualizada para `C:\RadioBOTInstaller\scripts\windows7\`.
2. Rode o instalador de novo:

```powershell
cd C:\RadioBOTInstaller
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\install-agent.ps1
```

O instalador para a tarefa antiga, copia o novo `run-agent.ps1`, recria `agent.config.ps1` e inicia a tarefa novamente.

## Troubleshooting

Se o computador fica offline:

```powershell
Get-Content C:\RadioBOTLegacy\agent.log -Tail 80 -Wait
```

Confira `DEVICE_ID`, `DEVICE_TOKEN` e URL da API.

Se abre a radio, mas nao toca:

1. Confirme que o caminho informado e o `chrome.exe`.
2. Mantenha a porta `9222`.
3. Feche janelas antigas do Chrome abertas manualmente, ou reinicie a tarefa.
4. Teste `Abrir e tocar` antes de testar somente `Play`.

Para reiniciar:

```powershell
schtasks.exe /End /TN RadioBOTLegacyAgent
schtasks.exe /Run /TN RadioBOTLegacyAgent
```

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
