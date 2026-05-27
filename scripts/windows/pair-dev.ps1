param(
  [string]$Listen = "0.0.0.0:8765",
  [string]$Url,
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ConfigPath = Join-Path $RepoRoot "tmp\dev\system-wgo.yaml"
$SystemExe = Join-Path $RepoRoot "target\debug\wgo-windows-system.exe"

if ($Build -or -not (Test-Path $SystemExe)) {
  Push-Location $RepoRoot
  try {
    cargo build -p wgo-windows-daemon --bin wgo-windows-system
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $SystemExe)) {
  throw "Missing $SystemExe. Run without -SkipBuild first."
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config not found: $ConfigPath. Start .\scripts\windows\dev-daemons.ps1 first."
}

$commandArgs = @("pair", "--listen", $Listen, "--config", $ConfigPath)
if ($Url) {
  $commandArgs += @("--url", $Url)
}

& $SystemExe @commandArgs
