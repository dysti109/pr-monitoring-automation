$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
if (-not $projectDir) { throw 'Papr project folder was not found.' }
$npm = 'C:\Program Files\nodejs\npm.cmd'
$command = "Set-Location -LiteralPath '$projectDir'; & '$npm' run dev -- --host 127.0.0.1"
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',$command
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:1430/history.html' | Out-Null
    Start-Process 'http://127.0.0.1:1430/history.html'
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
}
Start-Process 'http://127.0.0.1:1430/history.html'
