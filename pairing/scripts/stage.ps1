param([string]$Node = 'node', [string]$OutDir)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $OutDir) { $OutDir = Join-Path $root ("stage/" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (Test-Path -LiteralPath $OutDir) { throw 'Choose a new staging directory; existing files are never overwritten.' }
$out = [System.IO.Path]::GetFullPath($OutDir)
& $Node (Join-Path $PSScriptRoot 'package.mjs') --out $out
if ($LASTEXITCODE) { throw 'Self-contained native staging failed' }
Write-Output "Staged self-contained bundle: $out"
Write-Output "Launch: $out/rieul-windows-gui.exe --config <isolated-config> --show"
