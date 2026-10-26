param(
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][string]$Extracted,
  [Parameter(Mandatory)][string]$GuiBundle
)
$ErrorActionPreference = 'Stop'
[xml]$document = Get-Content -Raw -LiteralPath $Source
$guiRoot = [IO.Path]::GetFullPath($GuiBundle).TrimEnd('\') + '\'
$count = 0
foreach ($file in $document.SelectNodes("//*[local-name()='File']")) {
  $original = [IO.Path]::GetFullPath($file.Source)
  if (-not $original.StartsWith($guiRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $actual = Join-Path (Join-Path $Extracted 'File') $file.Id
  if (-not (Test-Path -LiteralPath $actual -PathType Leaf)) { throw "Missing MSI payload: $($file.Id)" }
  if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash) {
    throw "MSI payload differs from verified bundle: $($file.Id)"
  }
  $count++
}
if ($count -lt 10) { throw "Incomplete MSI GUI payload: $count files" }
Write-Host "Verified $count MSI GUI payload files without installation"
