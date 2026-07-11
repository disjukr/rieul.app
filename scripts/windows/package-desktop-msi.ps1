#Requires -Version 5.1

param(
  [string]$Version,
  [string]$OutDir,
  [string]$Manufacturer = "JongChan Choi",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Get-CargoPackageVersion {
  param([string]$CargoTomlPath)

  $cargoToml = Get-Content -LiteralPath $CargoTomlPath
  $versionLine = $cargoToml |
    Where-Object { $_ -match '^version\s*=\s*"([^"]+)"' } |
    Select-Object -First 1
  if (-not $versionLine) {
    throw "Could not infer desktop package version from $CargoTomlPath"
  }
  return [regex]::Match($versionLine, '^version\s*=\s*"([^"]+)"').Groups[1].Value
}

function ConvertTo-MsiVersion {
  param([string]$CargoVersion)

  $numericVersion = ($CargoVersion -split '[-+]')[0]
  $parts = @($numericVersion -split '\.')
  if ($parts.Count -gt 3) {
    throw "MSI product versions can contain at most three numeric parts: $CargoVersion"
  }
  while ($parts.Count -lt 3) {
    $parts += "0"
  }
  for ($index = 0; $index -lt $parts.Count; $index++) {
    $part = $parts[$index]
    if ($part -notmatch '^\d+$') {
      throw "MSI version parts must be numeric: $CargoVersion"
    }
    $partNumber = [int]$part
    $max = if ($index -lt 2) { 255 } else { 65535 }
    if ($partNumber -lt 0 -or $partNumber -gt $max) {
      throw "MSI version part $($index + 1) is out of range 0..$max`: $CargoVersion"
    }
  }
  return ($parts -join ".")
}

function ConvertTo-XmlEscapedText {
  param([string]$Value)

  return [System.Security.SecurityElement]::Escape($Value)
}

function ConvertTo-WixSourcePath {
  param([string]$Path)

  return (ConvertTo-XmlEscapedText ((Resolve-Path -LiteralPath $Path).Path))
}

function Assert-GuiBundle {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Missing GUI bundle: $Path"
  }

  $requiredPaths = @(
    "rieul-windows-gui.exe",
    "rieul-windows-gui.dll",
    "libcef.dll",
    "resources.pak",
    "locales"
  )
  foreach ($relativePath in $requiredPaths) {
    $requiredPath = Join-Path $Path $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "GUI bundle is incomplete; missing: $requiredPath"
    }
  }
}

