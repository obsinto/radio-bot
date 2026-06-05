[CmdletBinding()]
param(
  [string]$InstallDir = "C:\RadioBOT",

  [string]$BrowserProfilePath = "",

  [string]$ActionMapJson = "{}",

  [string]$TaskName = "RadioBOTAgent",

  [switch]$SkipDependencyInstall,

  [string]$ServerUrl = "",

  [string]$DeviceId = "",

  [string]$DeviceToken = "",

  [ValidateSet("", "true", "false")]
  [string]$Headless = "",

  [ValidateSet("", "true", "false")]
  [string]$ShutdownDryRun = ""
)

$ErrorActionPreference = "Stop"

function Assert-Windows {
  if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "Este instalador deve ser executado no Windows."
  }
}

function Assert-NoInlineAgentConfig {
  foreach ($name in @("ServerUrl", "DeviceId", "DeviceToken", "Headless", "ShutdownDryRun")) {
    if ($PSBoundParameters.ContainsKey($name)) {
      throw "Parametro -$name nao e mais aceito. Execute o instalador sem credenciais/configuracao do agente na linha de comando; ele vai perguntar os dados interativamente."
    }
  }
}

function Assert-CommandExists {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando '$Name' nao encontrado. Instale Node.js LTS antes de continuar."
  }
}

function Resolve-NativeCommand {
  param(
    [string[]]$Names,
    [string]$InstallHint
  )

  foreach ($Name in $Names) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw $InstallHint
}

function Read-RequiredText {
  param(
    [string]$Prompt,
    [string]$Default = ""
  )

  while ($true) {
    if ([string]::IsNullOrWhiteSpace($Default)) {
      $value = Read-Host $Prompt
    } else {
      $value = Read-Host "$Prompt [$Default]"
      if ([string]::IsNullOrWhiteSpace($value)) {
        $value = $Default
      }
    }

    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value.Trim()
    }

    Write-Host "Valor obrigatorio." -ForegroundColor Yellow
  }
}

function ConvertTo-PlainText {
  param([securestring]$Value)

  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Remove-AgentEnvAssignment {
  param(
    [string]$Value,
    [string]$Key
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  $trimmed = $Value.Trim()
  $pattern = "^(?:export\s+)?$([regex]::Escape($Key))\s*=\s*(.*)$"
  if ($trimmed -match $pattern) {
    return $Matches[1].Trim()
  }

  return $trimmed
}

function Normalize-WebSocketUrl {
  param([string]$Value)

  $url = Remove-AgentEnvAssignment -Value $Value -Key "SERVER_URL"
  if ($url.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
    $url = "wss://$($url.Substring("https://".Length))"
  } elseif ($url.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase)) {
    $url = "ws://$($url.Substring("http://".Length))"
  }

  if ($url -match "^(wss?://[^/?#]+)/?$") {
    $url = "$($Matches[1])/agent"
  }

  return $url
}

function Read-RequiredSecret {
  param(
    [string]$Prompt,
    [string]$CurrentValue = ""
  )

  while ($true) {
    if ([string]::IsNullOrWhiteSpace($CurrentValue)) {
      $secure = Read-Host $Prompt -AsSecureString
    } else {
      $secure = Read-Host "$Prompt [ENTER para manter o atual]" -AsSecureString
      if ($secure.Length -eq 0) {
        return $CurrentValue
      }
    }

    $plain = ConvertTo-PlainText $secure
    if (-not [string]::IsNullOrWhiteSpace($plain)) {
      return $plain.Trim()
    }

    Write-Host "Valor obrigatorio." -ForegroundColor Yellow
  }
}

function Read-BooleanString {
  param(
    [string]$Prompt,
    [string]$Default
  )

  if ($Default -ne "true" -and $Default -ne "false") {
    $Default = "false"
  }

  $suffix = "s/N"
  if ($Default -eq "true") {
    $suffix = "S/n"
  }

  while ($true) {
    $answer = Read-Host "$Prompt [$suffix]"
    if ([string]::IsNullOrWhiteSpace($answer)) {
      return $Default
    }

    switch ($answer.Trim().ToLowerInvariant()) {
      { $_ -in @("s", "sim", "y", "yes", "true", "1") } { return "true" }
      { $_ -in @("n", "nao", "no", "false", "0") } { return "false" }
      default { Write-Host "Responda sim ou nao." -ForegroundColor Yellow }
    }
  }
}

function Read-AgentEnv {
  param([string]$EnvFile)

  $values = @{}
  if (-not (Test-Path $EnvFile)) {
    return $values
  }

  foreach ($line in Get-Content $EnvFile) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      continue
    }

    $separatorIndex = $line.IndexOf("=")
    $key = $line.Substring(0, $separatorIndex)
    $value = $line.Substring($separatorIndex + 1)
    $values[$key] = $value
  }

  return $values
}

