param(
  [Parameter(Mandatory = $true)][string]$Period,
  [Parameter(Mandatory = $true)][ValidateSet('omission', 'false-positive', 'duplicate', 'confirmed-valid')][string]$Outcome,
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Note = ''
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$metricsPath = Join-Path $projectDir 'reports\collection-metrics.json'
if (-not (Test-Path -LiteralPath $metricsPath)) {
  throw '수집 측정 기록이 없습니다. 다음 분석 완료 후 다시 기록하세요.'
}

$metrics = @(Get-Content -LiteralPath $metricsPath -Raw -Encoding utf8 | ConvertFrom-Json)
$metric = $metrics | Where-Object { $_.period -eq $Period } | Select-Object -Last 1
if (-not $metric) { throw "해당 기간의 기록을 찾을 수 없습니다: $Period" }

if (-not $metric.reviewEvents) {
  $metric | Add-Member -NotePropertyName reviewEvents -NotePropertyValue @() -Force
}
$normalizedUrl = $Url.Trim()
$duplicate = @($metric.reviewEvents | Where-Object { $_.outcome -eq $Outcome -and $_.url -eq $normalizedUrl }).Count -gt 0
if ($duplicate) { throw '같은 기간·유형·URL의 검토 기록이 이미 있습니다.' }

$event = [pscustomobject]@{
  outcome = $Outcome
  url = $normalizedUrl
  note = $Note.Trim()
  recordedAt = [DateTimeOffset]::Now.ToString('o')
}
$metric.reviewEvents = @($metric.reviewEvents) + $event
$events = @($metric.reviewEvents)
$valid = @($events | Where-Object outcome -eq 'confirmed-valid').Count
$falsePositive = @($events | Where-Object outcome -eq 'false-positive').Count
$omissions = @($events | Where-Object outcome -eq 'omission').Count
$duplicates = @($events | Where-Object outcome -eq 'duplicate').Count
$includedEligible = [Math]::Max(0, [int]$metric.result.contents - $falsePositive)
$reviewedIncluded = $valid + $falsePositive
$metric.reviewSummary = [pscustomobject]@{
  omissions = $omissions
  falsePositives = $falsePositive
  duplicates = $duplicates
  precision = if ($reviewedIncluded) { [Math]::Round($valid / $reviewedIncluded, 4) } else { $null }
  omissionRateLowerBound = if ($includedEligible + $omissions) { [Math]::Round($omissions / ($includedEligible + $omissions), 4) } else { $null }
  note = '사용자가 제보하거나 표본 검수로 확인한 항목 기준. 전체 기사 누락률의 완전한 측정치는 아님.'
}

$temporaryPath = "$metricsPath.tmp"
$metrics | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
Move-Item -LiteralPath $temporaryPath -Destination $metricsPath -Force
Write-Output "Recorded=$Outcome Period=$Period"
