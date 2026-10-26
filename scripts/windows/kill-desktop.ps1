param()

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TmpDir = Join-Path $RepoRoot "tmp\dev"
$ConfigPath = Join-Path $TmpDir "rieul.yaml"
$SystemPidFile = Join-Path $TmpDir "system.pid"
$UserPidFile = Join-Path $TmpDir "user.pid"
$GuiPidFile = Join-Path $TmpDir "gui.pid"
$WebPidFile = Join-Path $TmpDir "web.pid"
$SystemExe = Join-Path $RepoRoot "target\debug\rieul-windows-system.exe"
$UserExe = Join-Path $RepoRoot "target\debug\rieul-windows-user.exe"
$WebPort = 5179
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$ViteScript = Join-Path $RepoRoot "web\node_modules\vite\bin\vite.js"
$GuiExe = Join-Path $RepoRoot "target\release\rieul-windows-gui\rieul-windows-gui.exe"

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [string]$Label = "process"
  )

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $false
  }

  Write-Host "Stopping $Label pid=$ProcessId"
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
      Write-Warning "taskkill failed for $Label pid=$ProcessId`: $output"
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

  Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  return $true
}

function Test-DevDaemonProcess {
  param(
    [Microsoft.Management.Infrastructure.CimInstance]$Process,
    [string]$ExecutablePath,
    [string]$RequiredCommandLinePart,
    [int]$RequiredListeningPort = 0
  )

  if (-not $Process.ExecutablePath -or -not $Process.CommandLine) {
    return $false
  }

  $actualPath = [System.IO.Path]::GetFullPath($Process.ExecutablePath)
  $expectedPath = [System.IO.Path]::GetFullPath($ExecutablePath)
  if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $isGuiBundle = (Split-Path -Path $expectedPath -Leaf) -ieq "rieul-windows-gui.exe"
  $isNodeVite = (Split-Path -Path $expectedPath -Leaf) -ieq "node.exe" -and
    $Process.CommandLine.IndexOf($ViteScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $isNodeVite -and -not $isGuiBundle -and $Process.CommandLine -notmatch '(^|\s)run($|\s)') {
    return $false
  }

  if ($RequiredCommandLinePart) {
    $argument = '(?i)(?:^|[\s"])' + [regex]::Escape($RequiredCommandLinePart) + '(?=$|[\s"])'
    if (-not [regex]::IsMatch($Process.CommandLine, $argument, [Text.RegularExpressions.RegexOptions]::CultureInvariant)) { return $false }
  }

  if ($RequiredListeningPort -gt 0) {
    $listener = Get-NetTCPConnection `
      -State Listen `
      -LocalPort $RequiredListeningPort `
      -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $Process.ProcessId } |
      Select-Object -First 1
    if (-not $listener) {
      return $false
    }
  }

  return $true
}

function Stop-DevDaemon {
  param(
    [string]$Label,
    [string]$ExecutablePath,
    [string]$PidFile,
    [string]$RequiredCommandLinePart,
    [int]$RequiredListeningPort = 0
  )

  $stopped = @{}
  $stopCount = 0

  if (Test-Path -LiteralPath $PidFile) {
    $rawPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $processId = 0
    if ($rawPid -and [int]::TryParse(($rawPid.ToString()).Trim(), [ref]$processId)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if ($null -ne $process -and (Test-DevDaemonProcess $process $ExecutablePath $RequiredCommandLinePart $RequiredListeningPort)) {
        if (Stop-ProcessTree -ProcessId $processId -Label $Label) {
          $stopCount += 1
        }
        $stopped[$processId] = $true
      }
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }

  $exeName = Split-Path -Path $ExecutablePath -Leaf
  Get-CimInstance Win32_Process -Filter "Name = '$exeName'" -ErrorAction SilentlyContinue |
    Where-Object { Test-DevDaemonProcess $_ $ExecutablePath $RequiredCommandLinePart $RequiredListeningPort } |
    ForEach-Object {
      $processId = [int]$_.ProcessId
      if (-not $stopped.ContainsKey($processId)) {
        if (Stop-ProcessTree -ProcessId $processId -Label $Label) {
          $script:StoppedProcessCount += 1
        }
      }
    }

  $script:StoppedProcessCount += $stopCount
}

$StoppedProcessCount = 0

Stop-DevDaemon `
  -Label "system daemon" `
  -ExecutablePath $SystemExe `
  -PidFile $SystemPidFile `
  -RequiredCommandLinePart $ConfigPath
Stop-DevDaemon `
  -Label "user daemon" `
  -ExecutablePath $UserExe `
  -PidFile $UserPidFile `
  -RequiredCommandLinePart $ConfigPath
Stop-DevDaemon `
  -Label "gui daemon" `
  -ExecutablePath $GuiExe `
  -PidFile $GuiPidFile `
  -RequiredCommandLinePart $ConfigPath
Stop-DevDaemon `
  -Label "web dev server" `
  -ExecutablePath $NodeExe `
  -PidFile $WebPidFile `
  -RequiredCommandLinePart $ViteScript `
  -RequiredListeningPort $WebPort

if ($StoppedProcessCount -eq 0) {
  Write-Host "No matching desktop dev processes found."
} else {
  Write-Host "Stopped $StoppedProcessCount desktop dev process(es)."
}
