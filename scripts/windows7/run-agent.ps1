[CmdletBinding()]
param(
  [string]$ConfigFile = "",
  [string]$ApiUrl = "",
  [string]$DeviceId = "",
  [string]$DeviceToken = "",
  [string]$BrowserPath = "",
  [int]$ChromeDebugPort = 9222,
  [string]$ChromeUserDataDir = "",
  [int]$PollSeconds = 5,
  [string]$ShutdownDryRun = "true",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($ConfigFile)) {
  if (-not (Test-Path -LiteralPath $ConfigFile)) {
    throw "Arquivo de configuracao nao encontrado: $ConfigFile"
  }
  . $ConfigFile
}

if ($PSVersionTable.PSVersion.Major -lt 3) {
  throw "Este agente legado exige PowerShell 3 ou superior. No Windows 7, instale Windows Management Framework 5.1."
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
  # Windows 7 sem .NET atualizado pode nao expor TLS 1.2. O erro de conexao deixara isso claro no log.
}

function Require-Value {
  param(
    [string]$Name,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name obrigatorio."
  }
}

function Normalize-ApiUrl {
  param([string]$Value)

  $url = $Value.Trim().TrimEnd("/")
  if ($url.StartsWith("wss://", [StringComparison]::OrdinalIgnoreCase)) {
    $url = "https://$($url.Substring("wss://".Length))"
  } elseif ($url.StartsWith("ws://", [StringComparison]::OrdinalIgnoreCase)) {
    $url = "http://$($url.Substring("ws://".Length))"
  }

  if ($url.EndsWith("/agent", [StringComparison]::OrdinalIgnoreCase)) {
    $url = $url.Substring(0, $url.Length - "/agent".Length)
  }

  return $url.TrimEnd("/")
}

Require-Value -Name "ApiUrl" -Value $ApiUrl
Require-Value -Name "DeviceId" -Value $DeviceId
Require-Value -Name "DeviceToken" -Value $DeviceToken

$ApiUrl = Normalize-ApiUrl -Value $ApiUrl
if ($PollSeconds -lt 2) {
  $PollSeconds = 2
}
if ($ShutdownDryRun -ne "true" -and $ShutdownDryRun -ne "false") {
  $ShutdownDryRun = "true"
}

if ([string]::IsNullOrWhiteSpace($LogFile)) {
  $LogFile = Join-Path $PSScriptRoot "agent.log"
}
$LogDir = Split-Path -Parent $LogFile
if (-not [string]::IsNullOrWhiteSpace($LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}
if ([string]::IsNullOrWhiteSpace($ChromeUserDataDir)) {
  $ChromeUserDataDir = Join-Path $LogDir "chrome-profile"
}
if (-not [string]::IsNullOrWhiteSpace($ChromeUserDataDir)) {
  New-Item -ItemType Directory -Force -Path $ChromeUserDataDir | Out-Null
}

function Write-Log {
  param([string]$Message)
  "[$(Get-Date -Format o)] $Message" | Out-File -FilePath $LogFile -Append -Encoding utf8
}

$script:CurrentProfileId = $null
$script:ActiveUrl = $null
$script:Title = "Radio BOT Legacy Agent"
$script:MediaKeysLoaded = $false
# Diagnostico opcional: loga cada frame WebSocket do CDP (header/fin/opcode/len)
# e o texto cru quando o JSON falha. Ligue (= $true) so para investigar.
$script:CdpDebug = $false

function Get-AgentState {
  return @{
    currentProfileId = $script:CurrentProfileId
    activeUrl = $script:ActiveUrl
    title = $script:Title
  }
}

function Resolve-ChromePath {
  $roots = @(
    $env:ProgramFiles,
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    $env:LocalAppData
  )

  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root)) {
      continue
    }
    $candidate = Join-Path $root "Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  return ""
}

if ([string]::IsNullOrWhiteSpace($BrowserPath)) {
  $BrowserPath = Resolve-ChromePath
}

function Test-IsChromePath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }
  return ([IO.Path]::GetFileName($Path) -ieq "chrome.exe")
}

function Quote-Argument {
  param([string]$Value)

  if ($Value -match '\s|"' ) {
    return '"' + $Value.Replace('"', '\"') + '"'
  }
  return $Value
}

function Build-AgentUri {
  param([string]$Path)
  $encodedDeviceId = [Uri]::EscapeDataString($DeviceId)
  return "$ApiUrl$Path`?deviceId=$encodedDeviceId"
}

function Invoke-AgentApi {
  param(
    [string]$Path,
    [hashtable]$Body
  )

  $uri = Build-AgentUri -Path $Path
  $json = $Body | ConvertTo-Json -Depth 12 -Compress
  return Invoke-RestMethod `
    -Method Post `
    -Uri $uri `
    -Headers @{ Authorization = "Bearer $DeviceToken" } `
    -ContentType "application/json" `
    -Body $json `
    -TimeoutSec 30
}

function Get-HttpErrorBody {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)

  try {
    $response = $ErrorRecord.Exception.Response
    if ($null -eq $response) {
      return ""
    }
    $stream = $response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  } catch {
    return ""
  }
}

function Read-ExactBytes {
  param(
    [System.IO.Stream]$Stream,
    [int]$Count
  )

  $buffer = New-Object byte[] $Count
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -le 0) {
      throw "Conexao WebSocket encerrada antes da resposta."
    }
    $offset += $read
  }
  # `,` evita que o PowerShell desempacote o array no pipeline e o recolha como
  # Object[]. Sem isso, o byte[] vira Object[] e o AddRange (List[byte]) falha.
  return ,$buffer
}

function New-RandomBytes {
  param([int]$Count)

  $bytes = New-Object byte[] $Count
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return $bytes
}

