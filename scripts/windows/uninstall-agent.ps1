[CmdletBinding()]
param(
  [string]$InstallDir = "C:\RadioBOT",
  [string]$TaskName = "RadioBOTAgent",
  [switch]$RemoveFiles
)

$ErrorActionPreference = "Stop"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$ResolvedInstallDir = $null
if (Test-Path $InstallDir) {
  $ResolvedInstallDir = (Resolve-Path $InstallDir).Path
}

if ($ResolvedInstallDir) {
  $escapedPath = $ResolvedInstallDir.Replace("\", "\\")
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      ($_.CommandLine -match [regex]::Escape($ResolvedInstallDir) -or $_.CommandLine -match [regex]::Escape($escapedPath)) -and
      ($_.CommandLine -match "@radio-bot/agent" -or $_.CommandLine -match "run-agent.ps1")
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($RemoveFiles -and $ResolvedInstallDir) {
  Remove-Item -Path $ResolvedInstallDir -Recurse -Force
}

Write-Host "Radio BOT Agent removido."
if (-not $RemoveFiles -and $ResolvedInstallDir) {
  Write-Host "Arquivos mantidos em: $ResolvedInstallDir"
}

