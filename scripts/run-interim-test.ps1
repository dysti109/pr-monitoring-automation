param([string]$StartDate, [string]$StartTime = '10:00', [string]$EndDate, [string]$FinalEndTime = '10:00')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$emailSettingsPath = Join-Path $projectDir 'config\email-settings.local.json'
$emailSettings = Get-Content -LiteralPath $emailSettingsPath -Raw -Encoding utf8 | ConvertFrom-Json
$testRecipient = [string]$emailSettings.testRecipient
if (-not $testRecipient) { $testRecipient = [string](@($emailSettings.recipients) | Select-Object -First 1) }
if (-not $testRecipient) { throw '테스트 수신 주소를 로컬 메일 설정에 입력하세요.' }
$logDir = Join-Path $projectDir 'logs'
$logPath = Join-Path $logDir 'daily-brief.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Log([string]$message) { Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') INTERIM $message" }

$serverStarted = $false
try {
  $kstNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Korea Standard Time')
  $todayDate = $kstNow.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  if (-not $EndDate) { $EndDate = $todayDate }
  if (-not $StartDate) {
    $daysBack = if ($kstNow.DayOfWeek -eq [DayOfWeek]::Monday) { 3 } else { 1 }
    $StartDate = $kstNow.AddDays(-$daysBack).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  }
  $finalCutoff = [TimeSpan]::Parse($FinalEndTime, [Globalization.CultureInfo]::InvariantCulture)
  if ($EndDate -lt $todayDate -or ($EndDate -eq $todayDate -and $kstNow.TimeOfDay -ge $finalCutoff)) { throw "중간 테스트는 지정한 마감($EndDate $FinalEndTime) 전에만 실행할 수 있습니다." }
  $endTime = $kstNow.ToString('HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  $period = "$StartDate $StartTime~$EndDate $endTime (최종 마감 $FinalEndTime)"
  Log "START period=$period"

  try { Invoke-WebRequest -Uri 'http://127.0.0.1:1430/' -UseBasicParsing -TimeoutSec 3 | Out-Null }
  catch {
    $npm = 'C:\Program Files\nodejs\npm.cmd'
    Start-Process -FilePath $npm -ArgumentList 'run','dev','--','--host','127.0.0.1' -WorkingDirectory $projectDir -WindowStyle Hidden
    $serverStarted = $true
    $serverReady = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 1
      try { Invoke-WebRequest -Uri 'http://127.0.0.1:1430/' -UseBasicParsing -TimeoutSec 2 | Out-Null; $serverReady = $true; break } catch {}
    }
    if (-not $serverReady) { throw '분석 서버가 60초 안에 시작되지 않았습니다.' }
  }

  $query = "start=$StartDate&startTime=$($StartTime.Replace(':','%3A'))&end=$EndDate&endTime=$($endTime.Replace(':','%3A'))&interimWindowEndTime=$($FinalEndTime.Replace(':','%3A'))&async=1&interim=1"
  $job = Invoke-RestMethod -Uri "http://127.0.0.1:1430/api/competitor-brief?$query" -Method Post -TimeoutSec 30
  $jobId = [string]$job.jobId
  if (-not $jobId) { throw '중간 분석 작업 ID를 받지 못했습니다.' }
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(60)
  $lastProgressKey = ''
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 5
    $job = Invoke-RestMethod -Uri "http://127.0.0.1:1430/api/competitor-brief?jobId=$([uri]::EscapeDataString($jobId))" -TimeoutSec 15
    $progressKey = "$($job.progress.phase)|$($job.progress.completedTargets)|$($job.progress.totalTargets)|$(@($job.progress.activeCompanies) -join ',')"
    if ($progressKey -ne $lastProgressKey) {
      Log "PROGRESS JOB=$jobId PHASE=$($job.progress.phase) COMPLETED=$($job.progress.completedTargets)/$($job.progress.totalTargets) ACTIVE=$(@($job.progress.activeCompanies) -join ',')"
      $lastProgressKey = $progressKey
    }
    if ($job.status -eq 'completed') { break }
    if ($job.status -eq 'failed') { throw "중간 분석 실패: $($job.error)" }
  }
  if ($job.status -ne 'completed' -or -not $job.report) { throw '중간 분석이 60분 안에 완료되지 않았습니다.' }

  $interimReportPath = Join-Path $projectDir 'reports/interim-latest.json'
  Set-Content -LiteralPath $interimReportPath -Encoding utf8 -Value (ConvertTo-Json -InputObject $job.report -Depth 100)
  $previousRecipientOverride = $env:PAPR_RECIPIENT_OVERRIDE
  $previousPrimaryOnly = $env:PAPR_PR_ONLY
  try {
    $env:PAPR_RECIPIENT_OVERRIDE = $testRecipient
    $env:PAPR_PR_ONLY = ''
    & (Join-Path $PSScriptRoot 'send-brief-email.ps1') -Test -ReportPath $interimReportPath
    Log "TEST_SENT_SUCCESS period=$period recipient=$testRecipient interim=True finalWillReuse=True"
  } finally {
    $env:PAPR_RECIPIENT_OVERRIDE = $previousRecipientOverride
    $env:PAPR_PR_ONLY = $previousPrimaryOnly
  }
} catch {
  Log "FAILED ERROR=$($_.Exception.Message)"
  throw
} finally {
  if ($serverStarted) {
    Get-NetTCPConnection -LocalPort 1430 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  }
}