function Read-WebSocketHandshake {
  param([System.IO.Stream]$Stream)

  $bytes = New-Object 'System.Collections.Generic.List[byte]'
  $one = New-Object byte[] 1
  while ($true) {
    $read = $Stream.Read($one, 0, 1)
    if ($read -le 0) {
      throw "Chrome fechou a conexao durante o handshake WebSocket."
    }
    $bytes.Add($one[0])
    $count = $bytes.Count
    if (
      $count -ge 4 -and
      $bytes[$count - 4] -eq 13 -and
      $bytes[$count - 3] -eq 10 -and
      $bytes[$count - 2] -eq 13 -and
      $bytes[$count - 1] -eq 10
    ) {
      break
    }
  }

  return [Text.Encoding]::ASCII.GetString($bytes.ToArray())
}

function Send-WebSocketTextFrame {
  param(
    [System.IO.Stream]$Stream,
    [string]$Text
  )

  $payload = [Text.Encoding]::UTF8.GetBytes($Text)
  if ($payload.Length -gt 65535) {
    throw "Mensagem WebSocket grande demais para o cliente legado."
  }

  $mask = New-RandomBytes -Count 4
  $frame = New-Object 'System.Collections.Generic.List[byte]'
  $frame.Add([byte]0x81)

  if ($payload.Length -lt 126) {
    $frame.Add([byte](0x80 -bor $payload.Length))
  } else {
    $frame.Add([byte]0xFE)
    $frame.Add([byte](($payload.Length -shr 8) -band 0xFF))
    $frame.Add([byte]($payload.Length -band 0xFF))
  }

  foreach ($byte in $mask) {
    $frame.Add([byte]$byte)
  }

  for ($i = 0; $i -lt $payload.Length; $i++) {
    $frame.Add([byte]($payload[$i] -bxor $mask[$i % 4]))
  }

  $bytes = $frame.ToArray()
  $Stream.Write($bytes, 0, $bytes.Length)
}

function Read-WebSocketTextFrame {
  param([System.IO.Stream]$Stream)

  # O Chrome DevTools fragmenta respostas grandes em varios frames WebSocket
  # (primeiro frame com FIN=0, continuacoes com opcode 0). Precisamos juntar
  # todos os fragmentos ate o frame com FIN=1, senao o JSON volta truncado.
  $message = New-Object 'System.Collections.Generic.List[byte]'

  while ($true) {
    $header = Read-ExactBytes -Stream $Stream -Count 2
    $fin = ($header[0] -band 0x80) -ne 0
    $opcode = $header[0] -band 0x0F
    $masked = ($header[1] -band 0x80) -ne 0
    [UInt64]$length = $header[1] -band 0x7F

    if ($length -eq 126) {
      $extra = Read-ExactBytes -Stream $Stream -Count 2
      $length = ($extra[0] -shl 8) -bor $extra[1]
    } elseif ($length -eq 127) {
      $extra = Read-ExactBytes -Stream $Stream -Count 8
      $length = 0
      foreach ($byte in $extra) {
        $length = ($length -shl 8) -bor $byte
      }
    }

    $mask = $null
    if ($masked) {
      $mask = Read-ExactBytes -Stream $Stream -Count 4
    }

    if ($length -gt 10485760) {
      throw "Frame WebSocket grande demais."
    }

    $payload = Read-ExactBytes -Stream $Stream -Count ([int]$length)
    if ($masked) {
      for ($i = 0; $i -lt $payload.Length; $i++) {
        $payload[$i] = [byte]($payload[$i] -bxor $mask[$i % 4])
      }
    }

    if ($script:CdpDebug) {
      $h0 = "{0:X2}" -f $header[0]
      $h1 = "{0:X2}" -f $header[1]
      Write-Log "CDP frame: header=$h0 $h1 fin=$fin opcode=$opcode masked=$masked len=$length acumulado=$($message.Count + [int]$length)"
    }

    # Frames de controle: 0x8 close, 0x9 ping, 0xA pong.
    if ($opcode -eq 8) {
      throw "Chrome fechou o WebSocket DevTools."
    }
    if ($opcode -eq 9 -or $opcode -eq 10) {
      # Ping/pong nao fazem parte da mensagem de dados; ignora e continua.
      continue
    }

    # Frames de dados: 0x1 texto, 0x2 binario, 0x0 continuacao.
    # Cast explicito para byte[]: blindagem caso $payload chegue como Object[].
    if ($payload.Length -gt 0) {
      $message.AddRange([byte[]]$payload)
    }

    if ($fin) {
      return [Text.Encoding]::UTF8.GetString($message.ToArray())
    }
  }
}

function Invoke-CdpWebSocket {
  param(
    [string]$WebSocketUrl,
    [hashtable]$Message
  )

  $uri = [Uri]$WebSocketUrl
  $client = New-Object Net.Sockets.TcpClient
  $stream = $null

  try {
    $client.Connect($uri.Host, $uri.Port)
    $stream = $client.GetStream()
    $key = [Convert]::ToBase64String((New-RandomBytes -Count 16))
    $path = $uri.PathAndQuery
    $hostHeader = "$($uri.Host):$($uri.Port)"
    $handshake = "GET $path HTTP/1.1`r`nHost: $hostHeader`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $key`r`nSec-WebSocket-Version: 13`r`n`r`n"
    $handshakeBytes = [Text.Encoding]::ASCII.GetBytes($handshake)
    $stream.Write($handshakeBytes, 0, $handshakeBytes.Length)

    $responseHeaders = Read-WebSocketHandshake -Stream $stream
    if ($responseHeaders -notmatch " 101 ") {
      throw "Handshake WebSocket recusado pelo Chrome: $($responseHeaders.Split("`r`n")[0])"
    }

    $json = $Message | ConvertTo-Json -Depth 30 -Compress
    Send-WebSocketTextFrame -Stream $stream -Text $json

    while ($true) {
      $text = Read-WebSocketTextFrame -Stream $stream
      try {
        $response = $text | ConvertFrom-Json
      } catch {
        if ($script:CdpDebug) {
          $len = if ($null -ne $text) { $text.Length } else { 0 }
          $head = if ($len -gt 0) { $text.Substring(0, [Math]::Min(120, $len)) } else { "" }
          Write-Log "CDP JSON falhou: textLen=$len head=$head"
        }
        throw
      }
      if ($response.id -eq $Message.id) {
        return $response
      }
    }
  } finally {
    if ($stream) {
      $stream.Dispose()
    }
    $client.Close()
  }
}

