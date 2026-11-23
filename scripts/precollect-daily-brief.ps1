param([string]$StartDate, [string]$StartTime = '10:00', [string]$EndDate, [string]$EndTime = '10:00', [ValidateRange(1,3)][int]$SearchPass = 1)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectDir 'logs'
$logPath = Join-Path $logDir 'daily-brief.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Log([string]$message) { Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') PRECOLLECT $message" }
function NotifyFailure([string]$message, [int]$attempt, [switch]$final) {
  try {
    $noticeArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'send-automation-notice.ps1'),'-Stage',"사전 수집 1차/2차/3차 (pass $SearchPass)",'-Message',$message,'-Attempt',"$attempt",'-MaxAttempts','3')
    if ($final) { $noticeArgs += '-Final' }
    & powershell.exe @noticeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "알림 스크립트 종료 코드: $LASTEXITCODE" }
    Log "FAILURE_NOTICE_SENT attempt=$attempt final=$final"
  } catch { Log "FAILURE_NOTICE_FAILED error=$($_.Exception.Message)" }
}

$serverStarted = $false
$finalNoticeSent = $false
$conflictWaits = 0
try {
  $kstNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Korea Standard Time')
  $todayDate = $kstNow.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  if (-not $EndDate) { $EndDate = $todayDate }
  if (-not $StartDate) {
    $daysBack = if ($kstNow.DayOfWeek -eq [DayOfWeek]::Monday) { 3 } else { 1 }
    $StartDate = $kstNow.AddDays(-$daysBack).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  }
  $period = "$StartDate $StartTime~$EndDate $EndTime"
  Log "START pass=$SearchPass period=$period"
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
  $query = "start=$StartDate&startTime=$($StartTime.Replace(':','%3A'))&end=$EndDate&endTime=$($EndTime.Replace(':','%3A'))&precollect=1&pass=$SearchPass"
  $result = $null
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      $result = Invoke-RestMethod -Uri "http://127.0.0.1:1430/api/competitor-brief?$query" -Method Post -TimeoutSec 90
      break
    } catch {
      $statusCode = 0
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
      if ($statusCode -eq 409) {
        $conflictWaits++
        if ($conflictWaits -ge 45) { throw '기존 PR 작업과의 충돌 대기가 45회를 넘었습니다.' }
        Log "WAITING_FOR_ACTIVE_PR_TASK pass=$SearchPass attempt=$attempt"
        Start-Sleep -Seconds 10
        $attempt--
        continue
      }
      Log "RETRYABLE_FAILURE pass=$SearchPass attempt=$attempt/$maxAttempts error=$($_.Exception.Message)"
      if ($attempt -eq 1) { NotifyFailure $_.Exception.Message $attempt }
      if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds ([Math]::Pow(2, $attempt) * 5); continue }
      NotifyFailure $_.Exception.Message $attempt -final
      $finalNoticeSent = $true
      throw
    }
  }
  if (-not $result) { throw '사전 수집 결과를 받지 못했습니다.' }
  Log "SUCCESS pass=$SearchPass period=$period capturedAt=$($result.capturedAt) passes=$((ConvertTo-Json $result.searchPasses -Compress)) counts=$((ConvertTo-Json $result.candidateCounts -Compress)) new=$((ConvertTo-Json $result.newCandidateCounts -Compress)) blog=$($result.blogCandidates)"
} catch {
  Log "FAILED error=$($_.Exception.Message)"
  if (-not $finalNoticeSent) {
    $noticeAttempt = if ($null -ne $attempt -and $attempt -ge 1) { [Math]::Min($attempt, 3) } else { 1 }
    NotifyFailure $_.Exception.Message $noticeAttempt -final
  }
  throw
} finally {
  if ($serverStarted) {
    Get-NetTCPConnection -LocalPort 1430 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  }
}
