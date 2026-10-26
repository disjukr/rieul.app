param(
  [Parameter(Mandatory = $true)][string]$Config,
  [string]$Node,
  [string]$Bun,
  [string]$Bundle,
  [switch]$Show
)
$ErrorActionPreference = 'Stop'
$root = if (Test-Path -LiteralPath "$PSScriptRoot/dist/host.js") { $PSScriptRoot } else { Split-Path $PSScriptRoot -Parent }
$configPath = (Resolve-Path -LiteralPath $Config).Path
if (-not $Node -and -not $Bun) {
  if (-not $Bundle) { $Bundle = Join-Path $root '../target/release/rieul-windows-gui' }
  $executable = Join-Path $Bundle 'rieul-windows-gui.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Build the self-contained native bundle first: node pairing/scripts/package.mjs' }
  $arguments = @('--config', $configPath)
  if ($Show) { $arguments += '--show' }
  & $executable @arguments
  if ($LASTEXITCODE) { throw "Native pairing utility exited with $LASTEXITCODE" }
  return
}
if (-not $Node -or -not $Bun) { throw 'Source development requires explicit -Node and -Bun together.' }
$priorBun = $env:RIEUL_PAIRING_BUN
Push-Location $root
try {
  $env:RIEUL_PAIRING_BUN = (Get-Command $Bun -ErrorAction Stop).Source
  $entry = if (Test-Path -LiteralPath 'dist/host.js') { 'dist/host.js' } else { 'src/host.ts' }
  $arguments = @($entry, '--config', $configPath)
  if ($Show) { $arguments += '--show' }
  & $Node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Pairing utility exited with $LASTEXITCODE" }
} finally {
  [Environment]::SetEnvironmentVariable('RIEUL_PAIRING_BUN', $priorBun, 'Process')
  Pop-Location
}
