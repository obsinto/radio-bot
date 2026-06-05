# Handoff: Autoplay no Agente Windows 7

## Contexto

O agente normal usa Playwright e funciona em Windows 10/11/Linux. A maquina alvo precisa continuar em Windows 7 porque o Wake-on-LAN so funciona corretamente nela.

Como Playwright/Node moderno nao suportam Windows 7, foi criado um agente legado em PowerShell:

```text
scripts\windows7\install-agent.ps1
scripts\windows7\run-agent.ps1
scripts\windows7\uninstall-agent.ps1
```

Esse agente faz polling HTTP na API e controla o Chrome por Chrome DevTools local (`127.0.0.1:9222`) quando possivel.

## Problema

O `play_radio` precisa se comportar como o agente Playwright:

- abrir a radio;
- fechar qualquer aba/radio anterior;
- clicar no prompt inicial quando existir;
- clicar no botao de play correto;
- tentar `audio.play()` / `video.play()`;
- nunca deixar duas radios tocando em abas diferentes.

## Radios Que Motivaram o Ajuste

### RadioSrv / Palmeirinha

URL observada:

```text
https://app.radios.srv.br/player
```

Padrao da pagina:

```text
Clique no botao abaixo para iniciar o player!
Botao: Ok
```

O agente precisa clicar no `Ok` antes de tentar play.

### Oliveira FM

URL observada:

```text
https://www.oliveirafm.com.br/
```

Padrao da pagina:

```html
<audio id="ap-audio">
<button class="play-btn" id="ap-toggle" aria-label="Play / Pause">
```

O agente precisa clicar em `#ap-toggle` ou `.play-btn`, ou chamar `audio.play()` em `#ap-audio`.

## Implementado Ate Agora

### Agente Padrao Playwright

Arquivo:

```text
apps/agent/src/browser-controller.ts
```

Mudancas:

- `play_radio` agora tenta clicar em prompt de inicio com texto parecido com:

```text
Clique no botao abaixo para iniciar o player
```

- Regras de play incluem:

```text
#ap-toggle
.play-btn
button[aria-label*="play" i]
[role="button"][aria-label*="play" i]
button[aria-label*="iniciar" i]
[title*="iniciar" i]
button:has-text("Play")
button:has-text("Ouvir")
button:has-text("Ao vivo")
button:has-text("Iniciar")
button:has-text("Tocar")
.btn-play
.play
```

- Regras de stop incluem:

```text
#ap-toggle
.play-btn
pause/stop selectors
.btn-pause
.pause
.btn-stop
.stop
```

- Antes/depois de abrir uma radio, fecha paginas extras no contexto Playwright para evitar duas abas.

### Agente Legado Windows 7

Arquivo:

```text
scripts\windows7\run-agent.ps1
```

Mudancas:

- Abre Chrome com:

```text
--remote-debugging-port=9222
--user-data-dir=C:\RadioBOTLegacy\chrome-profile
```

- Implementa cliente WebSocket minimo para Chrome DevTools Protocol.
- Executa JavaScript na pagina via `Runtime.evaluate`.
- Tenta clicar no prompt `Clique no botao abaixo para iniciar o player` e botao `Ok`.
- Tenta clicar em `#ap-toggle`, `.play-btn` e seletores genericos.
- Tenta `audio.play()` / `video.play()`.
- Antes de abrir uma nova radio, fecha abas antigas do Chrome controlado via:

```text
http://127.0.0.1:9222/json/close/<targetId>
```

- Se Chrome DevTools falhar, cai no fallback de tecla multimidia.

## Resolucao do Autoplay (2026-06-01)

A causa raiz do autoplay falhar no agente legado: o agente Playwright funciona porque os cliques do Playwright sao eventos confiaveis (trusted user gesture), o que libera `audio.play()`. O agente Windows 7 clica via JavaScript (`element.click()` dentro de `Runtime.evaluate`), que **nao** e um gesto de usuario confiavel. Por isso o Chrome bloqueava `audio.play()` / `video.play()` com `NotAllowedError`, e o agente caia no fallback de teclas multimidia.

Como o proprio agente abre o Chrome, a correcao definitiva e iniciar o Chrome com a politica de autoplay desabilitada:

```text
--autoplay-policy=no-user-gesture-required
```

