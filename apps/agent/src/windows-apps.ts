import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { CommandPayload, ExecutableCandidate } from "@radio-bot/shared";

const execFileAsync = promisify(execFile);

type DiscoveryScriptResult = {
  candidates?: unknown;
  truncated?: unknown;
};

type ConfigureScriptResult = {
  taskName?: unknown;
  userId?: unknown;
  path?: unknown;
  workingDir?: unknown;
  state?: unknown;
};

const DISCOVER_EXECUTABLES_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"

$query = [Environment]::GetEnvironmentVariable("RADIO_BOT_APP_QUERY")
$limitText = [Environment]::GetEnvironmentVariable("RADIO_BOT_APP_LIMIT")
$limit = 80
$parsedLimit = 0
if ([int]::TryParse($limitText, [ref]$parsedLimit)) {
  if ($parsedLimit -ge 1 -and $parsedLimit -le 200) {
    $limit = $parsedLimit
  }
}

$items = New-Object System.Collections.Generic.List[object]
$seen = @{}

function Expand-PathValue {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }
  return [Environment]::ExpandEnvironmentVariables($Value.Trim())
}

function Resolve-AppPath {
  param([string]$Path)
  $expanded = Expand-PathValue $Path
  if ([string]::IsNullOrWhiteSpace($expanded)) {
    return $null
  }
  try {
    return (Resolve-Path -LiteralPath $expanded -ErrorAction Stop).Path
  } catch {
    return $expanded
  }
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

  $value = Expand-PathValue $value
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }
  if (-not $value.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $value
}

function Get-AppName {
  param(
    [string]$Name,
    [string]$Path
  )

  if (-not [string]::IsNullOrWhiteSpace($Name)) {
    return $Name.Trim()
  }
  return [IO.Path]::GetFileNameWithoutExtension($Path)
}

function Test-CandidateMatch {
  param(
    [string]$Name,
    [string]$Path,
    [string]$Publisher
  )

  if ([string]::IsNullOrWhiteSpace($query)) {
    return $true
  }

  $needle = $query.Trim()
  foreach ($value in @($Name, $Path, $Publisher)) {
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }
  return $false
}

function Add-Candidate {
  param(
    [string]$Name,
    [string]$Path,
    [string]$WorkingDir,
    [string]$Source,
    [string]$Publisher,
    [string]$Version
  )

  if ($items.Count -ge ($limit * 2)) {
    return
  }

  $resolved = Resolve-AppPath $Path
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
  if ($seen.ContainsKey($key)) {
    return
  }

  $displayName = Get-AppName -Name $Name -Path $resolved
  if (-not (Test-CandidateMatch -Name $displayName -Path $resolved -Publisher $Publisher)) {
    return
  }

  $resolvedWorkingDir = Resolve-AppPath $WorkingDir
  if ([string]::IsNullOrWhiteSpace($resolvedWorkingDir) -or -not (Test-Path -LiteralPath $resolvedWorkingDir -PathType Container)) {
    $resolvedWorkingDir = [IO.Path]::GetDirectoryName($resolved)
  }

  $seen[$key] = $true
  $items.Add([pscustomobject]@{
    name = $displayName
    path = $resolved
    workingDir = $resolvedWorkingDir
    source = $Source
    publisher = $(if ([string]::IsNullOrWhiteSpace($Publisher)) { $null } else { $Publisher.Trim() })
    version = $(if ([string]::IsNullOrWhiteSpace($Version)) { $null } else { $Version.Trim() })
  }) | Out-Null
}

function Search-StartMenu {
  $roots = @(
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
  )

  $wsh = New-Object -ComObject WScript.Shell
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      continue
    }

    Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $shortcut = $wsh.CreateShortcut($_.FullName)
        Add-Candidate -Name ([IO.Path]::GetFileNameWithoutExtension($_.Name)) -Path $shortcut.TargetPath -WorkingDir $shortcut.WorkingDirectory -Source "start_menu" -Publisher $null -Version $null
      } catch {
      }
    }
  }
}

