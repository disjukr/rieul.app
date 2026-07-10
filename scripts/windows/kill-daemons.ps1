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
$GuiRuntimeName = "rieul-windows-gui.dll"
$DenoDesktopCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "deno\desktop"))
$DenoExe = (Get-Command deno -ErrorAction SilentlyContinue).Source
if (-not $DenoExe) {
  throw "deno is required to stop the Deno Desktop GUI daemon"
}

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

  $isDenoDesktop = (Split-Path -Path $expectedPath -Leaf) -ieq "deno.exe" -and
    $Process.CommandLine -match '(^|\s)desktop($|\s)'
  $isDenoDesktopBundle = (Split-Path -Path $expectedPath -Leaf) -like "rieul-windows-gui*.exe"
  if (-not $isDenoDesktop -and -not $isDenoDesktopBundle -and $Process.CommandLine -notmatch '(^|\s)run($|\s)') {
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

function Stop-GuiDesktopHosts {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $process = $_
    try {
      $loadsGuiRuntime = $process.Modules | Where-Object {
        $_.ModuleName -ieq $GuiRuntimeName -and
        $_.FileName.StartsWith(
          $DenoDesktopCacheRoot + [System.IO.Path]::DirectorySeparatorChar,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      } | Select-Object -First 1
      if ($loadsGuiRuntime -and (Stop-ProcessTree -ProcessId $process.Id -Label "gui desktop host")) {
        $script:StoppedProcessCount += 1
      }
    } catch {
      # Some protected system processes do not expose their loaded modules.
    }
  }
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
  -ExecutablePath $DenoExe `
  -PidFile $GuiPidFile `
  -RequiredCommandLinePart $ConfigPath
Stop-GuiDesktopHosts
Stop-DevDaemon `
  -Label "web dev server" `
  -ExecutablePath $DenoExe `
  -PidFile $WebPidFile `
  -RequiredCommandLinePart "npm:vite"

if ($StoppedProcessCount -eq 0) {
  Write-Host "No matching dev daemons found."
} else {
  Write-Host "Stopped $StoppedProcessCount dev daemon process(es)."
}