function Get-ChromeTabs {
  $uri = "http://127.0.0.1:$ChromeDebugPort/json/list"
  $tabs = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 3
  return @($tabs)
}

function Close-ChromeTabs {
  param([string]$KeepUrl = "")

  $closed = 0
  try {
    $tabs = Get-ChromeTabs
  } catch {
    return @{
      closed = 0
      error = $_.Exception.Message
    }
  }

  foreach ($tab in @($tabs | Where-Object { $_.type -eq "page" -and $_.id })) {
    if (-not [string]::IsNullOrWhiteSpace($KeepUrl) -and $tab.url -eq $KeepUrl) {
      continue
    }

    try {
      $targetId = [Uri]::EscapeDataString([string]$tab.id)
      Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$ChromeDebugPort/json/close/$targetId" -TimeoutSec 2 | Out-Null
      $closed += 1
    } catch {
      Write-Log "Falha ao fechar aba Chrome $($tab.id): $($_.Exception.Message)"
    }
  }

  return @{
    closed = $closed
    error = ""
  }
}

function Get-UrlMatchKey {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  try {
    $uri = [Uri]$Value
    $path = $uri.AbsolutePath.TrimEnd("/")
    return ("{0}{1}" -f $uri.Host, $path).ToLowerInvariant()
  } catch {
    return $Value.Trim().TrimEnd("/").ToLowerInvariant()
  }
}

function Test-UrlMatch {
  param(
    [string]$Candidate,
    [string]$Target
  )

  $candidateKey = Get-UrlMatchKey -Value $Candidate
  $targetKey = Get-UrlMatchKey -Value $Target
  if ([string]::IsNullOrWhiteSpace($candidateKey) -or [string]::IsNullOrWhiteSpace($targetKey)) {
    return $false
  }
  return ($candidateKey -eq $targetKey) -or
    $candidateKey.StartsWith($targetKey) -or
    $targetKey.StartsWith($candidateKey)
}

function Wait-ChromeTab {
  param([int]$TimeoutSeconds = 10)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $fallback = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $tabs = Get-ChromeTabs
      $pages = @($tabs | Where-Object { $_.type -eq "page" -and $_.webSocketDebuggerUrl })
      if ($pages.Count -gt 0) {
        if ($null -eq $fallback) {
          $fallback = $pages[0]
        }
        if ([string]::IsNullOrWhiteSpace($script:ActiveUrl)) {
          return $pages[0]
        }
        # Compara por host+caminho normalizado para tolerar redirects,
        # barra final e fragmentos (#) que a comparacao exata nao cobria.
        $matching = @($pages | Where-Object { Test-UrlMatch -Candidate $_.url -Target $script:ActiveUrl })
        if ($matching.Count -gt 0) {
          return $matching[0]
        }
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Milliseconds 500
  }

  if ($null -ne $fallback) {
    return $fallback
  }

  throw "Nao foi possivel acessar o Chrome DevTools em 127.0.0.1:$ChromeDebugPort."
}

function Invoke-ChromeCdp {
  param(
    [string]$Method,
    [hashtable]$Params
  )

  $tab = Wait-ChromeTab
  $message = @{
    id = (Get-Random -Minimum 1 -Maximum 2147483647)
    method = $Method
    params = $Params
  }
  $response = Invoke-CdpWebSocket -WebSocketUrl $tab.webSocketDebuggerUrl -Message $message
  if ($response.error) {
    throw "Chrome DevTools erro $($response.error.code): $($response.error.message)"
  }
  return $response
}

function Invoke-ChromeRuntime {
  param([string]$Expression)

  $response = Invoke-ChromeCdp -Method "Runtime.evaluate" -Params @{
    expression = $Expression
    awaitPromise = $true
    returnByValue = $true
    userGesture = $true
  }

  if ($response.result.exceptionDetails) {
    throw "Erro executando JavaScript no Chrome."
  }

  return $response.result.result.value
}

function Get-PropertyValue {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Default = $null
  )

  if ($null -eq $Object) {
    return $Default
  }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) {
      return $Object[$Name]
    }
    return $Default
  }
  if ($Object.PSObject.Properties.Name -contains $Name) {
    return $Object.$Name
  }
  return $Default
}

function Require-ProfileUrl {
  param([object]$Profile)

  $url = Get-PropertyValue -Object $Profile -Name "siteUrl" -Default ""
  if ([string]::IsNullOrWhiteSpace($url)) {
    throw "Perfil de radio obrigatorio para este comando."
  }
  return $url
}

function Stop-StaleChrome {
  # A flag --autoplay-policy so vale para uma instancia NOVA do Chrome. Se um
  # Chrome antigo (de uma versao anterior do agente, sem a flag) ainda estiver
  # rodando neste perfil quando o agente reinicia, o relancamento apenas
  # encaminha a URL para ele e a flag e ignorada. O perfil chrome-profile e
  # exclusivo do agente, entao podemos encerrar qualquer Chrome preso a ele.
  try {
    $needle = "--user-data-dir=$ChromeUserDataDir"
    Get-WmiObject Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |
      ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  } catch {
    Write-Log "Nao foi possivel encerrar Chrome antigo do perfil legado: $($_.Exception.Message)"
  }
}

function Open-ChromeBrowser {
  param([string]$Url)

  if (-not (Test-IsChromePath -Path $BrowserPath)) {
    return $false
  }

  Close-ChromeTabs | Out-Null

  $arguments = @(
    "--remote-debugging-port=$ChromeDebugPort",
    "--user-data-dir=$ChromeUserDataDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    # Libera o autoplay: o agente legado clica via JavaScript (Runtime.evaluate),
    # que nao gera um gesto de usuario confiavel, entao sem esta flag o Chrome
    # bloqueia audio.play()/video.play() com NotAllowedError e o play falha.
    "--autoplay-policy=no-user-gesture-required",
    $Url
  )
  $argumentString = ($arguments | ForEach-Object { Quote-Argument $_ }) -join " "
  Start-Process -FilePath $BrowserPath -ArgumentList $argumentString | Out-Null
  Wait-ChromeTab -TimeoutSeconds 15 | Out-Null
  return $true
}