function Assert-WebSocketUrlFormat {
  param([string]$Value)

  try {
    $uri = [Uri]$Value
  } catch {
    throw "SERVER_URL invalida. Use ws:// ou wss:// e a rota /agent da API."
  }

  if ($uri.Scheme -ne "ws" -and $uri.Scheme -ne "wss") {
    throw "SERVER_URL invalida. Use ws:// ou wss:// e a rota /agent da API."
  }

  if (-not $uri.AbsolutePath.Contains("/agent")) {
    Write-Host "[aviso] A URL do agente normalmente termina com /agent." -ForegroundColor Yellow
    Write-Host "[aviso] Exemplo: wss://api.seu-dominio.com/agent" -ForegroundColor Yellow
  }
}

function Test-AgentWebSocket {
  param(
    [string]$Node,
    [string]$ServerUrl,
    [string]$DeviceId,
    [string]$DeviceToken
  )

  Write-Host "[check] validando WebSocket da API"

  $script = @'
import WebSocket from "ws";

const serverUrl = process.env.RADIO_BOT_TEST_SERVER_URL ?? "";
const deviceId = process.env.RADIO_BOT_TEST_DEVICE_ID ?? "";
const token = process.env.RADIO_BOT_TEST_DEVICE_TOKEN ?? "";

let url;
try {
  url = new URL(serverUrl);
} catch (error) {
  console.error(`Falha WebSocket: SERVER_URL invalida (${error.message}).`);
  process.exit(2);
}

url.searchParams.set("deviceId", deviceId);
url.searchParams.set("token", token);
url.searchParams.set("validateOnly", "1");

let settled = false;
let socket;
const finish = (code, message) => {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timer);
  if (message) {
    (code === 0 ? console.log : console.error)(message);
  }
  try {
    socket?.close();
  } catch {
  }
  process.exit(code);
};

const timer = setTimeout(() => {
  finish(3, "Falha WebSocket: timeout aguardando confirmacao da API.");
}, 20000);

socket = new WebSocket(url, { handshakeTimeout: 20000 });

socket.on("message", (raw) => {
  try {
    const message = JSON.parse(raw.toString());
    if (message.type === "registered") {
      finish(0, `[check] WebSocket registrado como ${message.deviceId}.`);
    }
  } catch {
  }
});

socket.on("unexpected-response", (_request, response) => {
  const contentType = String(response.headers["content-type"] ?? "");
  let exitCode = 4;
  let message = `Falha WebSocket: servidor respondeu HTTP ${response.statusCode}`;
  if (contentType) {
    message += ` (${contentType})`;
  }
  message += ".";

  if (response.statusCode === 200 && contentType.includes("text/html")) {
    message += "\nEssa URL parece ser o painel web, nao a API. Use a URL WebSocket da API, por exemplo wss://api.seu-dominio.com/agent.";
  } else if (response.statusCode === 404) {
    message += "\nA rota /agent nao foi encontrada. Confira o dominio da API e o proxy.";
  } else if (response.statusCode === 502 || response.statusCode === 503 || response.statusCode === 504) {
    message += "\nA API ou o proxy reverso nao esta aceitando a conexao agora.";
    exitCode = 8;
  }

  finish(exitCode, message);
});

socket.on("close", (code, reasonBuffer) => {
  if (settled) {
    return;
  }
  const reason = reasonBuffer.toString();
  if (code === 1008) {
    finish(5, "Falha WebSocket: DEVICE_ID ou DEVICE_TOKEN recusado pela API.");
    return;
  }
  finish(6, `Falha WebSocket: conexao fechada antes do registro (codigo ${code}${reason ? `, ${reason}` : ""}).`);
});

