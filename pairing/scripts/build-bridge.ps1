param([string]$Rustc = 'rustc')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force -Path "$root/native/bin" | Out-Null
& $Rustc --edition=2021 --crate-type cdylib -C opt-level=2 "$root/native/windows.rs" -o "$root/native/bin/rieul_pairing_windows.dll"
if ($LASTEXITCODE -ne 0) { throw 'Pairing Windows bridge build failed' }
