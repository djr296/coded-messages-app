$nodeDir = "$env:LOCALAPPDATA\Programs\nodejs-portable\node-v20.20.1-win-x64"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$nodeDir\node.exe")) {
  Write-Error "Node.js not found at $nodeDir"
  exit 1
}

$env:Path = "$nodeDir;$env:Path"
Push-Location $appDir
try {
  & "$nodeDir\npm.cmd" start
} finally {
  Pop-Location
}