socket.on("error", (error) => {
  finish(7, `Falha WebSocket: ${error.message}`);
});
'@

  $scriptFile = Join-Path (Get-Location).Path ".radio-bot-websocket-check-$PID.mjs"

  try {
    $env:RADIO_BOT_TEST_SERVER_URL = $ServerUrl
    $env:RADIO_BOT_TEST_DEVICE_ID = $DeviceId
    $env:RADIO_BOT_TEST_DEVICE_TOKEN = $DeviceToken
    [IO.File]::WriteAllText($scriptFile, $script, (New-Object System.Text.UTF8Encoding $false))
    & $Node $scriptFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      if ($exitCode -in @(2, 4, 5)) {
        throw "Validacao WebSocket falhou. Ajuste a URL/API/credenciais e rode o instalador novamente."
      }
      Write-Host "[aviso] Nao foi possivel confirmar o WebSocket agora. O instalador vai continuar; confira os logs do agente depois." -ForegroundColor Yellow
    }
  } finally {
    Remove-Item Env:RADIO_BOT_TEST_SERVER_URL -ErrorAction SilentlyContinue
    Remove-Item Env:RADIO_BOT_TEST_DEVICE_ID -ErrorAction SilentlyContinue
    Remove-Item Env:RADIO_BOT_TEST_DEVICE_TOKEN -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NativeCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Step
  )

  Write-Host "[$Step] $FilePath $($Arguments -join ' ')"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Step falhou. Codigo: $LASTEXITCODE"
  }
}

function Test-ProjectRoot {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    return $false
  }

  return (Test-Path -LiteralPath (Join-Path $Path "package.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Path "apps\agent\package.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Path "scripts\windows\run-agent.ps1") -PathType Leaf)
}

function Resolve-ProjectRoot {
  param([string]$StartPath)

  $current = (Resolve-Path $StartPath).Path
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    if (Test-ProjectRoot -Path $current) {
      return $current
    }

    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
      break
    }
    $current = $parent
  }

  throw @"
Nao encontrei a raiz do projeto Radio-BOT a partir de: $StartPath

Execute este instalador dentro da pasta completa do projeto, por exemplo:

  cd C:\RadioBOTInstaller\Radio-BOT
  .\scripts\windows\install-agent.ps1

Nao copie apenas install-agent.ps1; o instalador precisa de package.json, apps\agent e scripts\windows.
"@
}

