[CmdletBinding()]
param(
  [string]$ConfigFile = "",
  [string]$ApiUrl = "",
  [string]$DeviceId = "",
  [string]$DeviceToken = "",
  [string]$BrowserPath = "",
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

function Write-Log {
  param([string]$Message)
  "[$(Get-Date -Format o)] $Message" | Out-File -FilePath $LogFile -Append -Encoding utf8
}

$script:CurrentProfileId = $null
$script:ActiveUrl = $null
$script:Title = "Radio BOT Legacy Agent"
$script:MediaKeysLoaded = $false

function Get-AgentState {
  return @{
    currentProfileId = $script:CurrentProfileId
    activeUrl = $script:ActiveUrl
    title = $script:Title
  }
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

function Open-LegacyBrowser {
  param(
    [string]$Url,
    [string]$ProfileId,
    [string]$Title
  )

  if (-not [string]::IsNullOrWhiteSpace($BrowserPath) -and (Test-Path -LiteralPath $BrowserPath)) {
    Start-Process -FilePath $BrowserPath -ArgumentList $Url | Out-Null
  } else {
    Start-Process $Url | Out-Null
  }

  $script:CurrentProfileId = $ProfileId
  $script:ActiveUrl = $Url
  $script:Title = $Title

  return @{
    opened = $true
    url = $Url
    browserPath = $BrowserPath
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
      return @{
        output = Open-LegacyBrowser -Url $url -ProfileId $profileId -Title $title
        state = Get-AgentState
      }
    }

    "login" {
      $url = Require-ProfileUrl -Profile $Profile
      $title = Get-PropertyValue -Object $Profile -Name "name" -Default "Radio"
      $output = Open-LegacyBrowser -Url $url -ProfileId $profileId -Title $title
      $output["loginAutomation"] = $false
      $output["note"] = "Agente legado abre a URL, mas nao preenche login automaticamente."
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
      $url = $script:ActiveUrl
      if ([string]::IsNullOrWhiteSpace($url)) {
        $url = Require-ProfileUrl -Profile $Profile
        $title = Get-PropertyValue -Object $Profile -Name "name" -Default "Radio"
        Open-LegacyBrowser -Url $url -ProfileId $profileId -Title $title | Out-Null
        Start-Sleep -Seconds 3
      }
      Send-MediaKey -Key 179
      return @{
        output = @{
          mediaKey = "play_pause"
          legacyMode = $true
        }
        state = Get-AgentState
      }
    }

    "stop_playback" {
      Send-MediaKey -Key 178
      Start-Sleep -Milliseconds 250
      Send-MediaKey -Key 179
      return @{
        output = @{
          mediaKeys = @("stop", "play_pause")
          legacyMode = $true
        }
        state = Get-AgentState
      }
    }

    "confirm_open_here" {
      Send-MediaKey -Key 179
      return @{
        output = @{
          confirmedOpenHere = $false
          mediaKey = "play_pause"
          legacyMode = $true
        }
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

while ($true) {
  try {
    $poll = Invoke-AgentApi -Path "/agent-legacy/poll" -Body @{
      state = Get-AgentState
    }

    $command = $poll.data.command
    if ($null -ne $command) {
      $commandId = [string]$command.id
      Write-Log "Comando recebido: $($command.action) ($commandId)"
      try {
        $result = Invoke-LegacyCommand -Command $command -Profile $poll.data.profile
        $resultOutput = Get-PropertyValue -Object $result -Name "output" -Default $null
        $resultScreenshot = Get-PropertyValue -Object $result -Name "screenshot" -Default ""
        $resultState = Get-PropertyValue -Object $result -Name "state" -Default (Get-AgentState)
        Send-CommandResult `
          -CommandId $commandId `
          -Status "succeeded" `
          -Output $resultOutput `
          -ErrorMessage "" `
          -Screenshot $resultScreenshot `
          -State $resultState
        Write-Log "Comando concluido: $($command.action) ($commandId)"
      } catch {
        $message = $_.Exception.Message
        Send-CommandResult `
          -CommandId $commandId `
          -Status "failed" `
          -Output $null `
          -ErrorMessage $message `
          -Screenshot "" `
          -State (Get-AgentState)
        Write-Log "Comando falhou: $($command.action) ($commandId): $message"
      }
    }
  } catch {
    Write-Log "Erro de polling: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $PollSeconds
}
