param(
  [Parameter(Mandatory = $true)][string]$Config,
  [string]$Node = 'node',
  [string]$Bun = 'bun',
  [switch]$Show
)
$ErrorActionPreference = 'Stop'
$root = if (Test-Path -LiteralPath "$PSScriptRoot/dist/host.js") { $PSScriptRoot } else { Split-Path $PSScriptRoot -Parent }
$configPath = (Resolve-Path -LiteralPath $Config).Path
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
