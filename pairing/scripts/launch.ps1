param(
  [Parameter(Mandatory = $true)][string]$Config,
  [string]$Bundle,
  [switch]$Show
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$configPath = (Resolve-Path -LiteralPath $Config).Path
  if (-not $Bundle) { $Bundle = Join-Path $root '../target/release/rieul-windows-gui' }
  $executable = Join-Path $Bundle 'rieul-windows-gui.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Build the self-contained native bundle first: node pairing/scripts/package.mjs' }
  $arguments = @('--config', $configPath)
  if ($Show) { $arguments += '--show' }
  & $executable @arguments
  if ($LASTEXITCODE) { throw "Native pairing utility exited with $LASTEXITCODE" }