function Copy-Project {
  param(
    [string]$SourceRoot,
    [string]$DestinationRoot
  )

  $source = (Resolve-Path $SourceRoot).Path.TrimEnd("\")
  $destination = (Resolve-Path $DestinationRoot).Path.TrimEnd("\")

  if (-not (Test-ProjectRoot -Path $source)) {
    throw "Pasta de origem invalida para o projeto Radio-BOT: $source"
  }

  if ($source -ieq $destination) {
    return
  }

  $robocopyArgs = @(
    $source,
    $destination,
    "/E",
    "/XD",
    "node_modules",
    "dist",
    ".git",
    ".cache",
    "playwright-report",
    "test-results",
    "/XF",
    ".env",
    "*.log",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP"
  )

  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "Falha ao copiar arquivos para $DestinationRoot. Codigo robocopy: $LASTEXITCODE"
  }
}

Assert-Windows
Assert-NoInlineAgentConfig
Assert-CommandExists "robocopy"

$Node = Resolve-NativeCommand `
  -Names @("node.exe", "node") `
  -InstallHint "Node.js nao encontrado. Instale Node.js LTS antes de continuar."
$Npm = Resolve-NativeCommand `
  -Names @("npm.cmd", "npm") `
  -InstallHint "npm nao encontrado. Instale Node.js LTS antes de continuar."
$Npx = Resolve-NativeCommand `
  -Names @("npx.cmd", "npx") `
  -InstallHint "npx nao encontrado. Instale Node.js LTS antes de continuar."

Invoke-NativeCommand -FilePath $Node -Arguments @("--version") -Step "Validando Node.js"
Invoke-NativeCommand -FilePath $Npm -Arguments @("--version") -Step "Validando npm"

$SourceRoot = Resolve-ProjectRoot -StartPath $PSScriptRoot
$InstallDir = Read-RequiredText -Prompt "Pasta de instalacao" -Default $InstallDir
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstallDir = (Resolve-Path $InstallDir).Path
$ExistingEnv = Read-AgentEnv -EnvFile (Join-Path $InstallDir ".env")

Write-Host ""
Write-Host "[config] Instalacao interativa do Radio BOT Agent"
Write-Host "[config] Use a URL da API, nao a URL do painel."
Write-Host "[config] Exemplo: wss://api.seu-dominio.com/agent"
Write-Host ""

$ServerUrl = Normalize-WebSocketUrl -Value (Read-RequiredText -Prompt "URL WebSocket da API" -Default $ExistingEnv["SERVER_URL"])
$DeviceId = Remove-AgentEnvAssignment -Value (Read-RequiredText -Prompt "Device ID do computador" -Default $ExistingEnv["DEVICE_ID"]) -Key "DEVICE_ID"
$DeviceToken = Remove-AgentEnvAssignment -Value (Read-RequiredSecret -Prompt "Device token" -CurrentValue $ExistingEnv["DEVICE_TOKEN"]) -Key "DEVICE_TOKEN"
$TaskName = Read-RequiredText -Prompt "Nome da tarefa agendada" -Default $TaskName

Copy-Project -SourceRoot $SourceRoot -DestinationRoot $InstallDir

if ([string]::IsNullOrWhiteSpace($BrowserProfilePath)) {
  if (-not [string]::IsNullOrWhiteSpace($ExistingEnv["BROWSER_PROFILE_PATH"])) {
    $BrowserProfilePath = $ExistingEnv["BROWSER_PROFILE_PATH"]
  } else {
    $BrowserProfilePath = Join-Path $InstallDir "browser-profile"
  }
}

$BrowserProfilePath = Read-RequiredText -Prompt "Perfil persistente do Chromium" -Default $BrowserProfilePath
$Headless = Read-BooleanString -Prompt "Rodar navegador em modo invisivel/headless?" -Default "false"
$ShutdownDryRun = Read-BooleanString -Prompt "Simular desligamento do computador (SHUTDOWN_DRY_RUN)?" -Default "false"

Assert-WebSocketUrlFormat -Value $ServerUrl

New-Item -ItemType Directory -Force -Path $BrowserProfilePath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "logs") | Out-Null

Set-Location $InstallDir

if (-not $SkipDependencyInstall) {
  Invoke-NativeCommand -FilePath $Npm -Arguments @("install") -Step "Instalando dependencias"
  Invoke-NativeCommand -FilePath $Npx -Arguments @("playwright", "install", "chromium") -Step "Instalando Chromium Playwright"
  Invoke-NativeCommand -FilePath $Npm -Arguments @("run", "build", "-w", "@radio-bot/shared") -Step "Compilando pacote compartilhado"
  Invoke-NativeCommand -FilePath $Npm -Arguments @("run", "build", "-w", "@radio-bot/agent") -Step "Compilando agente"
}

Test-AgentWebSocket -Node $Node -ServerUrl $ServerUrl -DeviceId $DeviceId -DeviceToken $DeviceToken

$EnvFile = Join-Path $InstallDir ".env"
@"
SERVER_URL=$ServerUrl
DEVICE_ID=$DeviceId
DEVICE_TOKEN=$DeviceToken
BROWSER_PROFILE_PATH=$BrowserProfilePath
HEADLESS=$Headless
SHUTDOWN_DRY_RUN=$ShutdownDryRun
ACTION_MAP_JSON=$ActionMapJson
"@ | Set-Content -Path $EnvFile -Encoding utf8

$RunScript = Join-Path $InstallDir "scripts\windows\run-agent.ps1"
if (-not (Test-Path $RunScript)) {
  throw "Runner nao encontrado em $RunScript"
}

$UserId = "$env:USERDOMAIN\$env:USERNAME"
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$RunScript`" -InstallDir `"$InstallDir`"" `
  -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$Principal = New-ScheduledTaskPrincipal `
  -UserId $UserId `
  -LogonType Interactive `
  -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Radio BOT local agent" | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Radio BOT Agent instalado."
Write-Host "Instalacao: $InstallDir"
Write-Host "Tarefa agendada: $TaskName"
Write-Host "Device ID: $DeviceId"
Write-Host "Logs: $(Join-Path $InstallDir 'logs\agent.log')"
Write-Host ""
Write-Host "O Chromium ficara visivel porque o agente roda no logon do usuario, nao como servico isolado."
