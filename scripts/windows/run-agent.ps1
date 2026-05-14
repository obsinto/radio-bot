param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$LogDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$LogFile = Join-Path $LogDir "agent.log"
$Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($Npm)) {
  $Npm = (Get-Command npm -ErrorAction Stop).Source
}

Set-Location $InstallDir

"[$(Get-Date -Format o)] Radio BOT Agent runner started in $InstallDir" | Out-File -FilePath $LogFile -Append -Encoding utf8

while ($true) {
  try {
    "[$(Get-Date -Format o)] Starting agent process" | Out-File -FilePath $LogFile -Append -Encoding utf8
    & $Npm run start -w "@radio-bot/agent" *>> $LogFile
    "[$(Get-Date -Format o)] Agent process exited with code $LASTEXITCODE" | Out-File -FilePath $LogFile -Append -Encoding utf8
  } catch {
    "[$(Get-Date -Format o)] Agent process failed: $($_.Exception.Message)" | Out-File -FilePath $LogFile -Append -Encoding utf8
  }

  Start-Sleep -Seconds 5
}
