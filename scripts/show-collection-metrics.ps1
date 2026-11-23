param([ValidateRange(1, 100)][int]$Count = 20)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$metricsPath = Join-Path $projectDir 'reports\collection-metrics.json'
if (-not (Test-Path -LiteralPath $metricsPath)) { throw '수집 측정 기록이 아직 없습니다.' }
$metrics = @(Get-Content -LiteralPath $metricsPath -Raw -Encoding utf8 | ConvertFrom-Json | Select-Object -Last $Count)
foreach ($m in $metrics) {
  $review = $m.reviewSummary
  $precision = if ($null -ne $review.precision) { '{0:P1}' -f [double]$review.precision } else { '표본 부족' }
  $omission = if ($null -ne $review.omissionRateLowerBound) { '{0:P1}' -f [double]$review.omissionRateLowerBound } else { '제보 없음' }
  [pscustomobject]@{
    Period = $m.period
    Minutes = [Math]::Round([double]$m.durationSeconds / 60, 1)
    TargetCoverage = "$($m.targetsSearched)/$($m.targetsPlanned)"
    GoogleCandidates = $m.googleNews.candidateCount
    RSSCacheHits = $m.googleNews.cacheHitTargets
    TimestampCheck = if ($null -ne $m.timestampValidation.verifiedRate) { '{0:P1}' -f [double]$m.timestampValidation.verifiedRate } else { '자료 없음' }
    Issues = $m.result.issues
    Contents = $m.result.contents
    NaverLimitedTargets = $m.naver.targetsWithAccessLimit
    PrecisionSample = $precision
    OmissionRateLowerBound = $omission
    FalsePositives = $review.falsePositives
    Duplicates = $review.duplicates
  }
}
