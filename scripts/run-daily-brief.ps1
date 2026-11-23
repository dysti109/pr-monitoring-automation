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
function Log([string]$message) { Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" }
function NotifyFailure([string]$message, [int]$attempt, [switch]$final) {
  try {
    $noticeArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'send-automation-notice.ps1'),'-Stage','최종 PR 분석 및 테스트 메일','-Message',$message,'-Attempt',"$attempt",'-MaxAttempts','3')
    if ($final) { $noticeArgs += '-Final' }
    & powershell.exe @noticeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "알림 스크립트 종료 코드: $LASTEXITCODE" }
    Log "FAILURE_NOTICE_SENT attempt=$attempt final=$final"
  } catch { Log "FAILURE_NOTICE_FAILED error=$($_.Exception.Message)" }
}

$serverStarted = $false
$lastAttempt = 1
try {
  Log 'START'
  $kstNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Korea Standard Time')
  $reportEndDate = $kstNow.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  $daysBack = if ($kstNow.DayOfWeek -eq [DayOfWeek]::Monday) { 3 } else { 1 }
  $reportStartDate = $kstNow.AddDays(-$daysBack).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  $reportWindow = "start=$reportStartDate&startTime=10%3A00&end=$reportEndDate&endTime=10%3A00"
  $periodKey = "$reportStartDate 10:00~$reportEndDate 10:00"
  $sentDir = Join-Path $projectDir 'reports/daily-sent'
  $sentMarker = Join-Path $sentDir ("$reportStartDate-$reportEndDate.json")
  $analysisUrl = "http://127.0.0.1:1430/api/competitor-brief?$reportWindow&async=1"
  Log "REPORT_WINDOW=${reportStartDate} 10:00~${reportEndDate} 10:00 KST"
  try { Invoke-WebRequest -Uri 'http://127.0.0.1:1430/api/competitor-brief' -UseBasicParsing -TimeoutSec 3 | Out-Null }
  catch {
    $npm = 'C:\Program Files\nodejs\npm.cmd'
    Start-Process -FilePath $npm -ArgumentList 'run','dev','--','--host','127.0.0.1' -WorkingDirectory $projectDir -WindowStyle Hidden
    $serverStarted = $true
    $serverReady = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 1
      try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:1430/' -UseBasicParsing -TimeoutSec 2 | Out-Null
        $serverReady = $true
        break
      } catch {}
    }
    if (-not $serverReady) { throw '분석 서버가 60초 안에 시작되지 않았습니다.' }
  }

  if (Test-Path -LiteralPath $sentMarker) {
    Log "SKIP_ALREADY_SENT period=$periodKey"
    return
  }

  $analysisComplete = $false
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $lastAttempt = $attempt
    try {
      $active = Invoke-RestMethod -Uri 'http://127.0.0.1:1430/api/competitor-brief?active=1' -TimeoutSec 10
      if ($active.status -eq 'running' -and $active.period -eq $periodKey) {
        $job = $active
        Log "ADOPT_ACTIVE_JOB JOB=$($active.jobId) PERIOD=$periodKey"
      } else {
        $attemptUrl = if ($attempt -ge 2) { "$analysisUrl&resume=1" } else { $analysisUrl }
        Log "ANALYSIS_ATTEMPT=$attempt ASYNC=1 RESUME=$($attempt -ge 2)"
        try {
          $job = Invoke-RestMethod -Uri $attemptUrl -Method Post -TimeoutSec 30
        } catch {
          $racedActive = Invoke-RestMethod -Uri 'http://127.0.0.1:1430/api/competitor-brief?active=1' -TimeoutSec 10
          if ($racedActive.status -eq 'running' -and $racedActive.period -eq $periodKey) {
            $job = $racedActive
            Log "ADOPT_RACED_ACTIVE_JOB JOB=$($racedActive.jobId) PERIOD=$periodKey"
          } else { throw }
        }
      }
      $jobId = [string]$job.jobId
      if (-not $jobId) { throw '분석 작업 ID를 받지 못했습니다.' }
      $deadline = [DateTimeOffset]::UtcNow.AddMinutes(60)
      $lastProgressKey = ''
      while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 5
        $job = Invoke-RestMethod -Uri "http://127.0.0.1:1430/api/competitor-brief?jobId=$([uri]::EscapeDataString($jobId))" -TimeoutSec 15
        $progressKey = "$($job.progress.phase)|$($job.progress.completedTargets)|$($job.progress.totalTargets)|$(@($job.progress.activeCompanies) -join ',')"
        if ($progressKey -ne $lastProgressKey) {
          Log "ANALYSIS_PROGRESS JOB=$jobId PHASE=$($job.progress.phase) COMPLETED=$($job.progress.completedTargets)/$($job.progress.totalTargets) ACTIVE=$(@($job.progress.activeCompanies) -join ',')"
          $lastProgressKey = $progressKey
        }
        if ($job.status -eq 'completed') {
          $analysisComplete = $true
          break
        }
        if ($job.status -eq 'failed') { throw "분석 실패: $($job.error)" }
      }
      if ($analysisComplete) { break }
      throw '분석 작업이 60분 안에 완료되지 않았습니다.'
    } catch {
      Log "ANALYSIS_FAILED_ATTEMPT=$attempt ERROR=$($_.Exception.Message)"
      if ($attempt -eq 1) { NotifyFailure $_.Exception.Message $attempt }
      $statusCode = 0
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
      if ($statusCode -eq 409 -and $attempt -lt $maxAttempts) {
        Log "ANALYSIS_WAITING_FOR_ACTIVE_PR_TASK ATTEMPT=$attempt"
        Start-Sleep -Seconds 15
        continue
      }
      if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds ([Math]::Pow(2, $attempt) * 5) } else { break }
    }
  }
  if (-not $analysisComplete) { throw '사전 수집 대기 후에도 기사 분석이 완료되지 않았습니다.' }

  $previousRecipientOverride = $env:PAPR_RECIPIENT_OVERRIDE
  $previousPrimaryOnly = $env:PAPR_PR_ONLY
  try {
    $env:PAPR_RECIPIENT_OVERRIDE = $testRecipient
    $env:PAPR_PR_ONLY = ''
    & (Join-Path $PSScriptRoot 'send-brief-email.ps1') -Test
    New-Item -ItemType Directory -Path $sentDir -Force | Out-Null
    Set-Content -LiteralPath $sentMarker -Encoding utf8 -Value (ConvertTo-Json @{ period = $periodKey; sentAt = [DateTimeOffset]::UtcNow.ToString('o'); recipient = $testRecipient; test = $true } -Compress)
    Log "TEST_SENT_SUCCESS period=$periodKey recipient=$testRecipient teamSend=NOT_SENT"
  } finally {
    $env:PAPR_RECIPIENT_OVERRIDE = $previousRecipientOverride
    $env:PAPR_PR_ONLY = $previousPrimaryOnly
  }
} catch {
  Log "FAILED ERROR=$($_.Exception.Message)"
  NotifyFailure $_.Exception.Message $lastAttempt -final
  throw
} finally {
  if ($serverStarted) {
    Get-NetTCPConnection -LocalPort 1430 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  }
}
