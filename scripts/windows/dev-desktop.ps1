param(
  [string]$Listen = "0.0.0.0:9019",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TmpDir = Join-Path $RepoRoot "tmp\dev"
$LogDir = Join-Path $RepoRoot "tmp\log"
$ConfigPath = Join-Path $TmpDir "rieul.yaml"
$SystemPidFile = Join-Path $TmpDir "system.pid"
$UserPidFile = Join-Path $TmpDir "user.pid"
$GuiPidFile = Join-Path $TmpDir "gui.pid"
$WebPidFile = Join-Path $TmpDir "web.pid"
$SystemOutLog = Join-Path $LogDir "system.out.log"
$SystemErrLog = Join-Path $LogDir "system.err.log"
$UserOutLog = Join-Path $LogDir "user.out.log"
$UserErrLog = Join-Path $LogDir "user.err.log"
$GuiOutLog = Join-Path $LogDir "gui.out.log"
$GuiErrLog = Join-Path $LogDir "gui.err.log"
$WebOutLog = Join-Path $LogDir "web.out.log"
$WebErrLog = Join-Path $LogDir "web.err.log"
$SystemExe = Join-Path $RepoRoot "target\debug\rieul-windows-system.exe"
$UserExe = Join-Path $RepoRoot "target\debug\rieul-windows-user.exe"
$WebPort = 5179
$WebUrl = "http://127.0.0.1:$WebPort"
$GuiRuntimeName = "rieul-windows-gui.dll"
$DenoDesktopCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "deno\desktop"))
$DenoExe = (Get-Command deno -ErrorAction SilentlyContinue).Source
if (-not $DenoExe) {
  throw "deno is required to run the Deno Desktop GUI daemon"
}