function Add-GuiBundleDirectorySource {
  param(
    [System.IO.DirectoryInfo]$Directory,
    [string]$DirectoryId,
    [string]$Indent,
    [string]$BundleRoot,
    [hashtable]$DirectoryIds,
    [System.Collections.Generic.List[string]]$Lines,
    [System.Collections.Generic.List[string]]$ComponentRefs,
    [ref]$FileIndex,
    [ref]$LauncherFound
  )

  $directoryName = if ($Directory.FullName -eq $BundleRoot) {
    "gui"
  } else {
    ConvertTo-XmlEscapedText $Directory.Name
  }
  $Lines.Add("$Indent<Directory Id=`"$DirectoryId`" Name=`"$directoryName`">")

  $childIndent = "$Indent  "
  $files = @(Get-ChildItem -LiteralPath $Directory.FullName -File -Force | Sort-Object Name)
  foreach ($file in $files) {
    $index = $FileIndex.Value
    $FileIndex.Value = $index + 1
    $componentId = "GuiBundleComponent{0:D4}" -f $index
    $relativePath = $file.FullName.Substring($BundleRoot.Length + 1)
    $isLauncher = $relativePath -ieq "rieul-windows-gui.exe"
    $fileId = if ($isLauncher) { "GuiExe" } else { "GuiBundleFile{0:D4}" -f $index }
    $filePath = ConvertTo-WixSourcePath $file.FullName

    $Lines.Add("$childIndent<Component Id=`"$componentId`" Guid=`"*`" Bitness=`"always64`">")
    $Lines.Add("$childIndent  <File Id=`"$fileId`" Source=`"$filePath`" KeyPath=`"yes`" />")
    if ($isLauncher) {
      $LauncherFound.Value = $true
      $Lines.Add("$childIndent  <RegistryValue")
      $Lines.Add("$childIndent    Root=`"HKLM`"")
      $Lines.Add("$childIndent    Key=`"Software\Microsoft\Windows\CurrentVersion\Run`"")
      $Lines.Add("$childIndent    Name=`"Rieul Desktop`"")
      $Lines.Add("$childIndent    Type=`"string`"")
      $Lines.Add("$childIndent    Value=`"&quot;[#GuiExe]&quot;`" />")
    }
    $Lines.Add("$childIndent</Component>")
    $ComponentRefs.Add("      <ComponentRef Id=`"$componentId`" />")
  }

  $childDirectories = @(Get-ChildItem -LiteralPath $Directory.FullName -Directory -Force | Sort-Object Name)
  foreach ($childDirectory in $childDirectories) {
    Add-GuiBundleDirectorySource `
      -Directory $childDirectory `
      -DirectoryId $DirectoryIds[$childDirectory.FullName] `
      -Indent $childIndent `
      -BundleRoot $BundleRoot `
      -DirectoryIds $DirectoryIds `
      -Lines $Lines `
      -ComponentRefs $ComponentRefs `
      -FileIndex $FileIndex `
      -LauncherFound $LauncherFound
  }

  $Lines.Add("$Indent</Directory>")
}

function New-GuiBundleWixSource {
  param([string]$GuiBundle)

  $bundle = Get-Item -LiteralPath $GuiBundle
  $bundleRoot = $bundle.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $directoryIds = @{}
  $directories = @(Get-ChildItem -LiteralPath $bundleRoot -Directory -Recurse -Force | Sort-Object FullName)
  for ($index = 0; $index -lt $directories.Count; $index++) {
    $directoryIds[$directories[$index].FullName] = "GuiBundleDirectory{0:D4}" -f $index
  }

  $lines = [System.Collections.Generic.List[string]]::new()
  $componentRefs = [System.Collections.Generic.List[string]]::new()
  $fileIndex = 0
  $launcherFound = $false
  Add-GuiBundleDirectorySource `
    -Directory $bundle `
    -DirectoryId "GuiBundleFolder" `
    -Indent "        " `
    -BundleRoot $bundleRoot `
    -DirectoryIds $directoryIds `
    -Lines $lines `
    -ComponentRefs $componentRefs `
    -FileIndex ([ref]$fileIndex) `
    -LauncherFound ([ref]$launcherFound)

  if (-not $launcherFound) {
    throw "GUI bundle launcher was not found: $(Join-Path $bundleRoot 'rieul-windows-gui.exe')"
  }

  return @{
    DirectorySource = $lines -join "`r`n"
    ComponentRefs = $componentRefs -join "`r`n"
  }
}

function Test-DotnetSdkAvailable {
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet) {
    return $false
  }
  $sdks = & $dotnet.Source --list-sdks 2>$null
  return $LASTEXITCODE -eq 0 -and $sdks
}

function Invoke-Wix {
  param(
    [string]$RepoRoot,
    [string[]]$Arguments
  )

  $wix = Get-Command wix -ErrorAction SilentlyContinue
  if ($wix) {
    & $wix.Source @Arguments
    return
  }

  if (-not (Test-DotnetSdkAvailable)) {
    throw "WiX CLI was not found. Install WiX on PATH, or install the .NET SDK and run 'dotnet tool restore' so this repo's local wix tool can run."
  }

  Push-Location $RepoRoot
  try {
    & dotnet tool restore
    if ($LASTEXITCODE -ne 0) {
      throw "dotnet tool restore failed with exit code $LASTEXITCODE"
    }
    & dotnet tool run wix -- @Arguments
  } finally {
    Pop-Location
  }
}

function Add-WixExtension {
  param(
    [string]$RepoRoot,
    [string]$Extension
  )

  Invoke-Wix -RepoRoot $RepoRoot -Arguments @(
    "extension",
    "add",
    $Extension
  )
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to add WiX extension $Extension with exit code $LASTEXITCODE"
  }
}

function New-DesktopMsiSource {
  param(
    [string]$Path,
    [string]$Version,
    [string]$Manufacturer,
    [string]$SystemExe,
    [string]$UserExe,
    [string]$GuiBundle,
    [string]$Icon
  )

  $versionText = ConvertTo-XmlEscapedText $Version
  $manufacturerText = ConvertTo-XmlEscapedText $Manufacturer
  $systemExePath = ConvertTo-WixSourcePath $SystemExe
  $userExePath = ConvertTo-WixSourcePath $UserExe
  $iconPath = ConvertTo-WixSourcePath $Icon
  $guiBundleSource = New-GuiBundleWixSource $GuiBundle
  $guiDirectorySource = $guiBundleSource.DirectorySource
  $guiComponentRefs = $guiBundleSource.ComponentRefs

  $source = @"
<Wix
  xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package
    Name="Rieul Desktop"
    Manufacturer="$manufacturerText"
    Version="$versionText"
    UpgradeCode="{B7314DA6-AE47-45BB-BC82-C35F06A44FD8}"
    Scope="perMachine">
    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed." />
    <MediaTemplate EmbedCab="yes" />

    <Icon Id="RieulGuiIcon.ico" SourceFile="$iconPath" />
    <Property Id="ARPPRODUCTICON" Value="RieulGuiIcon.ico" />

    <Launch Condition="Privileged" Message="[ProductName] installs a LocalSystem service and must be installed with administrator privileges." />
    <Property Id="WIXUI_EXITDIALOGOPTIONALTEXT" Value="Rieul Desktop was installed successfully." />
    <Property Id="ARPNOMODIFY" Value="1" />

    <UI Id="RieulInstallUI">
      <TextStyle Id="WixUI_Font_Normal" FaceName="Tahoma" Size="8" />
      <TextStyle Id="WixUI_Font_Bigger" FaceName="Tahoma" Size="12" />
      <TextStyle Id="WixUI_Font_Title" FaceName="Tahoma" Size="9" Bold="yes" />
      <Property Id="DefaultUIFont" Value="WixUI_Font_Normal" />

      <DialogRef Id="ErrorDlg" />
      <DialogRef Id="FatalError" />
      <DialogRef Id="FilesInUse" />
      <DialogRef Id="MsiRMFilesInUse" />
      <DialogRef Id="PrepareDlg" />
      <DialogRef Id="ProgressDlg" />
      <DialogRef Id="ResumeDlg" />
      <DialogRef Id="UserExit" />
      <DialogRef Id="WelcomeDlg" />
      <DialogRef Id="VerifyReadyDlg" />

      <Publish Dialog="ExitDialog" Control="Finish" Event="EndDialog" Value="Return" Order="999" />
      <Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Condition="NOT Installed OR PATCH" />
      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="WelcomeDlg" Condition="NOT Installed OR PATCH" />
    </UI>
    <UIRef Id="WixUI_Common" />

    <CustomAction
      Id="SetRieulUserAgentLaunchTarget"
      Property="WixUnelevatedShellExecTarget"
      Value="[#UserAgentExe]"
      Execute="immediate" />
    <CustomAction
      Id="LaunchRieulUserAgent"
      BinaryRef="Wix4UtilCA_`$(sys.BUILDARCHSHORT)"
      DllEntry="WixUnelevatedShellExec"
      Execute="immediate"
      Return="ignore" />
    <CustomAction
      Id="SetRieulGuiLaunchTarget"
      Property="WixUnelevatedShellExecTarget"
      Value="[#GuiExe]"
      Execute="immediate" />
    <CustomAction
      Id="LaunchRieulGuiApp"
      BinaryRef="Wix4UtilCA_`$(sys.BUILDARCHSHORT)"
      DllEntry="WixUnelevatedShellExec"
      Execute="immediate"
      Return="ignore" />
    <InstallExecuteSequence>
      <Custom Action="SetRieulUserAgentLaunchTarget" After="InstallFinalize" Condition="NOT Installed" />
      <Custom Action="LaunchRieulUserAgent" After="SetRieulUserAgentLaunchTarget" Condition="NOT Installed" />
      <Custom Action="SetRieulGuiLaunchTarget" After="LaunchRieulUserAgent" Condition="NOT Installed" />
      <Custom Action="LaunchRieulGuiApp" After="SetRieulGuiLaunchTarget" Condition="NOT Installed" />
    </InstallExecuteSequence>

    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Rieul">
        <Component Id="SystemDaemonComponent" Guid="{2BCB9D17-4623-4E75-962C-EAC4C82C9D8E}" Bitness="always64">
          <File Id="SystemDaemonExe" Source="$systemExePath" KeyPath="yes" />
          <ServiceInstall
            Id="RieulSystemService"
            Name="rieul-windows-system"
            DisplayName="Rieul System Daemon"
            Description="Runs the Rieul Windows system daemon."
            Type="ownProcess"
            Start="auto"
            ErrorControl="normal"
            Vital="yes"
            Arguments="service run --config &quot;[CommonAppDataFolder]Rieul\rieul.yaml&quot;" />
          <ServiceControl
            Id="RieulSystemServiceControl"
            Name="rieul-windows-system"
            Start="install"
            Stop="both"
            Remove="uninstall"
            Wait="yes" />
        </Component>

        <Component Id="UserAgentComponent" Guid="{6F43D08E-426E-4F73-A947-06987D99CDA3}" Bitness="always64">
          <File Id="UserAgentExe" Source="$userExePath" KeyPath="yes" />
          <RegistryValue
            Root="HKLM"
            Key="Software\Microsoft\Windows\CurrentVersion\Run"
            Name="Rieul User"
            Type="string"
            Value="&quot;[INSTALLFOLDER]rieul-windows-user.exe&quot;" />
        </Component>

$guiDirectorySource
      </Directory>
    </StandardDirectory>

    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="ProgramMenuAppFolder" Name="Rieul">
        <Component Id="StartMenuShortcutComponent" Guid="{60994307-B63F-4488-BD16-20196C11EED1}" Bitness="always64">
          <Shortcut
            Id="StartMenuShortcut"
            Name="Rieul Desktop"
            Target="[#GuiExe]"
            WorkingDirectory="GuiBundleFolder"
            Icon="RieulGuiIcon.ico" />
          <RemoveFolder Id="RemoveProgramMenuAppFolder" On="uninstall" />
          <RegistryValue
            Root="HKLM"
            Key="Software\Rieul\Daemon"
            Name="StartMenuShortcut"
            Type="integer"
            Value="1"
            KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>

    <Feature Id="MainFeature" Title="Rieul Desktop" Level="1">
      <ComponentRef Id="SystemDaemonComponent" />
      <ComponentRef Id="UserAgentComponent" />
$guiComponentRefs
      <ComponentRef Id="StartMenuShortcutComponent" />
    </Feature>
  </Package>
</Wix>
"@

  Set-Content -LiteralPath $Path -Value $source -Encoding UTF8
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Version) {
  $Version = Get-CargoPackageVersion (Join-Path $RepoRoot "daemon\windows\Cargo.toml")
}
$PackageVersion = $Version
$MsiVersion = ConvertTo-MsiVersion $PackageVersion
if (-not $OutDir) {
  $OutDir = Join-Path $RepoRoot "dist\windows"
}

$PackageBaseName = "rieul-windows-desktop-$PackageVersion"
$StagingDir = Join-Path $OutDir "$PackageBaseName-msi"
$MsiSourcePath = Join-Path $StagingDir "Package.wxs"
$MsiPath = Join-Path $OutDir "$PackageBaseName.msi"
$ReleaseDir = Join-Path $RepoRoot "target\release"
$SystemExe = Join-Path $ReleaseDir "rieul-windows-system.exe"
$UserExe = Join-Path $ReleaseDir "rieul-windows-user.exe"
$GuiBundle = Join-Path $ReleaseDir "rieul-windows-gui"
$Icon = Join-Path $RepoRoot "web\desktop\icon.ico"

if (-not $SkipBuild) {
  Push-Location $RepoRoot
  try {
    cargo build -p rieul-windows-daemon --release --bin rieul-windows-system --bin rieul-windows-user
    Push-Location (Join-Path $RepoRoot "web")
    try {
      deno task desktop:build:windows
    } finally {
      Pop-Location
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $SystemExe)) {
  throw "Missing release binary: $SystemExe"
}
if (-not (Test-Path -LiteralPath $UserExe)) {
  throw "Missing release binary: $UserExe"
}
Assert-GuiBundle $GuiBundle
if (-not (Test-Path -LiteralPath $Icon)) {
  throw "Missing app icon: $Icon"
}

if (Test-Path -LiteralPath $StagingDir) {
  Remove-Item -LiteralPath $StagingDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

New-DesktopMsiSource `
  -Path $MsiSourcePath `
  -Version $MsiVersion `
  -Manufacturer $Manufacturer `
  -SystemExe $SystemExe `
  -UserExe $UserExe `
  -GuiBundle $GuiBundle `
  -Icon $Icon

if (Test-Path -LiteralPath $MsiPath) {
  Remove-Item -LiteralPath $MsiPath -Force
}

Add-WixExtension -RepoRoot $RepoRoot -Extension "WixToolset.UI.wixext/7.0.0"
Add-WixExtension -RepoRoot $RepoRoot -Extension "WixToolset.Util.wixext/7.0.0"

Invoke-Wix -RepoRoot $RepoRoot -Arguments @(
  "build",
  "-ext",
  "WixToolset.UI.wixext",
  "-ext",
  "WixToolset.Util.wixext",
  $MsiSourcePath,
  "-arch",
  "x64",
  "-o",
  $MsiPath
)
if ($LASTEXITCODE -ne 0) {
  throw "WiX failed with exit code $LASTEXITCODE"
}

Write-Host "Wrote MSI: $MsiPath"
Write-Host "Staging directory: $StagingDir"