function New-ChromePlaybackScript {
  param([string]$Mode)

  $words = "play|ouvir|ao vivo|iniciar|tocar"
  $classes = "play|btn-play|play-btn|ap-toggle"
  $mediaCommand = "play"
  if ($Mode -eq "stop") {
    $words = "pause|pausar|stop|parar"
    $classes = "pause|stop|btn-pause|btn-stop|play-btn|ap-toggle"
    $mediaCommand = "pause"
  }

  return @"
(async function () {
  const words = /$words/i;
  const classes = /$classes/i;
  const result = {
    action: "$Mode",
    promptClicked: { clicked: false, selector: null, frameUrl: null },
    clicked: { clicked: false, selector: null, frameUrl: null },
    media: { found: 0, playing: 0, paused: 0, attempted: 0, errors: 0 }
  };

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function textOf(element) {
    return [
      element.textContent || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("value") || "",
      element.className || "",
      element.id || ""
    ].join(" ");
  }

  function queryAll(documentRef, selector) {
    try {
      return Array.prototype.slice.call(documentRef.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function findButton(documentRef) {
    const selectors = "$Mode" === "play"
      ? [
          "#ap-toggle",
          ".play-btn",
          'button[aria-label*="play" i]',
          '[role="button"][aria-label*="play" i]',
          'button[aria-label*="iniciar" i]',
          '[role="button"][aria-label*="iniciar" i]',
          '[title*="play" i]',
          '[title*="iniciar" i]',
          ".btn-play",
          ".play"
        ]
      : [
          "#ap-toggle",
          ".play-btn",
          'button[aria-label*="pause" i]',
          '[role="button"][aria-label*="pause" i]',
          '[title*="pause" i]',
          'button[aria-label*="stop" i]',
          '[role="button"][aria-label*="stop" i]',
          '[title*="stop" i]',
          ".btn-pause",
          ".pause",
          ".btn-stop",
          ".stop"
        ];

    for (const selector of selectors) {
      const element = queryAll(documentRef, selector).find((item) => item && item.offsetParent !== null);
      if (element) {
        return { element, selector };
      }
    }

    const candidates = queryAll(
      documentRef,
      'button,a,[role="button"],input[type="button"],input[type="submit"],div,span'
    );
    for (const element of candidates) {
      const text = textOf(element);
      if (words.test(text) || classes.test(text)) {
        return { element, selector: "text-match" };
      }
    }

    return null;
  }

  function findPlayerStartPromptButton(documentRef) {
    if ("$Mode" !== "play") {
      return null;
    }

    const bodyText = (documentRef.body && documentRef.body.innerText) || "";
    if (!/clique no bot.o abaixo para iniciar o player/i.test(bodyText)) {
      return null;
    }

    const candidates = queryAll(
      documentRef,
      'button,a,[role="button"],input[type="button"],input[type="submit"]'
    );
    for (const element of candidates) {
      const text = textOf(element);
      if (/^\s*(ok|iniciar|tocar|play)\s*$/i.test(text) || /ok|iniciar|tocar|play/i.test(text)) {
        return { element, selector: "player-start-prompt" };
      }
    }

    return null;
  }

  function clickPlayerStartPrompt(documentRef, frameUrl) {
    if (result.promptClicked.clicked) {
      return false;
    }

    const match = findPlayerStartPromptButton(documentRef);
    if (!match) {
      return false;
    }

    try {
      match.element.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
    try {
      match.element.click();
      result.promptClicked = { clicked: true, selector: match.selector, frameUrl };
      return true;
    } catch (_) {
      return false;
    }
  }

  function clickFirst(documentRef, frameUrl) {
    if (result.clicked.clicked) {
      return;
    }
    const match = findButton(documentRef);
    if (!match) {
      return;
    }
    try {
      match.element.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
    try {
      match.element.click();
      result.clicked = { clicked: true, selector: match.selector, frameUrl };
    } catch (_) {}
  }

  async function controlMedia(documentRef) {
    const elements = queryAll(documentRef, "audio,video");
    result.media.found += elements.length;
    for (const element of elements) {
      try {
        if ("$mediaCommand" === "play") {
          result.media.attempted += 1;
          const promise = element.play();
          if (promise && promise.then) {
            await promise.catch(function () {
              result.media.errors += 1;
            });
          }
        } else {
          if (!element.paused) {
            result.media.attempted += 1;
            element.pause();
          }
        }
      } catch (_) {
        result.media.errors += 1;
      }
    }
    result.media.playing += elements.filter((element) => !element.paused && !element.ended).length;
    result.media.paused += elements.filter((element) => element.paused).length;
  }

  async function scanWindow(windowRef) {
    try {
      const promptClicked = clickPlayerStartPrompt(windowRef.document, windowRef.location.href);
      if (promptClicked) {
        await sleep(1000);
      }
      await controlMedia(windowRef.document);
      if ("$Mode" !== "play" || result.media.playing === 0) {
        clickFirst(windowRef.document, windowRef.location.href);
        if (result.clicked.clicked) {
          await sleep(1000);
          await controlMedia(windowRef.document);
        }
      }
      for (let index = 0; index < windowRef.frames.length; index += 1) {
        try {
          await scanWindow(windowRef.frames[index]);
        } catch (_) {}
      }
    } catch (_) {}
  }

  await scanWindow(window);
  return result;
})()
"@
}

function Invoke-ChromePlayback {
  param([string]$Mode)

  if (-not (Test-IsChromePath -Path $BrowserPath)) {
    throw "Chrome nao configurado."
  }

  $script = New-ChromePlaybackScript -Mode $Mode
  return Invoke-ChromeRuntime -Expression $script
}

function Clean-ErrorText {
  param([string]$Value)

  if ([string]::IsNullOrEmpty($Value)) {
    return ""
  }
  # Remove caracteres de controle e o caractere de substituicao (U+FFFD) que
  # aparecem quando uma resposta CDP truncada e decodificada. Eles podem fazer
  # a API rejeitar o corpo do resultado (HTTP 400). Limita o tamanho tambem.
  $clean = ($Value -replace '[\x00-\x1F\x7F\uFFFD]', ' ').Trim()
  if ($clean.Length -gt 500) {
    $clean = $clean.Substring(0, 500)
  }
  return $clean
}

function Invoke-PlaybackWithFallback {
  param(
    [string]$Action,
    [string]$Mode
  )

  $chromeResult = $null
  $chromeError = ""
  try {
    $chromeResult = Invoke-ChromePlayback -Mode $Mode
  } catch {
    $chromeError = Clean-ErrorText -Value $_.Exception.Message
  }

  if ($chromeResult) {
    return @{
      action = $Action
      chrome = $chromeResult
      chromeError = $chromeError
      fallback = $false
      legacyMode = $true
    }
  }

  if ($Mode -eq "stop") {
    Write-Log "$Action sem CDP (chromeError=$chromeError). Fallback: tecla stop/pause."
    Send-MediaKey -Key 178
    Start-Sleep -Milliseconds 250
    Send-MediaKey -Key 179
    return @{
      action = $Action
      mediaKeys = @("stop", "play_pause")
      chromeError = $chromeError
      fallback = $true
      legacyMode = $true
    }
  }

  # Play sem CDP: NAO enviamos a tecla play/pause (VK179). Com a flag
  # --autoplay-policy a pagina costuma iniciar sozinha, e a tecla play/pause e
  # um toggle que PAUSARIA o audio que ja esta tocando. Sem CDP nao temos como
  # saber o estado, entao deixamos o autoplay agir e apenas reportamos fallback.
  Write-Log "$Action sem CDP (chromeError=$chromeError). Fallback: confiando no autoplay (sem tecla play/pause)."
  return @{
    action = $Action
    mediaKey = "none"
    chromeError = $chromeError
    fallback = $true
    legacyMode = $true
  }
}

function Open-LegacyBrowser {
  param(
    [string]$Url,
    [string]$ProfileId,
    [string]$Title
  )

  $script:CurrentProfileId = $ProfileId
  $script:ActiveUrl = $Url
  $script:Title = $Title

  $openedWithChromeDebug = $false
  if (Test-IsChromePath -Path $BrowserPath) {
    try {
      $openedWithChromeDebug = Open-ChromeBrowser -Url $Url
    } catch {
      Write-Log "Falha ao abrir Chrome com DevTools: $($_.Exception.Message). Abrindo sem automacao."
      Start-Process -FilePath $BrowserPath -ArgumentList $Url | Out-Null
    }
  } elseif (-not [string]::IsNullOrWhiteSpace($BrowserPath) -and (Test-Path -LiteralPath $BrowserPath)) {
    Start-Process -FilePath $BrowserPath -ArgumentList $Url | Out-Null
  } else {
    Start-Process $Url | Out-Null
  }

  return @{
    opened = $true
    url = $Url
    browserPath = $BrowserPath
    chromeDebug = $openedWithChromeDebug
    chromeDebugPort = $ChromeDebugPort
    legacyMode = $true
  }
}

function Capture-DesktopScreenshot {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object System.IO.MemoryStream

  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $base64 = [Convert]::ToBase64String($stream.ToArray())
    return "data:image/jpeg;base64,$base64"
  } finally {
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Ensure-MediaKeys {
  if ($script:MediaKeysLoaded) {
    return
  }

  Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class RadioBotMediaKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, UIntPtr dwExtraInfo);

  public static void Press(byte key) {
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 2, UIntPtr.Zero);
  }
}
"@
  $script:MediaKeysLoaded = $true
}

function Send-MediaKey {
  param([byte]$Key)
  Ensure-MediaKeys
  [RadioBotMediaKeys]::Press($Key)
}

function Invoke-Shutdown {
  param([object]$Payload)

  $delay = [int](Get-PropertyValue -Object $Payload -Name "delaySeconds" -Default 60)
  if ($delay -lt 0) {
    $delay = 0
  }
  $force = [bool](Get-PropertyValue -Object $Payload -Name "force" -Default $true)
  $args = @("/s", "/t", "$delay")
  if ($force) {
    $args += "/f"
  }

  if ($ShutdownDryRun -eq "true") {
    return @{
      action = "shutdown"
      dryRun = $true
      command = "shutdown.exe"
      args = $args
      effectiveDelaySeconds = $delay
    }
  }

  Start-Process -FilePath "shutdown.exe" -ArgumentList $args -WindowStyle Hidden | Out-Null
  return @{
    action = "shutdown"
    dryRun = $false
    command = "shutdown.exe"
    args = $args
    effectiveDelaySeconds = $delay
  }
}

function ConvertTo-XmlText {
  param([string]$Value)
  if ($null -eq $Value) {
    return ""
  }
  return $Value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;")
}

function Resolve-CandidatePath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }
  $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
  if ([string]::IsNullOrWhiteSpace($expanded)) {
    return $null
  }
  try {
    return (Resolve-Path -LiteralPath $expanded -ErrorAction Stop).Path
  } catch {
    return $expanded
  }
}

function Get-CandidateId {
  param([string]$Key)

  $sha1 = [Security.Cryptography.SHA1]::Create()
  try {
    $bytes = $sha1.ComputeHash([Text.Encoding]::UTF8.GetBytes($Key))
  } finally {
    $sha1.Dispose()
  }
  $hex = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  return $hex.Substring(0, 12)
}

function Get-IconExecutablePath {
  param([string]$Icon)

  if ([string]::IsNullOrWhiteSpace($Icon)) {
    return $null
  }
  $value = $Icon.Trim()
  if ($value -match '^"([^"]+)"') {
    $value = $Matches[1]
  } else {
    $value = ($value -split ",")[0].Trim().Trim('"')
  }
  $value = [Environment]::ExpandEnvironmentVariables($value)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }
  if (-not $value.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $value
}

function Add-ExecutableCandidate {
  param(
    [System.Collections.Generic.List[object]]$Items,
    [hashtable]$Seen,
    [string]$Needle,
    [int]$Limit,
    [string]$Name,
    [string]$Path,
    [string]$WorkingDir,
    [string]$Source,
    [string]$Publisher,
    [string]$Version
  )

  if ($Items.Count -ge ($Limit * 2)) {
    return
  }

  $resolved = Resolve-CandidatePath -Path $Path
  if ([string]::IsNullOrWhiteSpace($resolved)) {
    return
  }
  if (-not $resolved.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
    return
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    return
  }

  $key = $resolved.ToLowerInvariant()
  if ($Seen.ContainsKey($key)) {
    return
  }

  $displayName = if (-not [string]::IsNullOrWhiteSpace($Name)) {
    $Name.Trim()
  } else {
    [IO.Path]::GetFileNameWithoutExtension($resolved)
  }

  if (-not [string]::IsNullOrWhiteSpace($Needle)) {
    $match = $false
    foreach ($value in @($displayName, $resolved, $Publisher)) {
      if (-not [string]::IsNullOrWhiteSpace($value) -and $value.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $match = $true
        break
      }
    }
    if (-not $match) {
      return
    }
  }

  $resolvedWorkingDir = Resolve-CandidatePath -Path $WorkingDir
  if ([string]::IsNullOrWhiteSpace($resolvedWorkingDir) -or -not (Test-Path -LiteralPath $resolvedWorkingDir -PathType Container)) {
    $resolvedWorkingDir = [IO.Path]::GetDirectoryName($resolved)
  }

  $Seen[$key] = $true
  $Items.Add([pscustomobject]@{
    id = Get-CandidateId -Key $key
    name = $displayName
    path = $resolved
    workingDir = $resolvedWorkingDir
    source = $Source
    publisher = $(if ([string]::IsNullOrWhiteSpace($Publisher)) { $null } else { $Publisher.Trim() })
    version = $(if ([string]::IsNullOrWhiteSpace($Version)) { $null } else { $Version.Trim() })
  }) | Out-Null
}

function Search-CommonExecutablePath {
  param(
    [System.Collections.Generic.List[object]]$Items,
    [hashtable]$Seen,
    [string]$Needle,
    [int]$Limit,
    [string]$Root,
    [int]$Depth
  )

  if ($Items.Count -ge $Limit) {
    return
  }
  if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
    return
  }

  Get-ChildItem -LiteralPath $Root -Filter "*.exe" -File -ErrorAction SilentlyContinue | ForEach-Object {
    Add-ExecutableCandidate -Items $Items -Seen $Seen -Needle $Needle -Limit $Limit -Name ([IO.Path]::GetFileNameWithoutExtension($_.Name)) -Path $_.FullName -WorkingDir $_.DirectoryName -Source "common_path" -Publisher $null -Version $null
  }

  if ($Depth -le 0 -or $Items.Count -ge $Limit) {
    return
  }

  Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Search-CommonExecutablePath -Items $Items -Seen $Seen -Needle $Needle -Limit $Limit -Root $_.FullName -Depth ($Depth - 1)
  }
}