function Search-Registry {
  $roots = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  foreach ($root in $roots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
      $displayName = $_.DisplayName
      if (-not [string]::IsNullOrWhiteSpace($displayName)) {
        $publisher = $_.Publisher
        $version = $_.DisplayVersion
        $installLocation = Resolve-AppPath $_.InstallLocation
        $iconPath = Get-IconExecutablePath $_.DisplayIcon

        if (-not [string]::IsNullOrWhiteSpace($iconPath)) {
          Add-Candidate -Name $displayName -Path $iconPath -WorkingDir $installLocation -Source "registry" -Publisher $publisher -Version $version
        } elseif (-not [string]::IsNullOrWhiteSpace($installLocation) -and (Test-Path -LiteralPath $installLocation -PathType Container)) {
          Get-ChildItem -LiteralPath $installLocation -Filter "*.exe" -File -ErrorAction SilentlyContinue |
            Select-Object -First 4 |
            ForEach-Object {
              Add-Candidate -Name $displayName -Path $_.FullName -WorkingDir $installLocation -Source "registry" -Publisher $publisher -Version $version
            }
        }
      }
    }
  }
}

function Search-CommonPath {
  param(
    [string]$Root,
    [int]$Depth
  )

  if ($items.Count -ge $limit) {
    return
  }
  if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
    return
  }

  Get-ChildItem -LiteralPath $Root -Filter "*.exe" -File -ErrorAction SilentlyContinue | ForEach-Object {
    Add-Candidate -Name ([IO.Path]::GetFileNameWithoutExtension($_.Name)) -Path $_.FullName -WorkingDir $_.DirectoryName -Source "common_path" -Publisher $null -Version $null
  }

  if ($Depth -le 0 -or $items.Count -ge $limit) {
    return
  }

  Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Search-CommonPath -Root $_.FullName -Depth ($Depth - 1)
  }
}

Search-StartMenu
Search-Registry

if (-not [string]::IsNullOrWhiteSpace($query) -and $items.Count -lt $limit) {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  foreach ($root in @($env:ProgramFiles, $programFilesX86, "$env:LOCALAPPDATA\Programs")) {
    Search-CommonPath -Root $root -Depth 2
  }
}

$result = @($items | Select-Object -First $limit)
[pscustomobject]@{
  candidates = $result
  truncated = ($items.Count -gt $limit)
} | ConvertTo-Json -Depth 5 -Compress
`;

const CONFIGURE_AUTOSTART_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"

$exePath = [Environment]::GetEnvironmentVariable("RADIO_BOT_AUTOSTART_EXE")
$workingDir = [Environment]::GetEnvironmentVariable("RADIO_BOT_AUTOSTART_WORKING_DIR")
$taskName = [Environment]::GetEnvironmentVariable("RADIO_BOT_AUTOSTART_TASK")
$appName = [Environment]::GetEnvironmentVariable("RADIO_BOT_AUTOSTART_APP_NAME")

if ([string]::IsNullOrWhiteSpace($exePath)) {
  throw "Caminho do executavel nao informado."
}

$resolvedExe = (Resolve-Path -LiteralPath $exePath -ErrorAction Stop).Path
if (-not $resolvedExe.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
  throw "O caminho informado precisa apontar para um arquivo .exe."
}
if (-not (Test-Path -LiteralPath $resolvedExe -PathType Leaf)) {
  throw "Executavel nao encontrado: $resolvedExe"
}

if ([string]::IsNullOrWhiteSpace($workingDir)) {
  $workingDir = [IO.Path]::GetDirectoryName($resolvedExe)
}
$resolvedWorkingDir = (Resolve-Path -LiteralPath $workingDir -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolvedWorkingDir -PathType Container)) {
  throw "Pasta de trabalho nao encontrada: $resolvedWorkingDir"
}

if ([string]::IsNullOrWhiteSpace($appName)) {
  $appName = [IO.Path]::GetFileNameWithoutExtension($resolvedExe)
}
if ([string]::IsNullOrWhiteSpace($taskName)) {
  $taskName = "RadioBOT Autostart - $appName"
}
$taskName = ($taskName -replace '[\\/:*?"<>|]', '-').Trim()
if ([string]::IsNullOrWhiteSpace($taskName)) {
  throw "Nome da tarefa agendada invalido."
}

$userId = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $resolvedExe -WorkingDirectory $resolvedWorkingDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Abre $appName automaticamente no logon pelo Radio BOT." -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
[pscustomobject]@{
  taskName = $taskName
  userId = $userId
  path = $resolvedExe
  workingDir = $resolvedWorkingDir
  state = [string]$task.State
} | ConvertTo-Json -Depth 4 -Compress
`;

