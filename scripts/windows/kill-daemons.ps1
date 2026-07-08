param()

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TmpDir = Join-Path $RepoRoot "tmp\dev"
$ConfigPath = Join-Path $TmpDir "rieul.yaml"
$SystemPidFile = Join-Path $TmpDir "system.pid"
$UserPidFile = Join-Path $TmpDir "user.pid"
$GuiPidFile = Join-Path $TmpDir "gui.pid"
$SystemExe = Join-Path $RepoRoot "target\debug\rieul-windows-system.exe"
$UserExe = Join-Path $RepoRoot "target\debug\rieul-windows-user.exe"
$GuiExe = Join-Path $RepoRoot "target\debug\rieul-windows-gui.exe"

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
  $output = & taskkill.exe /PID $ProcessId /T /F 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "taskkill failed for $Label pid=$ProcessId`: $($output -join ' ')"
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }

  Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  return $true
}

function Test-DevDaemonProcess {
  param(
    [Microsoft.Management.Infrastructure.CimInstance]$Process,
    [string]$ExecutablePath,
    [string]$RequiredCommandLinePart
  )

  if (-not $Process.ExecutablePath -or -not $Process.CommandLine) {
    return $false
  }

  $actualPath = [System.IO.Path]::GetFullPath($Process.ExecutablePath)
  $expectedPath = [System.IO.Path]::GetFullPath($ExecutablePath)
  if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  if ($Process.CommandLine -notmatch '(^|\s)run($|\s)') {
    return $false
  }

  if ($RequiredCommandLinePart -and $Process.CommandLine.IndexOf($RequiredCommandLinePart, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $false
  }

  return $true
}

function Stop-DevDaemon {
  param(
    [string]$Label,
    [string]$ExecutablePath,
    [string]$PidFile,
    [string]$RequiredCommandLinePart
  )

  $stopped = @{}
  $stopCount = 0

  if (Test-Path -LiteralPath $PidFile) {
    $rawPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $processId = 0
    if ($rawPid -and [int]::TryParse(($rawPid.ToString()).Trim(), [ref]$processId)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if ($null -ne $process -and (Test-DevDaemonProcess $process $ExecutablePath $RequiredCommandLinePart)) {
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
    Where-Object { Test-DevDaemonProcess $_ $ExecutablePath $RequiredCommandLinePart } |
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
  -PidFile $UserPidFile
Stop-DevDaemon `
  -Label "gui daemon" `
  -ExecutablePath $GuiExe `
  -PidFile $GuiPidFile `
  -RequiredCommandLinePart $ConfigPath

if ($StoppedProcessCount -eq 0) {
  Write-Host "No matching dev daemons found."
} else {
  Write-Host "Stopped $StoppedProcessCount dev daemon process(es)."
}
