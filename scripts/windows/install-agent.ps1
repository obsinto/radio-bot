[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,

  [Parameter(Mandatory = $true)]
  [string]$DeviceId,

  [Parameter(Mandatory = $true)]
  [string]$DeviceToken,

  [string]$InstallDir = "C:\RadioBOT",

  [string]$BrowserProfilePath = "",

  [ValidateSet("true", "false")]
  [string]$Headless = "false",

  [string]$ActionMapJson = "{}",

  [string]$TaskName = "RadioBOTAgent",

  [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

function Assert-Windows {
  if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "Este instalador deve ser executado no Windows."
  }
}

function Assert-CommandExists {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando '$Name' nao encontrado. Instale Node.js LTS antes de continuar."
  }
}

function Copy-Project {
  param(
    [string]$SourceRoot,
    [string]$DestinationRoot
  )

  $source = (Resolve-Path $SourceRoot).Path.TrimEnd("\")
  $destination = (Resolve-Path $DestinationRoot).Path.TrimEnd("\")

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
Assert-CommandExists "node"
Assert-CommandExists "npm"
Assert-CommandExists "npx"

$SourceRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstallDir = (Resolve-Path $InstallDir).Path

Copy-Project -SourceRoot $SourceRoot -DestinationRoot $InstallDir

if ([string]::IsNullOrWhiteSpace($BrowserProfilePath)) {
  $BrowserProfilePath = Join-Path $InstallDir "browser-profile"
}

New-Item -ItemType Directory -Force -Path $BrowserProfilePath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "logs") | Out-Null

$EnvFile = Join-Path $InstallDir ".env"
@"
SERVER_URL=$ServerUrl
DEVICE_ID=$DeviceId
DEVICE_TOKEN=$DeviceToken
BROWSER_PROFILE_PATH=$BrowserProfilePath
HEADLESS=$Headless
ACTION_MAP_JSON=$ActionMapJson
"@ | Set-Content -Path $EnvFile -Encoding utf8

Set-Location $InstallDir

if (-not $SkipDependencyInstall) {
  npm install
  npx playwright install chromium
  npm run build -w "@radio-bot/shared"
  npm run build -w "@radio-bot/agent"
}

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
  -RunLevel LeastPrivilege

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
