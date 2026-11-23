$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $projectDir 'logs\same-day-continuation.log'
$precollector = Join-Path $PSScriptRoot 'precollect-daily-brief.ps1'
$finalRunner = Join-Path $PSScriptRoot 'run-daily-brief.ps1'
function Log([string]$message) { Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" }
function WaitUntilKst([string]$time) {
  while ($true) {
    $now = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Korea Standard Time')
    $parts = $time.Split(':')
    $target = $now.Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
    $seconds = ($target - $now.DateTime).TotalSeconds
    if ($seconds -le 0) { return }
    Start-Sleep -Seconds ([Math]::Min(15, [Math]::Max(1, [Math]::Ceiling($seconds))))
  }
}
function RunScript([string]$label, [string]$file, [string[]]$args) {
  Log "START $label"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file @args
  if ($LASTEXITCODE -ne 0) { Log "FAILED $label exit=$LASTEXITCODE"; throw "$label failed with exit code $LASTEXITCODE" }
  Log "SUCCESS $label"
}
try {
  Log 'ORCHESTRATOR_STARTED continuation=pass2-09:25,pass3-09:50,final-10:01 KST'
  WaitUntilKst '09:25'
  RunScript 'PRECOLLECT_PASS_2' $precollector @('-SearchPass','2')
  WaitUntilKst '09:50'
  RunScript 'PRECOLLECT_PASS_3' $precollector @('-SearchPass','3')
  WaitUntilKst '10:01'
  RunScript 'FINAL_ANALYSIS_AND_TEST_EMAIL' $finalRunner @()
} catch {
  Log "ORCHESTRATOR_FAILED error=$($_.Exception.Message)"
  exit 1
}