function Find-Executables {
  param(
    [string]$Query = "",
    [int]$Limit = 80
  )

  if ($Limit -lt 1 -or $Limit -gt 200) {
    $Limit = 80
  }
  $needle = $Query.Trim()
  $items = New-Object System.Collections.Generic.List[object]
  $seen = @{}

  $startRoots = @(
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
  )
  $wsh = New-Object -ComObject WScript.Shell
  foreach ($root in $startRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      continue
    }
    Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $shortcut = $wsh.CreateShortcut($_.FullName)
        Add-ExecutableCandidate -Items $items -Seen $seen -Needle $needle -Limit $Limit -Name ([IO.Path]::GetFileNameWithoutExtension($_.Name)) -Path $shortcut.TargetPath -WorkingDir $shortcut.WorkingDirectory -Source "start_menu" -Publisher $null -Version $null
      } catch {
      }
    }
  }

  $regRoots = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($root in $regRoots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
      $displayName = $_.DisplayName
      if (-not [string]::IsNullOrWhiteSpace($displayName)) {
        $publisher = $_.Publisher
        $version = $_.DisplayVersion
        $installLocation = Resolve-CandidatePath -Path $_.InstallLocation
        $iconPath = Get-IconExecutablePath -Icon $_.DisplayIcon

        if (-not [string]::IsNullOrWhiteSpace($iconPath)) {
          Add-ExecutableCandidate -Items $items -Seen $seen -Needle $needle -Limit $Limit -Name $displayName -Path $iconPath -WorkingDir $installLocation -Source "registry" -Publisher $publisher -Version $version
        } elseif (-not [string]::IsNullOrWhiteSpace($installLocation) -and (Test-Path -LiteralPath $installLocation -PathType Container)) {
          Get-ChildItem -LiteralPath $installLocation -Filter "*.exe" -File -ErrorAction SilentlyContinue |
            Select-Object -First 4 |
            ForEach-Object {
              Add-ExecutableCandidate -Items $items -Seen $seen -Needle $needle -Limit $Limit -Name $displayName -Path $_.FullName -WorkingDir $installLocation -Source "registry" -Publisher $publisher -Version $version
            }
        }
      }
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($needle) -and $items.Count -lt $Limit) {
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    foreach ($root in @($env:ProgramFiles, $programFilesX86, "$env:LOCALAPPDATA\Programs")) {
      Search-CommonExecutablePath -Items $items -Seen $seen -Needle $needle -Limit $Limit -Root $root -Depth 2
    }
  }

  $result = @($items | Select-Object -First $Limit)
  return @{
    candidates = $result
    truncated = ($items.Count -gt $Limit)
  }
}

