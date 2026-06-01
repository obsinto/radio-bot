[CmdletBinding()]
param(
  [string]$InstallDir = "C:\RadioBOTLegacy",
  [string]$TaskName = "RadioBOTLegacyAgent",
  [switch]$RemoveFiles
)

$ErrorActionPreference = "Stop"

schtasks.exe /End /TN $TaskName 2>$null | Out-Null
schtasks.exe /Delete /F /TN $TaskName 2>$null | Out-Null

$ResolvedInstallDir = $null
if (Test-Path -LiteralPath $InstallDir) {
  $ResolvedInstallDir = (Resolve-Path $InstallDir).Path
}

if ($ResolvedInstallDir) {
  Get-WmiObject Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*$ResolvedInstallDir*" -and
      $_.CommandLine -like "*run-agent.ps1*"
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($RemoveFiles -and $ResolvedInstallDir) {
  Remove-Item -LiteralPath $ResolvedInstallDir -Recurse -Force
}

Write-Host "Radio BOT Legacy Agent removido."
if (-not $RemoveFiles -and $ResolvedInstallDir) {
  Write-Host "Arquivos mantidos em: $ResolvedInstallDir"
}
