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
try {
  Log 'CONTINUATION_STARTED pass3=09:50 final=10:01 KST'
  WaitUntilKst '09:50'
  Log 'START PRECOLLECT_PASS_3'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $precollector -SearchPass 3
  if ($LASTEXITCODE -ne 0) { throw "PRECOLLECT_PASS_3 exit=$LASTEXITCODE" }
  Log 'SUCCESS PRECOLLECT_PASS_3'
  WaitUntilKst '10:01'
  Log 'START FINAL_ANALYSIS_AND_TEST_EMAIL'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $finalRunner
  if ($LASTEXITCODE -ne 0) { throw "FINAL_ANALYSIS_AND_TEST_EMAIL exit=$LASTEXITCODE" }
  Log 'SUCCESS FINAL_ANALYSIS_AND_TEST_EMAIL'
} catch {
  Log "CONTINUATION_FAILED error=$($_.Exception.Message)"
  exit 1
}