function Set-AppAutostart {
  param(
    [string]$ExePath,
    [string]$WorkingDir,
    [string]$TaskName,
    [string]$AppName
  )

  if ([string]::IsNullOrWhiteSpace($ExePath)) {
    throw "Caminho do executavel nao informado."
  }
  $resolvedExe = (Resolve-Path -LiteralPath $ExePath -ErrorAction Stop).Path
  if (-not $resolvedExe.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "O caminho informado precisa apontar para um arquivo .exe."
  }
  if (-not (Test-Path -LiteralPath $resolvedExe -PathType Leaf)) {
    throw "Executavel nao encontrado: $resolvedExe"
  }

  if ([string]::IsNullOrWhiteSpace($WorkingDir)) {
    $WorkingDir = [IO.Path]::GetDirectoryName($resolvedExe)
  }
  $resolvedWorkingDir = (Resolve-Path -LiteralPath $WorkingDir -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $resolvedWorkingDir -PathType Container)) {
    throw "Pasta de trabalho nao encontrada: $resolvedWorkingDir"
  }

  if ([string]::IsNullOrWhiteSpace($AppName)) {
    $AppName = [IO.Path]::GetFileNameWithoutExtension($resolvedExe)
  }
  if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = "RadioBOT Autostart - $AppName"
  }
  $TaskName = ($TaskName -replace '[\\/:*?"<>|]', '-').Trim()
  if ([string]::IsNullOrWhiteSpace($TaskName)) {
    throw "Nome da tarefa agendada invalido."
  }

  $userId = "$env:USERDOMAIN\$env:USERNAME"

  # O Windows 7 nao tem os cmdlets *-ScheduledTask (introduzidos no Windows 8 /
  # Server 2012). Registramos a tarefa de logon via schtasks.exe com um XML no
  # schema 1.2, que e o equivalente legado ao Register-ScheduledTask do agente
  # moderno e permite definir a pasta de trabalho (WorkingDirectory).
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Abre $(ConvertTo-XmlText $AppName) automaticamente no logon pelo Radio BOT.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$(ConvertTo-XmlText $userId)</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(ConvertTo-XmlText $userId)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(ConvertTo-XmlText $resolvedExe)</Command>
      <WorkingDirectory>$(ConvertTo-XmlText $resolvedWorkingDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

  $xmlPath = Join-Path $env:TEMP ("radiobot-autostart-" + ([Guid]::NewGuid().ToString("N")) + ".xml")
  # schtasks.exe espera o XML em UTF-16 (Unicode); gravamos com BOM.
  [IO.File]::WriteAllText($xmlPath, $xml, [Text.Encoding]::Unicode)
  try {
    $createOutput = & schtasks.exe /Create /TN $TaskName /XML $xmlPath /F 2>&1
    if ($LASTEXITCODE -ne 0) {
      $detail = ($createOutput | Out-String).Trim()
      throw "Falha ao registrar tarefa agendada (schtasks $LASTEXITCODE): $detail"
    }
  } finally {
    Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
  }

  $state = "Ready"
  try {
    $query = & schtasks.exe /Query /TN $TaskName /FO LIST 2>$null
    $statusLine = $query | Where-Object { $_ -match "^\s*Status:" } | Select-Object -First 1
    if ($statusLine) {
      $state = ($statusLine -replace "^\s*Status:\s*", "").Trim()
    }
  } catch {
  }

  return @{
    action = "configure_autostart_app"
    configured = $true
    platform = "win32"
    taskName = $TaskName
    userId = $userId
    path = $resolvedExe
    workingDir = $resolvedWorkingDir
    state = $state
    legacyMode = $true
  }
}

