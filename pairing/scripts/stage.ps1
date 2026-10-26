param([string]$Bun = 'bun', [string]$OutDir)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $OutDir) { $OutDir = Join-Path $root ("stage/" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (Test-Path -LiteralPath $OutDir) { throw 'Choose a new staging directory; existing files are never overwritten.' }
$out = [System.IO.Path]::GetFullPath($OutDir)
Push-Location $root
try {
  & $Bun run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
  New-Item -ItemType Directory -Path "$out/native/bin" -Force | Out-Null
  Copy-Item -LiteralPath "$root/dist" -Destination "$out/dist" -Recurse
  Copy-Item -LiteralPath "$root/native/bin/rieul_pairing_windows.dll" -Destination "$out/native/bin/"
  foreach ($file in @('package.json', 'bun.lock', 'bunfig.toml')) { Copy-Item -LiteralPath "$root/$file" -Destination "$out/$file" }
  Copy-Item -LiteralPath "$root/scripts/launch.ps1" -Destination "$out/launch.ps1"
  Push-Location $out
  try {
    & $Bun install --production --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Staging dependency install failed' }
  } finally { Pop-Location }
  Write-Output "Staged: $out"
  Write-Output 'Explicit launch only: ./launch.ps1 -Config <isolated-config> -Show'
} finally { Pop-Location }
