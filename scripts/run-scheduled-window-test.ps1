param(
  [Parameter(Mandatory = $true)][string]$StartDate,
  [Parameter(Mandatory = $true)][string]$StartTime,
  [Parameter(Mandatory = $true)][string]$EndDate,
  [Parameter(Mandatory = $true)][string]$EndTime
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$emailSettingsPath = Join-Path $projectDir 'config\email-settings.local.json'
$emailSettings = Get-Content -LiteralPath $emailSettingsPath -Raw -Encoding utf8 | ConvertFrom-Json
$testRecipient = [string]$emailSettings.testRecipient
if (-not $testRecipient) { $testRecipient = [string](@($emailSettings.recipients) | Select-Object -First 1) }
if (-not $testRecipient) { throw '테스트 수신 주소를 로컬 메일 설정에 입력하세요.' }
$logDir = Join-Path $projectDir 'logs'
$logPath = Join-Path $logDir 'scheduled-window-test.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Log([string]$message) { Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" }

$serverStarted = $false
try {
  $period = "$StartDate $StartTime~$EndDate $EndTime"
  Log "START period=$period recipient=$testRecipient testOnly=True"
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

  $query = "start=$StartDate&startTime=$($StartTime.Replace(':','%3A'))&end=$EndDate&endTime=$($EndTime.Replace(':','%3A'))&async=1&refresh=1"
  $job = $null
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Log "ANALYSIS_START attempt=$attempt window=$period"
      $job = Invoke-RestMethod -Uri "http://127.0.0.1:1430/api/competitor-brief?$query" -Method Post -TimeoutSec 60
      break
    } catch {
      Log "ANALYSIS_START_FAILED attempt=$attempt error=$($_.Exception.Message)"
      if ($attempt -eq 2) { throw }
      Start-Sleep -Seconds 10
    }
  }

  $jobId = [string]$job.jobId
  if (-not $jobId) { throw '분석 작업 ID를 받지 못했습니다.' }
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(90)
  $lastProgressKey = ''
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 5
    $job = Invoke-RestMethod -Uri "http://127.0.0.1:1430/api/competitor-brief?jobId=$([uri]::EscapeDataString($jobId))" -TimeoutSec 20
    $progressKey = "$($job.progress.phase)|$($job.progress.completedTargets)|$($job.progress.totalTargets)|$(@($job.progress.activeCompanies) -join ',')"
    if ($progressKey -ne $lastProgressKey) {
      Log "PROGRESS job=$jobId phase=$($job.progress.phase) completed=$($job.progress.completedTargets)/$($job.progress.totalTargets) active=$(@($job.progress.activeCompanies) -join ',')"
      $lastProgressKey = $progressKey
    }
    if ($job.status -eq 'completed') { break }
    if ($job.status -eq 'failed') { throw "분석 실패: $($job.error)" }
  }
  if ($job.status -ne 'completed' -or -not $job.report) { throw '분석이 90분 안에 완료되지 않았거나 보고서가 비어 있습니다.' }

  $reportPath = Join-Path $projectDir "reports\scheduled-test-$($StartDate -replace '-', '')-$($StartTime -replace ':', '')-$($EndDate -replace '-', '')-$($EndTime -replace ':', '').json"
  Set-Content -LiteralPath $reportPath -Encoding utf8 -Value (ConvertTo-Json -InputObject $job.report -Depth 100)
  $previousRecipientOverride = $env:PAPR_RECIPIENT_OVERRIDE
  $previousPrimaryOnly = $env:PAPR_PR_ONLY
  try {
    $env:PAPR_RECIPIENT_OVERRIDE = $testRecipient
    $env:PAPR_PR_ONLY = ''
    & (Join-Path $PSScriptRoot 'send-brief-email.ps1') -Test -ReportPath $reportPath
    Log "TEST_SENT_SUCCESS period=$period recipient=$testRecipient articles=$(@($job.report.articles).Count)"
  } finally {
    $env:PAPR_RECIPIENT_OVERRIDE = $previousRecipientOverride
    $env:PAPR_PR_ONLY = $previousPrimaryOnly
  }
} catch {
  Log "FAILED error=$($_.Exception.Message)"
  throw
} finally {
  if ($serverStarted) {
    Get-NetTCPConnection -LocalPort 1430 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  }
}