function Invoke-LegacyCommand {
  param(
    [object]$Command,
    [object]$Profile
  )

  $action = [string]$Command.action
  $payload = Get-PropertyValue -Object $Command -Name "payload" -Default $null
  $profileId = Get-PropertyValue -Object $Command -Name "profileId" -Default $null

  switch ($action) {
    "get_state" {
      return @{
        output = @{
          legacyMode = $true
          stateOnly = $true
        }
        state = Get-AgentState
      }
    }

    "open_site" {
      $url = Require-ProfileUrl -Profile $Profile
      $title = Get-PropertyValue -Object $Profile -Name "name" -Default "Radio"
      $openOutput = Open-LegacyBrowser -Url $url -ProfileId $profileId -Title $title
      # O painel envia open_site no botao "Abrir e tocar"; espelhamos o agente
      # Playwright, que abre E toca. Sem isso a radio abre mas nunca da play.
      Start-Sleep -Seconds 3
      $playResult = Invoke-PlaybackWithFallback -Action "open_site" -Mode "play"
      $openOutput["play"] = $playResult
      return @{
        output = $openOutput
        state = Get-AgentState
      }
    }

    "login" {
      $url = Require-ProfileUrl -Profile $Profile
      $title = Get-PropertyValue -Object $Profile -Name "name" -Default "Radio"
      $output = Open-LegacyBrowser -Url $url -ProfileId $profileId -Title $title
      $output["loginAutomation"] = $false
      $output["note"] = "Agente legado abre a URL, mas nao preenche login automaticamente."
      Start-Sleep -Seconds 3
      $output["play"] = Invoke-PlaybackWithFallback -Action "login" -Mode "play"
      return @{
        output = $output
        state = Get-AgentState
      }
    }

    "reload" {
      $url = $script:ActiveUrl
      if ([string]::IsNullOrWhiteSpace($url)) {
        $url = Require-ProfileUrl -Profile $Profile
      }
      $title = Get-PropertyValue -Object $Profile -Name "name" -Default $script:Title
      return @{
        output = Open-LegacyBrowser -Url $url -ProfileId $profileId -Title $title
        state = Get-AgentState
      }
    }

    "screenshot" {
      return @{
        output = @{
          captured = $true
          source = "desktop"
          legacyMode = $true
        }
        screenshot = Capture-DesktopScreenshot
        state = Get-AgentState
      }
    }

    "play_radio" {
      $targetUrl = Require-ProfileUrl -Profile $Profile
      $shouldOpenTarget = (
        [string]::IsNullOrWhiteSpace($script:ActiveUrl) -or
        $script:ActiveUrl -ne $targetUrl -or
        $script:CurrentProfileId -ne $profileId
      )

      if ($shouldOpenTarget) {
        $title = Get-PropertyValue -Object $Profile -Name "name" -Default "Radio"
        Open-LegacyBrowser -Url $targetUrl -ProfileId $profileId -Title $title | Out-Null
        Start-Sleep -Seconds 3
      }

      return @{
        output = Invoke-PlaybackWithFallback -Action "play_radio" -Mode "play"
        state = Get-AgentState
      }
    }

    "stop_playback" {
      return @{
        output = Invoke-PlaybackWithFallback -Action "stop_playback" -Mode "stop"
        state = Get-AgentState
      }
    }

    "confirm_open_here" {
      # O agente legado nao detecta o prompt "Abrir nesta janela"; apenas
      # tenta tocar a pagina atual via CDP (com fallback de tecla multimidia).
      $playResult = Invoke-PlaybackWithFallback -Action "confirm_open_here" -Mode "play"
      $playResult["confirmedOpenHere"] = $false
      return @{
        output = $playResult
        state = Get-AgentState
      }
    }

    "discover_executables" {
      $query = [string](Get-PropertyValue -Object $payload -Name "query" -Default "")
      $limit = [int](Get-PropertyValue -Object $payload -Name "limit" -Default 80)
      $discovery = Find-Executables -Query $query -Limit $limit
      $candidates = @($discovery.candidates)
      return @{
        output = @{
          action = "discover_executables"
          platform = "win32"
          query = $query
          count = $candidates.Count
          truncated = [bool]$discovery.truncated
          candidates = $candidates
          legacyMode = $true
        }
        state = Get-AgentState
      }
    }

    "configure_autostart_app" {
      $exePath = [string](Get-PropertyValue -Object $payload -Name "path" -Default (Get-PropertyValue -Object $payload -Name "executablePath" -Default ""))
      $appName = [string](Get-PropertyValue -Object $payload -Name "name" -Default "")
      $workingDir = [string](Get-PropertyValue -Object $payload -Name "workingDir" -Default "")
      $taskNameIn = [string](Get-PropertyValue -Object $payload -Name "taskName" -Default "")
      return @{
        output = Set-AppAutostart -ExePath $exePath -WorkingDir $workingDir -TaskName $taskNameIn -AppName $appName
        state = Get-AgentState
      }
    }

    "shutdown" {
      return @{
        output = Invoke-Shutdown -Payload $payload
        state = Get-AgentState
      }
    }

    default {
      throw "Comando nao suportado no agente Windows 7 legado: $action"
    }
  }
}