Mudancas aplicadas em `scripts\windows7\run-agent.ps1`:

- `Open-ChromeBrowser` agora abre o Chrome com `--autoplay-policy=no-user-gesture-required` (e `--no-default-browser-check`). Com isso `audio.play()` nunca e bloqueado, mesmo sem clique confiavel.
- `Stop-StaleChrome` roda uma vez na inicializacao do agente e encerra qualquer Chrome ainda preso ao perfil `chrome-profile`. Sem isso, um Chrome antigo (de uma versao do agente sem a flag) sobreviveria a uma atualizacao e continuaria bloqueando o autoplay, porque a flag so vale para uma instancia NOVA do Chrome.
- `Wait-ChromeTab` agora casa a aba por host + caminho normalizado (`Test-UrlMatch`), tolerando redirects, barra final e fragmentos (`#`). Antes a comparacao exata falhava apos redirect e o agente podia controlar a aba errada.

Importante: a flag de autoplay so e aplicada quando o Chrome e iniciado pelo agente. Se houver um Chrome aberto manualmente nesse mesmo perfil, feche-o antes (a reinstalacao + `Stop-StaleChrome` ja cuidam do Chrome iniciado pelo agente).

### Causa raiz adicional: `open_site` nao tocava

Diagnostico no Windows 7 mostrou que o painel, no botao "Abrir e tocar", envia o comando `open_site` (e nao `play_radio`). No agente Playwright, `open_site` abre **e** toca (`playCurrentPage`). No agente legado, `open_site` apenas abria a URL e nunca tentava play — por isso a radio abria mas ficava muda, e o log so mostrava `open_site`, nunca uma tentativa de playback.

Correcao: os comandos que abrem pagina agora tambem tocam, espelhando o agente Playwright. Foi criado o helper `Invoke-PlaybackWithFallback` (CDP com fallback de tecla multimidia) e aplicado em:

```text
open_site        -> abre e toca
login            -> abre e toca
play_radio       -> toca (reaproveita o helper)
stop_playback    -> pausa (reaproveita o helper)
confirm_open_here-> toca
```

O resultado do play vai dentro de `output.play` (para `open_site`/`login`) ou direto em `output` (para `play_radio`), sempre com `chrome`, `chromeError` e `fallback`.

### Causa raiz adicional: WebSocket truncava respostas grandes do CDP

A radio do "Ok" passou a tocar, mas a do botao Play (Oliveira FM) falhava com:

```text
chromeError=Cadeia de caracteres nao finalizada transmitida ... {"id":...,"result":{"result":{"type":"object","va
```

Isso e JSON truncado. O Chrome DevTools fragmenta respostas grandes em varios frames WebSocket (primeiro com FIN=0, continuacoes com opcode 0x0), e `Read-WebSocketTextFrame` retornava no primeiro frame de texto, devolvendo JSON cortado -> `ConvertFrom-Json` falhava -> fallback. A resposta do "Ok" e pequena (um frame so), por isso funcionava.

Correcao em `Read-WebSocketTextFrame`: agora acumula os fragmentos ate o frame com FIN=1 e trata frames de controle (ping/pong ignorados, close encerra). Tambem:

- `Clean-ErrorText` remove caracteres de controle / `U+FFFD` do `chromeError` e limita o tamanho. O texto truncado anterior continha bytes invalidos que provavelmente causavam o `HTTP 400` no POST de resultado.
- O envio do resultado virou um `try` separado do polling; em caso de erro, o log mostra o corpo da resposta (`Falha ao enviar resultado ... | corpo=...`) em vez de "Erro de polling".
- O log de cada comando agora e `Comando processado: ... output={...}`, gravado ANTES do envio, para vermos o resultado mesmo se o POST falhar.

## Retomar a Radio ao Ligar o Computador

Antes: ao ligar o PC, o agente legado apenas fazia polling e esperava comandos. Nenhuma radio iniciava sozinha (so via clique no painel ou rotina agendada "ligar e iniciar").

Agora o backend (`apps/api/src/server.ts`, funcao `resumeRadioOnReconnect`) reabre a radio automaticamente quando o computador volta a aparecer online:

