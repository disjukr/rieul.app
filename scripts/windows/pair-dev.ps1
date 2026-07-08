param(
  [string]$Listen = "0.0.0.0:9019",
  [string]$Url,
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ConfigPath = Join-Path $RepoRoot "tmp\dev\rieul.yaml"
$SystemExe = Join-Path $RepoRoot "target\debug\rieul-windows-system.exe"

if ($Build -or -not (Test-Path $SystemExe)) {
  Push-Location $RepoRoot
  try {
    cargo build -p rieul-windows-daemon --bin rieul-windows-system
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $SystemExe)) {
  throw "Missing $SystemExe. Run without -SkipBuild first."
}
$commandArgs = @("pair", "--listen", $Listen, "--config", $ConfigPath)
if ($Url) {
  $commandArgs += @("--url", $Url)
}

& $SystemExe @commandArgs
