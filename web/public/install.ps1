#Requires -Version 5.1

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Rieul's PowerShell installer currently supports Windows only."
}

$releaseBaseUrl = "https://github.com/disjukr/rieul.app/releases/latest/download"
$installerName = "rieul-windows-desktop.msi"
$checksumName = "$installerName.sha256"
$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("rieul-install-" + [Guid]::NewGuid().ToString("N"))
$installerPath = Join-Path $tempDirectory $installerName
$checksumPath = Join-Path $tempDirectory $checksumName
$previousProgressPreference = $ProgressPreference
$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol

try {
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Path $tempDirectory | Out-Null

  $downloadParameters = @{
    ErrorAction = "Stop"
  }
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    $downloadParameters.UseBasicParsing = $true
  }

  Write-Host "Downloading Rieul for Windows..."
  Invoke-WebRequest @downloadParameters -Uri "$releaseBaseUrl/$installerName" -OutFile $installerPath
  Invoke-WebRequest @downloadParameters -Uri "$releaseBaseUrl/$checksumName" -OutFile $checksumPath

  $checksumText = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
  $checksumMatch = [regex]::Match($checksumText, '^(?<hash>[0-9A-Fa-f]{64})(?:\s+\*?.+)?$')
  if (-not $checksumMatch.Success) {
    throw "The downloaded SHA-256 checksum is invalid."
  }

  $expectedChecksum = $checksumMatch.Groups["hash"].Value
  $actualChecksum = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
  if (-not $actualChecksum.Equals($expectedChecksum, [StringComparison]::OrdinalIgnoreCase)) {
    throw "SHA-256 checksum verification failed."
  }

  Write-Host "Installing Rieul..."
  $process = Start-Process -FilePath "msiexec.exe" -Verb "RunAs" -ArgumentList @(
    "/i"
    "`"$installerPath`""
    "/quiet"
    "/norestart"
  ) -Wait -PassThru

  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "Rieul installer failed with exit code $($process.ExitCode)."
  }

  if ($process.ExitCode -eq 3010) {
    Write-Host "Rieul was installed successfully. Restart Windows to complete the installation."
  } else {
    Write-Host "Rieul was installed successfully."
  }
} finally {
  $ProgressPreference = $previousProgressPreference
  [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