function Send-CommandResult {
  param(
    [string]$CommandId,
    [string]$Status,
    [hashtable]$Output,
    [string]$ErrorMessage,
    [string]$Screenshot,
    [hashtable]$State
  )

  $body = @{
    status = $Status
    state = $State
  }
  if ($Output) {
    $body.output = $Output
  }
  if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) {
    $body.error = $ErrorMessage
  }
  if (-not [string]::IsNullOrWhiteSpace($Screenshot)) {
    $body.screenshot = $Screenshot
  }

  Invoke-AgentApi -Path "/agent-legacy/commands/$CommandId/result" -Body $body | Out-Null
}

Write-Log "Radio BOT Windows 7 legacy agent started. ApiUrl=$ApiUrl DeviceId=$DeviceId PollSeconds=$PollSeconds"

# Garante que o proximo Chrome aberto pelo agente seja uma instancia nova,
# carregando a flag de autoplay. Sem isso, um Chrome legado preso ao perfil
# manteria o autoplay bloqueado apos uma atualizacao do agente.
Stop-StaleChrome

while ($true) {
  try {
    $poll = Invoke-AgentApi -Path "/agent-legacy/poll" -Body @{
      state = Get-AgentState
    }

    $command = $poll.data.command
    if ($null -ne $command) {
      $commandId = [string]$command.id
      Write-Log "Comando recebido: $($command.action) ($commandId)"

      $sendStatus = "succeeded"
      $sendOutput = $null
      $sendScreenshot = ""
      $sendError = ""
      try {
        $result = Invoke-LegacyCommand -Command $command -Profile $poll.data.profile
        $sendOutput = Get-PropertyValue -Object $result -Name "output" -Default $null
        $sendScreenshot = Get-PropertyValue -Object $result -Name "screenshot" -Default ""
        $sendState = Get-PropertyValue -Object $result -Name "state" -Default (Get-AgentState)
        $outputJson = ""
        if ($null -ne $sendOutput) {
          try {
            $outputJson = ($sendOutput | ConvertTo-Json -Depth 12 -Compress)
          } catch {
            $outputJson = "<falha ao serializar output: $($_.Exception.Message)>"
          }
        }
        Write-Log "Comando processado: $($command.action) ($commandId) output=$outputJson"
      } catch {
        $sendStatus = "failed"
        $sendError = $_.Exception.Message
        $sendState = Get-AgentState
        Write-Log "Comando falhou: $($command.action) ($commandId): $sendError"
      }

      # Envio do resultado em try separado: assim uma falha de POST (ex.: 400)
      # nao e confundida com falha de polling e logamos o corpo da resposta.
      try {
        Send-CommandResult `
          -CommandId $commandId `
          -Status $sendStatus `
          -Output $sendOutput `
          -ErrorMessage $sendError `
          -Screenshot $sendScreenshot `
          -State $sendState
      } catch {
        $errorBody = Get-HttpErrorBody -ErrorRecord $_
        Write-Log "Falha ao enviar resultado de $($command.action) ($commandId): $($_.Exception.Message) | corpo=$errorBody"
      }
    }
  } catch {
    Write-Log "Erro de polling: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $PollSeconds
}