export async function discoverWindowsExecutables(payload: CommandPayload): Promise<Record<string, unknown>> {
  assertWindows();
  const query = optionalPayloadString(payload, "query") ?? "";
  const limit = clampNumber(payload.limit, 80, 1, 200);
  const result = await runPowerShellJson<DiscoveryScriptResult>(
    DISCOVER_EXECUTABLES_SCRIPT,
    {
      RADIO_BOT_APP_QUERY: query,
      RADIO_BOT_APP_LIMIT: String(limit)
    },
    30000
  );

  const rawCandidates = Array.isArray(result.candidates)
    ? result.candidates
    : result.candidates
      ? [result.candidates]
      : [];
  const candidates = normalizeCandidates(rawCandidates);

  return {
    action: "discover_executables",
    platform: platform(),
    query,
    count: candidates.length,
    truncated: result.truncated === true,
    candidates
  };
}

export async function configureWindowsAutostart(payload: CommandPayload): Promise<Record<string, unknown>> {
  assertWindows();
  const executablePath =
    optionalPayloadString(payload, "path") ?? optionalPayloadString(payload, "executablePath");
  if (!executablePath) {
    throw new Error("Caminho do executavel nao informado.");
  }
  if (!win32.isAbsolute(executablePath) || win32.extname(executablePath).toLowerCase() !== ".exe") {
    throw new Error("Informe um caminho absoluto para um arquivo .exe.");
  }

  const appName =
    optionalPayloadString(payload, "name") ?? win32.basename(executablePath, win32.extname(executablePath));
  const workingDir = optionalPayloadString(payload, "workingDir") ?? win32.dirname(executablePath);
  const taskName = sanitizeTaskName(
    optionalPayloadString(payload, "taskName") ?? `RadioBOT Autostart - ${appName}`
  );
  const result = await runPowerShellJson<ConfigureScriptResult>(
    CONFIGURE_AUTOSTART_SCRIPT,
    {
      RADIO_BOT_AUTOSTART_EXE: executablePath,
      RADIO_BOT_AUTOSTART_WORKING_DIR: workingDir,
      RADIO_BOT_AUTOSTART_TASK: taskName,
      RADIO_BOT_AUTOSTART_APP_NAME: appName
    },
    15000
  );

  return {
    action: "configure_autostart_app",
    configured: true,
    platform: platform(),
    taskName: stringOrNull(result.taskName) ?? taskName,
    userId: stringOrNull(result.userId),
    path: stringOrNull(result.path) ?? executablePath,
    workingDir: stringOrNull(result.workingDir) ?? workingDir,
    state: stringOrNull(result.state)
  };
}

function assertWindows(): void {
  if (platform() !== "win32") {
    throw new Error("Este comando esta disponivel apenas no agente Windows.");
  }
}

async function runPowerShellJson<T>(
  script: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<T> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        env: {
          ...process.env,
          ...env
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true
      }
    );
    const stdout = result.stdout.trim();
    if (!stdout) {
      throw new Error("PowerShell nao retornou dados.");
    }
    return JSON.parse(stdout) as T;
  } catch (error) {
    const detail = commandErrorDetail(error);
    throw new Error(detail ? `Falha ao executar PowerShell: ${detail}` : "Falha ao executar PowerShell.");
  }
}

function commandErrorDetail(error: unknown): string {
  const candidate = error as {
    message?: string;
    stdout?: string;
    stderr?: string;
  };
  return [candidate.stderr?.trim(), candidate.stdout?.trim(), candidate.message]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function normalizeCandidates(rawCandidates: unknown[]): ExecutableCandidate[] {
  const seen = new Set<string>();
  const candidates: ExecutableCandidate[] = [];

  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const source = stringOrNull((raw as Record<string, unknown>).source);
    if (source !== "start_menu" && source !== "registry" && source !== "common_path") {
      continue;
    }

    const path = stringOrNull((raw as Record<string, unknown>).path);
    if (!path || !win32.isAbsolute(path) || win32.extname(path).toLowerCase() !== ".exe") {
      continue;
    }

    const key = path.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const workingDir =
      stringOrNull((raw as Record<string, unknown>).workingDir) ?? win32.dirname(path);
    const name =
      stringOrNull((raw as Record<string, unknown>).name) ??
      win32.basename(path, win32.extname(path));

    candidates.push({
      id: createHash("sha1").update(key).digest("hex").slice(0, 12),
      name,
      path,
      workingDir,
      source,
      publisher: stringOrNull((raw as Record<string, unknown>).publisher),
      version: stringOrNull((raw as Record<string, unknown>).version)
    });
  }

  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

function optionalPayloadString(payload: CommandPayload, key: string): string | null {
  return stringOrNull(payload[key]);
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeTaskName(value: string): string {
  const sanitized = value.replace(/[\\/:*?"<>|]/g, "-").trim();
  return sanitized || "RadioBOT Autostart";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numberValue)));
}
