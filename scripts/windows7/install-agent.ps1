[CmdletBinding()]
param(
  [string]$InstallDir = "C:\RadioBOTLegacy",
  [string]$TaskName = "RadioBOTLegacyAgent"
)

$ErrorActionPreference = "Stop"

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

function Read-OptionalText {
  param(
    [string]$Prompt,
    [string]$Default = ""
  )

  if ([string]::IsNullOrWhiteSpace($Default)) {
    return (Read-Host $Prompt).Trim()
  }

  $value = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }
  return $value.Trim()
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

function Read-RequiredSecret {
  param([string]$Prompt)

  while ($true) {
    $secure = Read-Host $Prompt -AsSecureString
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
      "s" { return "true" }
      "sim" { return "true" }
      "y" { return "true" }
      "yes" { return "true" }
      "n" { return "false" }
      "nao" { return "false" }
      "no" { return "false" }
      default { Write-Host "Responda sim ou nao." -ForegroundColor Yellow }
    }
  }
}

function Escape-SingleQuoted {
  param([string]$Value)
  return $Value.Replace("'", "''")
}

function Invoke-Native {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Step
  )

  Write-Host "[$Step] $FilePath $($Arguments -join ' ')"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Step falhou com codigo $LASTEXITCODE."
  }
}

if ($PSVersionTable.PSVersion.Major -lt 3) {
  throw "Este instalador exige PowerShell 3 ou superior. No Windows 7, instale Windows Management Framework 5.1 antes de continuar."
}

Write-Host ""
Write-Host "[config] Instalacao do Radio BOT Legacy Agent para Windows 7"
Write-Host "[config] Use a URL HTTP/HTTPS da API. Tambem aceito ws:// ou wss://.../agent e converto automaticamente no runner."
Write-Host ""

$InstallDir = Read-RequiredText -Prompt "Pasta de instalacao" -Default $InstallDir
$ApiUrl = Read-RequiredText -Prompt "URL da API" -Default "https://api.seu-dominio.com"
$DeviceId = Read-RequiredText -Prompt "Device ID do computador"
$DeviceToken = Read-RequiredSecret -Prompt "Device token"
$BrowserPath = Read-OptionalText -Prompt "Caminho do navegador (ENTER para usar navegador padrao)" -Default ""
$TaskName = Read-RequiredText -Prompt "Nome da tarefa agendada" -Default $TaskName
$ShutdownDryRun = Read-BooleanString -Prompt "Simular desligamento do computador (SHUTDOWN_DRY_RUN)?" -Default "true"

$pollText = Read-OptionalText -Prompt "Intervalo de polling em segundos" -Default "5"
$PollSeconds = 5
if ([int]::TryParse($pollText, [ref]$PollSeconds) -eq $false -or $PollSeconds -lt 2) {
  $PollSeconds = 5
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstallDir = (Resolve-Path $InstallDir).Path

$SourceRunner = Join-Path $PSScriptRoot "run-agent.ps1"
if (-not (Test-Path -LiteralPath $SourceRunner)) {
  throw "Runner nao encontrado: $SourceRunner"
}

$RunScript = Join-Path $InstallDir "run-agent.ps1"
$ConfigFile = Join-Path $InstallDir "agent.config.ps1"
$LogFile = Join-Path $InstallDir "agent.log"

Copy-Item -LiteralPath $SourceRunner -Destination $RunScript -Force

@"
`$ApiUrl = '$(Escape-SingleQuoted $ApiUrl)'
`$DeviceId = '$(Escape-SingleQuoted $DeviceId)'
`$DeviceToken = '$(Escape-SingleQuoted $DeviceToken)'
`$BrowserPath = '$(Escape-SingleQuoted $BrowserPath)'
`$PollSeconds = $PollSeconds
`$ShutdownDryRun = '$(Escape-SingleQuoted $ShutdownDryRun)'
`$LogFile = '$(Escape-SingleQuoted $LogFile)'
"@ | Set-Content -Path $ConfigFile -Encoding utf8

$TaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$RunScript`" -ConfigFile `"$ConfigFile`""
Invoke-Native -FilePath "schtasks.exe" -Arguments @("/Create", "/F", "/SC", "ONLOGON", "/TN", $TaskName, "/TR", $TaskCommand) -Step "Criando tarefa agendada"
Invoke-Native -FilePath "schtasks.exe" -Arguments @("/Run", "/TN", $TaskName) -Step "Iniciando agente"

Write-Host ""
Write-Host "Radio BOT Legacy Agent instalado."
Write-Host "Instalacao: $InstallDir"
Write-Host "Tarefa agendada: $TaskName"
Write-Host "Logs: $LogFile"
Write-Host ""
Write-Host "Este agente nao usa Playwright. Ele abre URL no navegador instalado e faz polling HTTP na API."