- No `/agent-legacy/poll`, detectamos a reconexao comparando com `isLegacyAgentFresh` ANTES de atualizar o timestamp (se o agente nao estava "fresco", o PC acabou de ligar / o agente reiniciou).
- A radio escolhida segue esta ordem:
  1. o `profileId` do ultimo comando `power_on` (a radio que voce seleciona na tela "ligar o PC" por Wake on LAN), se criado nos ultimos 15 minutos;
  2. senao, `device.currentProfileId` (a ultima radio registrada pelo backend antes do agente voltar online).
- O comando enfileirado e `login` (se o perfil tem usuario/senha) ou `open_site`, entregue ja no mesmo poll.

Protecoes:

- So reabre se o agente reporta que NAO tem radio ativa (`state.currentProfileId` vazio). Se o agente reiniciou mas o Chrome continua tocando, ou foi so uma reconexao de rede, nada e reaberto.
- Nao duplica se ja existe um comando de agente enfileirado/enviado para o dispositivo (o `power_on`, que vai para o gateway ESP32, nao conta).

Isso vale para o agente legado Windows 7 e para o agente moderno (WebSocket). No agente moderno, a retomada acontece no primeiro `heartbeat` de uma conexao nova: se o navegador ainda reporta uma radio ativa, nada e reaberto; se o processo reiniciou e reporta estado vazio, o backend envia `login` ou `open_site`.

A ordem do `/agent-legacy/poll` tambem precisa chamar `resumeRadioOnReconnect` antes de persistir o estado reportado no boot. Isso preserva a ultima radio salva no banco PostgreSQL tempo suficiente para criar o comando de retomada, mesmo quando o processo recem-iniciado envia `currentProfileId = null`.

## Como Atualizar a Maquina Windows 7

Copiar a pasta atualizada:

```text
scripts\windows7\
```

Para:

```text
C:\RadioBOTInstaller\scripts\windows7\
```

Rerodar:

```powershell
cd C:\RadioBOTInstaller
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\install-agent.ps1
```

Respostas importantes:

```text
Caminho do Chrome: C:\Program Files\Google\Chrome\Application\chrome.exe
ou: C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
Porta local do Chrome DevTools: 9222
```

O instalador para a tarefa antiga, copia o novo runner e inicia a tarefa novamente.

## Como Validar

No Windows 7:

```powershell
Get-Content C:\RadioBOTLegacy\agent.log -Tail 80 -Wait
```

No painel:

1. Selecione a radio Palmeirinha / RadioSrv.
2. Clique em `Abrir e tocar`.
3. Confirme que o prompt `Ok` foi clicado e a radio tocou.
4. Troque para Oliveira FM.
5. Clique em `Abrir e tocar`.
6. Confirme que a aba anterior foi fechada e so ficou a Oliveira FM.
7. Clique em `Stop`.
8. Confirme que parou.

No historico do comando, observar:

```text
output.chrome
output.fallback
```

Se `fallback=false`, o Chrome DevTools funcionou.

Se `fallback=true`, o agente nao conseguiu controlar o Chrome e usou teclas multimidia.

## Pontos De Atencao

- O Chrome deve ser aberto pelo agente, nao manualmente, para usar o perfil `C:\RadioBOTLegacy\chrome-profile`.
- A porta `9222` deve estar livre.
- Se houver Chrome antigo aberto manualmente, fechar antes do teste.
- Windows 7 pode ter problemas com TLS 1.2 se a API estiver em HTTPS; isso afeta polling, nao o play.
- O script PowerShell nao foi executado localmente neste ambiente, porque aqui nao ha PowerShell instalado. A validacao real precisa ser no Windows 7.

## Proximos Passos Se Ainda Falhar

1. Verificar se `http://127.0.0.1:9222/json/list` abre no proprio Windows 7 enquanto o agente esta rodando.
2. Se nao abrir, o Chrome nao subiu com DevTools; revisar caminho do `chrome.exe`, porta e tarefa agendada.
3. Se abrir, copiar o JSON de `/json/list` e o resultado do comando no painel.
4. Adicionar seletor especifico por radio, se necessario:

```text
palmeirinha.play
oliveira.play
```

5. Se autoplay continuar bloqueado, manter o clique real no botao como caminho principal, porque navegadores bloqueiam `audio.play()` sem gesto de usuario em alguns cenarios.
