$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error "Install Node.js 24 LTS and reopen PowerShell to run the development app."
  exit 1
}
$nodeVersion = [version]((& $nodeCommand.Source --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0') {
  Write-Error "This development build needs Node.js 22.12 or newer. Node.js 24 LTS is recommended."
  exit 1
}
Push-Location $appDir
try {
  & npm.cmd start
} finally {
  Pop-Location
}
