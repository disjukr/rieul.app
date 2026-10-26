$ErrorActionPreference = 'Stop'
$ViteScript = 'C:\fixture\rieul\web\node_modules\vite\bin\vite.js'
$executable = 'C:\fixture\rieul\target\release\rieul-windows-gui\rieul-windows-gui.exe'
$config = 'C:\fixture\rieul\tmp\dev\rieul.yaml'
foreach ($entry in @(
  @('dev-desktop.ps1','Test-DevDaemonProcess'),
  @('kill-desktop.ps1','Test-DevDaemonProcess')
)) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $entry[0]),[ref]$tokens,[ref]$errors)
  if ($errors) { throw "Parse error: $($entry[0])" }
  $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $entry[1]},$true)
  if (-not $definition) { throw 'Missing process scope predicate' }
  # Load just the pure predicate, never the script's start/stop operations.
  . ([scriptblock]::Create($definition.Extent.Text))
  foreach ($case in @(
    @($executable, "`"$executable`" --config `"$config`"", $true),
    @($executable, "`"$executable`" --config C:\other-profile.yaml", $false),
    @($executable, "`"$executable`" --config `"$config.other`"", $false),
    @('C:\other-task\rieul-windows-gui.exe', "GUI --config $config", $false),
    @($executable, '', $false)
  )) {
    $fixture=New-CimInstance -ClassName Win32_Process -ClientOnly -Property @{ExecutablePath=$case[0];CommandLine=$case[1]}
    $actual=Test-DevDaemonProcess -Process $fixture -ExecutablePath $executable -RequiredCommandLinePart $config
    if ($actual -ne $case[2]) { throw "Process ownership boundary failed: $($entry[0])" }
  }
}
Write-Host 'Dev process predicates preserve other profiles/tasks; no process was started or stopped'