New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [string]$Label = "process"
  )

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return
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

  $isDenoDesktop = (Split-Path -Path $expectedPath -Leaf) -ieq "deno.exe" -and
    $Process.CommandLine -match '(^|\s)desktop($|\s)'
  $isDenoDesktopBundle = (Split-Path -Path $expectedPath -Leaf) -like "rieul-windows-gui*.exe"
  if (-not $isDenoDesktop -and -not $isDenoDesktopBundle -and $Process.CommandLine -notmatch '(^|\s)run($|\s)') {
    return $false
  }

  if ($RequiredCommandLinePart -and $Process.CommandLine.IndexOf($RequiredCommandLinePart, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $false
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

function Stop-PreviousDaemon {
  param(
    [string]$Label,
    [string]$ExecutablePath,
    [string]$PidFile,
    [string]$RequiredCommandLinePart,
    [int]$RequiredListeningPort = 0
  )

  $stopped = @{}

  if (Test-Path -LiteralPath $PidFile) {
    $rawPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $processId = 0
    if ($rawPid -and [int]::TryParse(($rawPid.ToString()).Trim(), [ref]$processId)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if ($null -ne $process -and (Test-DevDaemonProcess $process $ExecutablePath $RequiredCommandLinePart $RequiredListeningPort)) {
        Stop-ProcessTree -ProcessId $processId -Label "previous $Label"
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
        Stop-ProcessTree -ProcessId $processId -Label "previous $Label"
      }
    }
}

function Get-GuiDesktopHostProcesses {
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
      if ($loadsGuiRuntime) {
        $process
      }
    } catch {
      # Some protected system processes do not expose their loaded modules.
    }
  }
}

function Stop-PreviousGuiDesktopHosts {
  @(Get-GuiDesktopHostProcesses) | ForEach-Object {
    Stop-ProcessTree -ProcessId $_.Id -Label "previous GUI desktop host"
  }
}

function Wait-GuiDesktopHost {
  param(
    [System.Diagnostics.Process]$Launcher,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $hostProcess = @(Get-GuiDesktopHostProcesses) | Select-Object -First 1
    if ($hostProcess) {
      return $hostProcess
    }
    if ($Launcher.HasExited) {
      throw "GUI desktop launcher exited with code $($Launcher.ExitCode) before its host started"
    }
    Start-Sleep -Milliseconds 100
  }

  throw "GUI desktop host did not start within $TimeoutSeconds seconds"
}

Stop-PreviousDaemon `
  -Label "system daemon" `
  -ExecutablePath $SystemExe `
  -PidFile $SystemPidFile `
  -RequiredCommandLinePart $ConfigPath
Stop-PreviousDaemon `
  -Label "user daemon" `
  -ExecutablePath $UserExe `
  -PidFile $UserPidFile
Stop-PreviousDaemon `
  -Label "gui daemon" `
  -ExecutablePath $DenoExe `
  -PidFile $GuiPidFile `
  -RequiredCommandLinePart $ConfigPath
Stop-PreviousGuiDesktopHosts
Stop-PreviousDaemon `
  -Label "web dev server" `
  -ExecutablePath $DenoExe `
  -PidFile $WebPidFile `
  -RequiredCommandLinePart "npm:vite" `
  -RequiredListeningPort $WebPort

if (-not $SkipBuild) {
  Push-Location $RepoRoot
  try {
    cargo build -p rieul-windows-daemon --bin rieul-windows-system --bin rieul-windows-user
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $SystemExe)) {
  throw "Missing $SystemExe. Run without -SkipBuild first."
}
if (-not (Test-Path $UserExe)) {
  throw "Missing $UserExe. Run without -SkipBuild first."
}
Push-Location (Join-Path $RepoRoot "web")
try {
  deno task desktop:icons
} finally {
  Pop-Location
}

$children = @()
$childLogs = @{}
$childPidFiles = @{}

function Show-LogTail {
  param(
    [string]$Label,
    [string]$Path,
    [int]$Tail = 80
  )

  if (-not (Test-Path $Path)) {
    Write-Host ""
    Write-Host "[$Label] log not found: $Path" -ForegroundColor Yellow
    return
  }

  Write-Host ""
  Write-Host "[$Label] last $Tail lines: $Path" -ForegroundColor Yellow
  $content = Get-Content -Path $Path -Tail $Tail -ErrorAction SilentlyContinue
  if ($content) {
    $content | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host "(empty)"
  }
}

function Show-ChildLogs {
  param([System.Diagnostics.Process]$Child)

  $logs = $childLogs[$Child.Id]
  if ($null -eq $logs) {
    return
  }

  Show-LogTail "$($logs.Name) stdout" $logs.Stdout
  Show-LogTail "$($logs.Name) stderr" $logs.Stderr
}

function Wait-HttpReady {
  param(
    [string]$Url,
    [string]$Label,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }

  throw "$Label did not become ready at $Url within $TimeoutSeconds seconds"
}

function Stop-ChildProcesses {
  foreach ($child in $children) {
    if ($null -ne $child -and -not $child.HasExited) {
      Stop-ProcessTree -ProcessId $child.Id -Label $child.ProcessName
    }

    if ($null -ne $child) {
      $pidFile = $childPidFiles[$child.Id]
      if ($pidFile) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

$exitSubscription = Register-EngineEvent PowerShell.Exiting -Action {
  foreach ($child in $children) {
    if ($null -ne $child -and -not $child.HasExited) {
      taskkill.exe /PID $child.Id /T /F | Out-Null
    }
  }

  foreach ($pidFile in $childPidFiles.Values) {
    if ($pidFile) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  Write-Host "Starting rieul Windows system daemon on $Listen"
  $system = Start-Process `
    -FilePath $SystemExe `
    -ArgumentList @("run", "--listen", $Listen, "--config", $ConfigPath) `
    -WorkingDirectory $RepoRoot `
    -PassThru `
    -RedirectStandardOutput $SystemOutLog `
    -RedirectStandardError $SystemErrLog `
    -WindowStyle Hidden
  $children += $system
  Set-Content -LiteralPath $SystemPidFile -Value $system.Id -Encoding ASCII
  $childPidFiles[$system.Id] = $SystemPidFile
  $childLogs[$system.Id] = @{
    Name = "system daemon"
    Stdout = $SystemOutLog
    Stderr = $SystemErrLog
  }

  Write-Host "Starting rieul Windows user daemon"
  $user = Start-Process `
    -FilePath $UserExe `
    -ArgumentList @("run", "--config", $ConfigPath) `
    -WorkingDirectory $RepoRoot `
    -PassThru `
    -RedirectStandardOutput $UserOutLog `
    -RedirectStandardError $UserErrLog `
    -WindowStyle Hidden
  $children += $user
  Set-Content -LiteralPath $UserPidFile -Value $user.Id -Encoding ASCII
  $childPidFiles[$user.Id] = $UserPidFile
  $childLogs[$user.Id] = @{
    Name = "user daemon"
    Stdout = $UserOutLog
    Stderr = $UserErrLog
  }

  Write-Host "Starting Rieul web dev server on $WebUrl"
  $web = Start-Process `
    -FilePath $DenoExe `
    -ArgumentList @(
      "run",
      "-A",
      "npm:vite@^6.0.0",
      "--host",
      "127.0.0.1",
      "--port",
      $WebPort,
      "--strictPort"
    ) `
    -WorkingDirectory (Join-Path $RepoRoot "web") `
    -PassThru `
    -RedirectStandardOutput $WebOutLog `
    -RedirectStandardError $WebErrLog `
    -WindowStyle Hidden
  $children += $web
  Set-Content -LiteralPath $WebPidFile -Value $web.Id -Encoding ASCII
  $childPidFiles[$web.Id] = $WebPidFile
  $childLogs[$web.Id] = @{
    Name = "web dev server"
    Stdout = $WebOutLog
    Stderr = $WebErrLog
  }
  Wait-HttpReady -Url $WebUrl -Label "web dev server"

  Write-Host "Starting rieul Windows GUI daemon"
  $guiLauncher = Start-Process `
    -FilePath $DenoExe `
    -ArgumentList @(
      "desktop",
      "--hmr",
      "-A",
      "--include",
      ".\desktop\icon.ico",
      ".\desktop\main.ts",
      "--",
      "--config",
      $ConfigPath,
      "--dev-url",
      "$WebUrl/daemon-main.html"
    ) `
    -WorkingDirectory (Join-Path $RepoRoot "web") `
    -PassThru `
    -RedirectStandardOutput $GuiOutLog `
    -RedirectStandardError $GuiErrLog `
    -WindowStyle Hidden
  try {
    $gui = Wait-GuiDesktopHost -Launcher $guiLauncher
  } catch {
    Show-LogTail "gui daemon stdout" $GuiOutLog
    Show-LogTail "gui daemon stderr" $GuiErrLog
    throw
  }
  $children += $gui
  Set-Content -LiteralPath $GuiPidFile -Value $gui.Id -Encoding ASCII
  $childPidFiles[$gui.Id] = $GuiPidFile
  $childLogs[$gui.Id] = @{
    Name = "gui daemon"
    Stdout = $GuiOutLog
    Stderr = $GuiErrLog
  }

  Write-Host ""
  Write-Host "System daemon pid=$($system.Id)"
  Write-Host "User daemon pid=$($user.Id)"
  Write-Host "Web dev server pid=$($web.Id)"
  Write-Host "GUI daemon pid=$($gui.Id)"
  Write-Host "Dev config: $ConfigPath"
  Write-Host "Logs: $LogDir"
  Write-Host "WebTransport endpoint: https://$Listen/rieul/rpc"
  Write-Host "Press Ctrl+C or close this script to stop the desktop dev environment."

  while ($true) {
    foreach ($child in $children) {
      if ($child.HasExited) {
        Show-ChildLogs $child
        throw "$($child.ProcessName) exited with code $($child.ExitCode)"
      }
    }
    Start-Sleep -Seconds 1
  }
} finally {
  Stop-ChildProcesses
  if ($exitSubscription) {
    Unregister-Event -SubscriptionId $exitSubscription.Id -ErrorAction SilentlyContinue
  }
}
