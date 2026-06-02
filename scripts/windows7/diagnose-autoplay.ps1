[CmdletBinding()]
param(
  [int]$ChromeDebugPort = 9222
)

# Diagnostico do autoplay do agente legado Windows 7.
# Roda standalone, sem depender da tarefa agendada, e imprime tudo que
# precisamos para entender por que o play nao funcionou.
#
# Uso:
#   cd C:\RadioBOTLegacy   (ou onde o agente foi instalado)
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\scripts\windows7\diagnose-autoplay.ps1
#
# Copie TODA a saida e cole de volta para a gente analisar.

$ErrorActionPreference = "Continue"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "===== $Title =====" -ForegroundColor Cyan
}

Write-Section "Ambiente"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "OS: $([Environment]::OSVersion.VersionString)"
Write-Host "Porta DevTools alvo: $ChromeDebugPort"

Write-Section "Processos Chrome em execucao"
$chromeProcs = @()
try {
  $chromeProcs = @(Get-WmiObject Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
} catch {
  Write-Host "Falha ao consultar processos: $($_.Exception.Message)" -ForegroundColor Red
}

if ($chromeProcs.Count -eq 0) {
  Write-Host "Nenhum chrome.exe em execucao." -ForegroundColor Yellow
} else {
  Write-Host "$($chromeProcs.Count) processo(s) chrome.exe encontrado(s)."
  $autoplayFlagPresent = $false
  $debugPortPresent = $false
  foreach ($proc in $chromeProcs) {
    $cmd = [string]$proc.CommandLine
    if ($cmd -match "--autoplay-policy=no-user-gesture-required") {
      $autoplayFlagPresent = $true
    }
    if ($cmd -match "--remote-debugging-port=$ChromeDebugPort") {
      $debugPortPresent = $true
    }
    # So imprime as linhas relevantes (com flags), evitando poluir com renderers.
    if ($cmd -match "--remote-debugging-port|--autoplay-policy|--user-data-dir") {
      Write-Host ("PID {0}: {1}" -f $proc.ProcessId, $cmd)
    }
  }
  Write-Host ""
  if ($autoplayFlagPresent) {
    Write-Host "OK: ha um Chrome rodando COM a flag --autoplay-policy=no-user-gesture-required." -ForegroundColor Green
  } else {
    Write-Host "ATENCAO: nenhum Chrome em execucao tem a flag de autoplay. O play sera bloqueado." -ForegroundColor Yellow
    Write-Host "         Feche todos os Chrome desse perfil e deixe o agente reabrir." -ForegroundColor Yellow
  }
  if (-not $debugPortPresent) {
    Write-Host "ATENCAO: nenhum Chrome com --remote-debugging-port=$ChromeDebugPort. O CDP nao vai conectar." -ForegroundColor Yellow
  }
}

Write-Section "Endpoint DevTools HTTP"
try {
  $version = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$ChromeDebugPort/json/version" -TimeoutSec 4
  Write-Host "Conectou em /json/version:" -ForegroundColor Green
  $version | Format-List | Out-String | Write-Host
} catch {
  Write-Host "Falha em /json/version: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Isso significa que o Chrome NAO esta com a porta de debug aberta." -ForegroundColor Yellow
}

Write-Section "Abas abertas (/json/list)"
try {
  $tabs = @(Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$ChromeDebugPort/json/list" -TimeoutSec 4)
  $pages = @($tabs | Where-Object { $_.type -eq "page" })
  Write-Host "$($pages.Count) aba(s) do tipo 'page':"
  foreach ($tab in $pages) {
    Write-Host ("- [{0}] {1}" -f $tab.title, $tab.url)
    Write-Host ("    id={0}" -f $tab.id)
    Write-Host ("    ws={0}" -f $tab.webSocketDebuggerUrl)
  }
} catch {
  Write-Host "Falha em /json/list: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Section "Ultimas linhas do agent.log"
$logCandidates = @(
  (Join-Path $PSScriptRoot "agent.log"),
  (Join-Path (Split-Path -Parent $PSScriptRoot) "agent.log"),
  "C:\RadioBOTLegacy\agent.log"
)
$logFound = $false
foreach ($candidate in $logCandidates) {
  if (Test-Path -LiteralPath $candidate) {
    Write-Host "Log: $candidate"
    Get-Content -LiteralPath $candidate -Tail 40 | ForEach-Object { Write-Host $_ }
    $logFound = $true
    break
  }
}
if (-not $logFound) {
  Write-Host "agent.log nao encontrado nos caminhos padrao. Informe o caminho da instalacao." -ForegroundColor Yellow
}

Write-Section "Resumo"
Write-Host "Cole TODA esta saida de volta para analisarmos."
Write-Host "Pontos-chave: flag de autoplay presente? porta de debug aberta? quantas abas? o que diz o agent.log no ultimo play_radio (fallback=true ou false)?"
