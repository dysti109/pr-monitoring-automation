param([switch]$Test, [string]$ReportPath)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$monitoringConfigPath = Join-Path $projectDir 'config\pr-monitoring.local.json'
if (!(Test-Path -LiteralPath $monitoringConfigPath)) { $monitoringConfigPath = Join-Path $projectDir 'config\pr-monitoring.example.json' }
if (!(Test-Path -LiteralPath $monitoringConfigPath)) { throw '모니터링 설정 파일이 없습니다.' }
$monitoringConfig = Get-Content -LiteralPath $monitoringConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
$primaryCompanyConfig = $monitoringConfig.primaryCompany
$primaryCompanyName = [string]$primaryCompanyConfig.name
if (-not $primaryCompanyName) { $primaryCompanyName = '주 대상' }
$primaryAliases = @(@($primaryCompanyConfig.name) + @($primaryCompanyConfig.aliases) + @($primaryCompanyConfig.brands) | ForEach-Object { [string]$_ } | Where-Object { $_ })
$officialBlogUrlPatterns = @($primaryCompanyConfig.officialBlogUrlPatterns | ForEach-Object { [string]$_ } | Where-Object { $_ })
$settingsPath = Join-Path $projectDir 'config\email-settings.local.json'
$passwordPath = Join-Path $projectDir 'config\gmail-app-password.local.txt'
$reportPath = if ($ReportPath) { $ReportPath } else { Join-Path $projectDir 'reports\latest.json' }
if ($ReportPath -and -not [System.IO.Path]::IsPathRooted($reportPath)) { $reportPath = Join-Path $projectDir $reportPath }
if (!(Test-Path -LiteralPath $settingsPath) -or !(Test-Path -LiteralPath $passwordPath)) { throw '먼저 scripts\configure-email.ps1을 실행하세요.' }
if (!(Test-Path -LiteralPath $reportPath)) { throw '발송할 분석 보고서가 없습니다.' }

$settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding utf8 | ConvertFrom-Json
$recipients = if ($env:PAPR_RECIPIENT_OVERRIDE) {
  @($env:PAPR_RECIPIENT_OVERRIDE -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
} elseif ($Test) {
  $testRecipient = [string]$settings.testRecipient
  if (-not $testRecipient) { $testRecipient = [string](@($settings.recipients) | Select-Object -First 1) }
  if (-not $testRecipient) { throw '테스트 수신 주소를 로컬 메일 설정에 입력하세요.' }
  @($testRecipient)
} elseif ($settings.PSObject.Properties.Name -contains 'recipients') {
  @($settings.recipients)
} else {
  @($settings.recipient)
}
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($report.PSObject.Properties.Name -contains 'coverage' -and @($report.coverage | Where-Object { -not $_.searched }).Count -gt 0 -and @($report.articles).Count -eq 0) {
  throw '분석 실패로 기사가 0건인 보고서는 발송하지 않습니다.'
}
$encryptedPassword = (Get-Content -LiteralPath $passwordPath -Raw).Trim()
$securePassword = $encryptedPassword | ConvertTo-SecureString
$credential = [pscredential]::new($settings.sender, $securePassword)

function Html([string]$value) { [System.Net.WebUtility]::HtmlEncode($value) }
function FormatKstDate([string]$value) {
  $raw = ([string]$value).Trim()
  if (-not $raw) { return '발행 시각 확인 불가' }
  $hasSeoulSuffix = $raw -match '(?i)(?:\s|\[)(?:Asia/Seoul|KST)\]?\s*$'
  $raw = $raw -replace '(?i)(?:\s|\[)(?:Asia/Seoul|KST)\]?\s*$', ''
  $raw = $raw -replace '(?i)\s+(UTC|GMT)$', 'Z'
  $zone = [TimeZoneInfo]::FindSystemTimeZoneById('Korea Standard Time')
  $parsedOffset = [DateTimeOffset]::MinValue
  $hasExplicitZone = $raw -match '(?i)(Z|[+-]\d{2}:?\d{2})$'
  if ($hasExplicitZone -and [DateTimeOffset]::TryParse($raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedOffset)) {
    $instant = $parsedOffset
  } else {
    $parsedDate = [DateTime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AllowWhiteSpaces
    $parseSucceeded = [DateTime]::TryParse($raw, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsedDate)
    if (-not $parseSucceeded) { $parseSucceeded = [DateTime]::TryParse($raw, [Globalization.CultureInfo]::CurrentCulture, $styles, [ref]$parsedDate) }
    if (-not $parseSucceeded) { return '발행 시각 확인 불가' }
    $localKst = [DateTime]::SpecifyKind($parsedDate, [DateTimeKind]::Unspecified)
    $instant = [DateTimeOffset]::new($localKst, [TimeSpan]::FromHours(9))
  }
  return [TimeZoneInfo]::ConvertTime($instant, $zone).ToString('yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
}
function PriorityRank([string]$value) { if ($value -eq '높음') { 3 } elseif ($value -eq '중간') { 2 } elseif ($value -eq '낮음') { 1 } else { 0 } }
function PublicationSortKey([string]$value) {
  $formatted = FormatKstDate $value
  if ($formatted -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$') { return $formatted }
  return ''
}
function SubjectParticle([string]$company) {
  if (-not $company) { return '가' }
  $last = [int][char]$company[$company.Length - 1]
  if ($last -ge 44032 -and $last -le 55203) { return $(if ((($last - 44032) % 28) -gt 0) { '이' } else { '가' }) }
  return '가'
}
function PlainSentence([string]$value) {
  $sentence = ([string]$value -replace '[\s\r\n]+', ' ').Trim().TrimEnd('.', '。', '!', '?')
  if (-not $sentence) { return '' }
  $rules = @(
    @('하였습니다$', '하였다'), @('했습니다$', '했다'), @('되었습니다$', '되었다'), @('됐습니다$', '됐다'),
    @('였습니다$', '였다'), @('이었습니다$', '이었다'), @('혔습니다$', '혔다'), @('졌습니다$', '졌다'),
    @('났습니다$', '났다'), @('왔습니다$', '왔다'), @('했습니다$', '했다'), @('었습니다$', '었다'), @('았습니다$', '았다'),
    @('합니다$', '한다'), @('됩니다$', '된다'), @('있습니다$', '있다'), @('없습니다$', '없다'), @('보입니다$', '보인다'),
    @('같습니다$', '같다'), @('높습니다$', '높다'), @('낮습니다$', '낮다'), @('많습니다$', '많다'), @('적습니다$', '적다'),
    @('입니다$', '이다'), @('습니다$', '다'), @('이에요$', '이다'), @('예요$', '이다'), @('해요$', '한다'), @('돼요$', '된다')
  )
  foreach ($rule in $rules) {
    if ($sentence -match $rule[0]) {
      $sentence = [regex]::Replace($sentence, $rule[0], $rule[1])
      break
    }
  }
  return "$sentence."
}
function PoliteSentence([string]$value) {
  $sentence = ([string]$value -replace '[\s\r\n]+', ' ').Trim().TrimEnd('.', '。', '!', '?')
  if (-not $sentence) { return '' }
  $rules = @(
    @('다뤘다$', '다뤘습니다'), @('다룸$', '다뤘습니다'), @('밝혔다$', '밝혔습니다'), @('혔다$', '혔습니다'),
    @('됐다$', '됐습니다'), @('였다$', '였습니다'), @('했다$', '했습니다'),
    @('졌다$', '졌습니다'), @('섰다$', '섰습니다'), @('났다$', '났습니다'), @('왔다$', '왔습니다'), @('웠다$', '웠습니다'),
    @('었다$', '었습니다'), @('았다$', '았습니다'),
    @('한다$', '합니다'), @('는다$', '습니다'), @('진다$', '집니다'),
    @('하다$', '합니다'), @('되다$', '됩니다'), @('있다$', '있습니다'), @('없다$', '없습니다'), @('같다$', '같습니다'),
    @('높다$', '높습니다'), @('낮다$', '낮습니다'), @('많다$', '많습니다'), @('적다$', '적습니다'), @('작다$', '작습니다'), @('크다$', '큽니다'),
    @('이다$', '입니다')
  )
  $converted = $false
  foreach ($rule in $rules) {
    if ($sentence -match $rule[0]) { $sentence = [regex]::Replace($sentence, $rule[0], $rule[1]); $converted = $true; break }
  }
  if (-not $converted -and $sentence -match '다$') { $sentence = $sentence.Substring(0, $sentence.Length - 1) + '입니다' }
  elseif (-not $converted -and $sentence -notmatch '(?:습니다|ㅂ니다|입니다|세요|까요)$') { $sentence += '입니다' }
  return "$sentence."
}
function CompactNominalFact([string]$value, [string]$fallback = '', [string]$company = '') {
  $fact = ([string]$value -replace '[\s\r\n]+', ' ').Trim().TrimEnd('.', '。', '!', '?')
  if (-not $fact) { return '' }
  # Keep unseen complete sentences intact via a safe topic fallback; never strip
  # their predicate and accidentally render a visibly cut-off phrase.
  if ($fact -match '(?:습니다|ㅂ니다|하였습니다|했습니다|하였다|했다|한다|다룬다|제시한다|보도했다|전했다|입니다|이다)$') {
    $safeFallback = ([string]$fallback -replace '[\s\r\n]+', ' ').Trim().TrimEnd('.', '。', '!', '?')
    if ($safeFallback) { return $safeFallback }
    return '추가 보도 내용 확인'
  }
  $fact = $fact -replace '조선비즈 보도를 재인용한 외부 커뮤니티성 투자 분석이며 독립적인 1차 사실은 확인되지 않는다|조선비즈 보도를 재인용한 외부 커뮤니티성 투자 분석이며 독립적인 1차 사실은 확인되지 않습니다', '외부 커뮤니티 투자 분석 · 독립 사실 미확인'
  $fact = $fact -replace '동일 한국교육신문 기사의 대체 도메인 원문으로,\s*', ''
  $fact = $fact -replace '전자신문의 독립 기사로\s*', ''
  $fact = $fact -replace '사진은.*$', ''
  $fact = $fact -replace '보도를 재인용한', '보도 재인용'
  $fact = $fact -replace '보도를 재인용한', '보도 재인용'
  $fact = $fact -replace '외부 커뮤니티성', '외부 커뮤니티'
  $fact = $fact -replace '독립적인 1차 사실은 확인되지 않습니다|독립적인 1차 사실은 확인되지 않는다|독립적인 1차 사실이 확인되지 않습니다|독립적인 1차 사실이 확인되지 않는다', '독립 사실 미확인'
  $fact = $fact -replace '확인되지 않았습니다|확인되지 않았다|확인할 수 없습니다|확인할 수 없다', '확인 불가'
  $fact = $fact -replace '(?:내용을|내용은)\s*(?:구체적으로\s*)?(?:함께\s*)?(?:종합\s*)?(?:보도했다|보도한다|제시했다|제시한다|다룬다|보존한다|설명했다|설명한다)$', ''
  $fact = $fact -replace '\s*(?:을|를)\s*(?:함께\s*)?(?:종합\s*)?(?:보도했다|보도한다|제시했다|제시한다|다룬다|보존한다|설명했다|설명한다)$', ''
  $fact = $fact -replace '\s*(?:이며|이고|하면서|했으며|했고)\s*', ' · '
  $fact = $fact -replace '(추진|확대|강화|도입|출시|운영|공급|확보|지원|통합|발표|공개|체결|등록|진출|성장)(?:하고 있습니다|하고 있다|하였습니다|했습니다|하였다|했다|됩니다|되었다|됐다|합니다|한다)$', '$1'
  $fact = $fact -replace '(?:하고 있습니다|하고 있다|하였습니다|했습니다|하였다|했다|됩니다|되었다|됐다|합니다|한다|입니다|이다)$', ''
  if ($company) { $fact = $fact -replace "^$([regex]::Escape($company))(은|는|이|가)\s+", '' }
  $fact = $fact -replace '([가-힣A-Za-z0-9·\s]+?)(?:을|를)\s*(추진|확대|강화|도입|출시|운영|공급|확보|지원|통합|발표|공개|체결|등록|진출|성장)$', '$1 $2'
  $fact = $fact -replace '\s+', ' '
  $fact = $fact.Trim(' ', '·', ',', ';', ':', '，')
  $parts = @($fact -split '\s*[,;]\s*' | ForEach-Object { $_.Trim(' ', '·', ',') } | Where-Object { $_ })
  if ($parts.Count -gt 3) { $parts = @($parts | Select-Object -First 3) }
  $fact = ($parts -join ' · ').Trim(' ', '·')
  if ($fact.Length -gt 54 -or $fact -match '(?:습니다|ㅂ니다|한다|했다|다룬다|제시한다|보도했다|보존한다)$') {
    $fact = ([string]$fallback -replace '[\s\r\n]+', ' ').Trim()
  }
  if (-not $fact) { $fact = '관련 소재 확인' }
  return $fact
}
function IsPrimaryOfficialBlog($article) {
  if ([string]$article.company -ne $primaryCompanyName) { return $false }
  $publisherText = "$( [string]$article.publisher ) $( [string]$article.channel )"
  $ownedByConfiguredTarget = @($primaryAliases | Where-Object { $publisherText -match [regex]::Escape($_) }).Count -gt 0
  $matchesConfiguredUrl = @($officialBlogUrlPatterns | Where-Object { [string]$article.url -match $_ }).Count -gt 0
  $blogSource = $article.source_type -eq 'official_blog' -or
    (($article.PSObject.Properties.Name -contains 'sourceCategory') -and $article.sourceCategory -eq '블로그') -or
    ([string]$article.publisher -match '공식.*블로그') -or
    ([string]$article.channel -match '자사.*블로그|공식.*블로그') -or
    $matchesConfiguredUrl
  $ownedSource = $ownedByConfiguredTarget -or
    ([string]$article.publisher -match '자사|공식') -or
    ([string]$article.channel -match '자사|공식') -or
    $matchesConfiguredUrl
  return $blogSource -and $ownedSource
}
function IsPrimaryOnlinePost($article) {
  if ([string]$article.company -ne $primaryCompanyName) { return $false }
  if (IsPrimaryOfficialBlog $article) { return $true }
  $category = [string]$article.sourceCategory
  $origin = "$( [string]$article.publisher ) $( [string]$article.channel ) $( [string]$article.url )"
  return (@('블로그', '커뮤니티', 'SNS·영상', '비공식 매체') -contains $category) -or
    ($origin -match '(개인.?블로그|카페|커뮤니티|SNS|소셜미디어|후기|브런치)')
}
function DisplayTopic([string]$key, [object[]]$keywords = @(), [string]$fallback = '') {
  if ($key -match '^[a-z0-9]+(?:-[a-z0-9]+)+$') {
    $koreanKeywords = @($keywords | ForEach-Object { [string]$_ } | Where-Object { $_ -match '[가-힣]' } | Select-Object -First 3)
    if ($koreanKeywords.Count) { return ($koreanKeywords -join ' · ') }
    if ($fallback -match '[가-힣]') {
      $label = ($fallback -replace '[。.]$', '').Trim()
      if ($label.Length -gt 48) { $label = $label.Substring(0, 48).TrimEnd() + '…' }
      return $label
    }
    return '관련 기사 소재'
  }
  return $key
}
function NormalizeInsightTopic([string]$key, [string]$description, [string]$company) {
  $source = if ($key -and $key -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)+$') { $key.Trim() } else { $description.Trim() }
  $combined = "$key $description"
  if ($source -match '^[a-z0-9]+(?:-[a-z0-9]+)+$') { $source = $description.Trim() }
  $source = $source -replace '[\r\n]+', ' ' -replace '\s+', ' '
  if ($company) { $source = $source -replace "^$([regex]::Escape($company))(은|는|이|가)\s*", '' }
  $source = $source.Trim().TrimEnd('.', '。')
  if ($source.Length -le 34 -and $source -notmatch '(은|는|이|가)\s+.{0,20}(한다|추진|확대|강화|제공|운영|연결)') { return $source }
  if ($source -match '(AI\s*통번역)') { return 'AI 통번역 사업·서비스' }
  if ($source -match 'LMS|LXP|학습 플랫폼') { return 'LMS·LXP 학습 플랫폼' }
  if ($source -match 'IPO|수요예측') { return 'IPO·성장 자금 조달' }
  if ($source.Length -gt 34) { return "$company 관련 사업·서비스 동향" }
  return $source
}
$renderedCards = foreach ($article in $report.articles) {
  $isPrimaryOfficialBlog = IsPrimaryOfficialBlog $article
  $isPrimaryOnlinePost = IsPrimaryOnlinePost $article
  $isOfficialInstitutionPost = [string]$article.sourceCategory -eq '공식기관 게시물'
  $displayTitle = [string]$article.title
  if ($isPrimaryOfficialBlog) { $displayTitle = $displayTitle -replace '^\s*(?:\[자사 블로그 글\]\s*)+', '' }
  $sourceCaption = if ($isPrimaryOnlinePost -or $isOfficialInstitutionPost) { '게시 출처' } else { '대표 기사' }
  $sourceBadgeLabel = if ($isPrimaryOfficialBlog) { '자사 블로그 글' } elseif ($isPrimaryOnlinePost) { '온라인 게시글' } elseif ($isOfficialInstitutionPost) { '공식기관 게시물' } elseif ($article.company -eq $primaryCompanyName) { '언론보도' } else { '' }
  $sourceBadgeStyle = if ($isOfficialInstitutionPost) { "background:#e8f1f7;color:#275875" } elseif ($isPrimaryOnlinePost) { "background:#fff3d6;color:#8a3b12" } else { "background:#eee8e1;color:#65483d" }
  $sourceBadge = if ($sourceBadgeLabel) { "<span style='display:inline-block;margin-right:6px;padding:3px 7px;border-radius:999px;$sourceBadgeStyle;font-size:11px;font-weight:800'>$(Html $sourceBadgeLabel)</span>" } else { '' }
  $sourceCategoryMeta = if (($article.PSObject.Properties.Name -contains 'sourceCategory') -and [string]$article.sourceCategory -ne $sourceBadgeLabel) { " &nbsp;·&nbsp; $(Html $article.sourceCategory)" } else { '' }
  $sourceReliabilityMeta = if ($article.PSObject.Properties.Name -contains 'sourceReliability' -and $article.sourceReliability) { " &nbsp;·&nbsp; 신뢰도 $(Html $article.sourceReliability)" } else { '' }
  $sourceMeta = if ($isPrimaryOfficialBlog) { $sourceBadge } else { "$sourceBadge$(Html $article.company) &nbsp;·&nbsp; ${sourceCaption}: $(Html $article.publisher)$sourceCategoryMeta$sourceReliabilityMeta" }
  $importanceStyle = if ($article.importance -eq '높음') { 'background:#fee4e2;color:#b42318' } elseif ($article.importance -eq '중간') { 'background:#fff3d6;color:#8a6100' } else { 'background:#f2f4f7;color:#475467' }
  $threatStyle = if ($article.threat -eq '높음') { 'background:#fee4e2;color:#b42318' } elseif ($article.threat -eq '중간') { 'background:#fff3d6;color:#8a6100' } else { 'background:#f2f4f7;color:#475467' }
  $keywordTags = if ($article.PSObject.Properties.Name -contains 'keywords') {
    @($article.keywords | Select-Object -First 5 | ForEach-Object {
      "<span style='display:inline-block;margin:0 6px 6px 0;padding:5px 9px;border-radius:999px;background:#eee8e1;color:#65483d;font-size:12px;font-weight:700'>#$(Html ([string]$_))</span>"
    }) -join ''
  } else { '' }
  $highReasonRows = @()
  $riskValue = if ($article.company -eq $primaryCompanyName -and $article.reputationRisk) { [string]$article.reputationRisk } else { [string]$article.threat }
  $riskLabel = if ($article.company -eq $primaryCompanyName) { '평판 위험도' } else { '위협도' }
  $riskStyle = if ($riskValue -eq '높음') { 'background:#fee4e2;color:#b42318' } elseif ($riskValue -eq '중간') { 'background:#fff3d6;color:#8a6100' } else { 'background:#f2f4f7;color:#475467' }
  $reputationToneBadge = ''
  if ($article.company -eq $primaryCompanyName -and $article.tone) {
    $toneStyle = if ($article.tone -eq '비판') { 'background:#fee4e2;color:#b42318' } elseif ($article.tone -eq '우호') { 'background:#e8f5e9;color:#26733b' } elseif ($article.tone -eq '판단 보류') { 'background:#fff3d6;color:#8a6100' } else { 'background:#f2f4f7;color:#475467' }
    $reputationToneBadge = "<span style='display:inline-block;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:700;margin-left:5px;$toneStyle'>평판 $(Html ([string]$article.tone))</span>"
  }
  if ($article.importance -eq '높음') {
    $highReasonRows += "<tr><td width='112' style='padding:10px 12px;color:#b42318;font-weight:700;border-top:1px solid #ece7e1'>중요도 근거</td><td style='padding:10px 12px;border-top:1px solid #ece7e1'>$(Html $article.importanceReason)</td></tr>"
  }
  if ($article.company -eq $primaryCompanyName -and ($article.reputationRisk -eq '높음' -or $article.tone -eq '비판')) {
    $reputationReason = if ($article.reputationRiskReason) { [string]$article.reputationRiskReason } elseif ($article.toneReason) { [string]$article.toneReason } else { '원문에서 평판에 영향을 줄 수 있는 구체적 내용을 확인하세요.' }
    $highReasonRows += "<tr><td width='112' style='padding:10px 12px;color:#b42318;font-weight:700;border-top:1px solid #ece7e1'>평판 판단 근거</td><td style='padding:10px 12px;border-top:1px solid #ece7e1'>$(Html $reputationReason)</td></tr>"
  } elseif ($article.threat -eq '높음') {
    $highReasonRows += "<tr><td width='112' style='padding:10px 12px;color:#b42318;font-weight:700;border-top:1px solid #ece7e1'>위협도 근거</td><td style='padding:10px 12px;border-top:1px solid #ece7e1'>$(Html $article.threatReason)</td></tr>"
  }
  $coverageBlock = ''
  if ($article.PSObject.Properties.Name -contains 'coverageCount' -and [int]$article.coverageCount -gt 1) {
    $otherOutlets = if ($article.PSObject.Properties.Name -contains 'coverageLinks' -and @($article.coverageLinks).Count) {
      @($article.coverageLinks | ForEach-Object {
        $publisher = Html ([string]$_.publisher)
        $url = [string]$_.url
        if ($url -match '^https?://') { "<a href='$(Html $url)' style='color:#475467;text-decoration:underline;font-weight:700' title='$(Html ([string]$_.title))'>$publisher</a>" }
        else { "<span title='$(Html ([string]$_.title))'>$publisher</span>" }
      }) -join ', '
    } else {
      @($article.coverageOutlets | ForEach-Object { Html ([string]$_) }) -join ', '
    }
    $coverageBlock = "<div style='margin:0 0 14px;padding:10px 12px;background:#f1f5f9;border-radius:8px;color:#475467;font-size:12px'><b>동일 이슈 총 $($article.coverageCount)건</b>$(if ($otherOutlets) { " &nbsp;·&nbsp; 추가 노출: $otherOutlets" } else { '' })</div>"
  }
  $additionalFactsRow = ''
  if ($article.PSObject.Properties.Name -contains 'additionalFacts' -and @($article.additionalFacts).Count) {
    $fallbackTopic = @($article.keywords | ForEach-Object { [string]$_ } | Where-Object { $_ -match '[가-힣]' } | Select-Object -First 3) -join '·'
    $allFacts = @($article.additionalFacts | ForEach-Object { CompactNominalFact ([string]$_) $fallbackTopic ([string]$article.company) } | Where-Object { $_ } | Select-Object -Unique)
    $shownFacts = @($allFacts | Select-Object -First 3 | ForEach-Object {
      "<li style='margin:0 0 5px;overflow-wrap:anywhere;word-break:keep-all'>$(Html ([string]$_))</li>"
    }) -join ''
    $remainingFacts = $allFacts.Count - [Math]::Min(3, $allFacts.Count)
    $moreFacts = if ($remainingFacts -gt 0) { "<div style='margin-top:4px;color:#746b63;font-size:11px'>외 $remainingFacts건 · 추가 매체 링크 참고</div>" } else { '' }
    $additionalFactsRow = "<tr><td width='112' style='padding:9px 12px;color:#75665c;font-weight:700;border-top:1px solid #ece7e1;vertical-align:top;white-space:nowrap'>추가 보도</td><td style='padding:8px 12px;border-top:1px solid #ece7e1;line-height:1.65;overflow-wrap:anywhere;word-break:keep-all'><ul style='margin:0;padding-left:17px'>$shownFacts</ul>$moreFacts</td></tr>"
  }
  $cardHtml = @"
<table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='margin:0 0 16px;background:#ffffff;border:1px solid #e7e2dc;border-radius:12px'>
<tr><td style='padding:20px'>
  <div style='font-size:12px;color:#8a6250;font-weight:700;margin-bottom:7px'>$sourceMeta</div>
  <a href='$(Html $article.url)' style='font-size:18px;line-height:1.45;font-weight:700;color:#25211e;text-decoration:none'>$(Html $displayTitle)</a>
  <div style='font-size:12px;color:#7a746e;margin-top:7px'>$(Html $article.reporter) &nbsp;·&nbsp; <span style='white-space:nowrap'>$(Html (FormatKstDate ([string]$article.publishedAt)))</span></div>
  $(if ($article.PSObject.Properties.Name -contains 'contentAccess') { "<div style='font-size:11px;color:#857c75;margin-top:5px'>원문 확인: $(Html $article.contentAccess)</div>" } else { '' })
  $(if ($keywordTags) { "<div style='margin:16px 0 12px'>$keywordTags</div>" } else { '' })
  $coverageBlock
  <div style='margin-bottom:16px'>
    <span style='display:inline-block;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:700;$importanceStyle'>중요도 $(Html $article.importance)</span>
    <span style='display:inline-block;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:700;margin-left:5px;$riskStyle'>$(Html $riskLabel) $(Html $riskValue)</span>
    $reputationToneBadge
  </div>
  <table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='font-size:13px;line-height:1.65;background:#faf8f5;border-radius:8px'>
    <tr><td width='112' style='padding:10px 12px;color:#75665c;font-weight:700'>핵심 메시지</td><td style='padding:10px 12px'>$(Html (PlainSentence ([string]$article.keyMessage)))</td></tr>
    $($highReasonRows -join "`n")
    $additionalFactsRow
    <tr><td width='112' style='padding:10px 12px;color:#75665c;font-weight:700;border-top:1px solid #ece7e1'>활용 포인트</td><td style='padding:10px 12px;border-top:1px solid #ece7e1'>$(Html $article.actionPoint)</td></tr>
  </table>
  <div style='margin-top:14px;text-align:right'><a href='#brief-top' style='font-size:12px;color:#7b3f2e;text-decoration:none;font-weight:700'>↑ 맨 위로</a></div>
</td></tr></table>
"@
  $cardHtml = $cardHtml -replace "(?s)<tr><td width='112'[^>]*>활용 포인트</td><td[^>]*>.*?</td></tr>", ''
  [pscustomobject]@{ Company = [string]$article.company; CollectionGroup = [string]$article.collectionGroup; Category = [string]$article.sourceCategory; PrType = $(if ($article.company -eq $primaryCompanyName -and $isPrimaryOnlinePost) { '온라인 게시글' } elseif ($article.company -eq $primaryCompanyName) { '언론보도' } else { '' }); Topic = (DisplayTopic ([string]$article.topicKey) @($article.keywords) ([string]$article.keyMessage)); ImportanceRank = (PriorityRank ([string]$article.importance)); ThreatRank = (PriorityRank ([string]$article.threat)); PublishedAt = (PublicationSortKey ([string]$article.publishedAt)); CoverageCount = [Math]::Max(1, [int]$article.coverageCount); Html = $cardHtml; TitleOnly = $false }
}
$reportArticles = @($report.articles)
$totalCount = $reportArticles.Count
$rawArticleCount = [int](($reportArticles | ForEach-Object { [Math]::Max(1, [int]$_.coverageCount) } | Measure-Object -Sum).Sum)
$seenArticleUrls = @{}
foreach ($article in $reportArticles) {
  $coverageCount = if ($article.PSObject.Properties.Name -contains 'coverageCount') { [Math]::Max(1, [int]$article.coverageCount) } else { 1 }
  $coverageLinkCount = if ($article.PSObject.Properties.Name -contains 'coverageLinks') { @($article.coverageLinks).Count } else { 0 }
  if ($coverageCount -ne $coverageLinkCount + 1) { throw "발송 전 검증 실패: '$($article.title)'의 전체 기사 $coverageCount건과 추가 노출 $coverageLinkCount건이 맞지 않습니다. 분석을 다시 실행하세요." }
  foreach ($url in @([string]$article.url) + @($article.coverageLinks | ForEach-Object { [string]$_.url })) {
    $canonicalUrl = ([string]$url).Trim().TrimEnd('/').ToLowerInvariant()
    if ($canonicalUrl -match '^https?://') {
      if ($seenArticleUrls.ContainsKey($canonicalUrl)) { throw "발송 전 검증 실패: 하나의 기사가 여러 이슈 카드에 중복되어 있습니다. 분석을 다시 실행하세요." }
      $seenArticleUrls[$canonicalUrl] = $true
    }
  }
}
$groupAItems = @($reportArticles | Where-Object { $_.collectionGroup -eq 'A' })
$groupBItems = @($reportArticles | Where-Object { $_.collectionGroup -eq 'B' })
$groupCItems = @($reportArticles | Where-Object { $_.collectionGroup -eq 'C' })
if (($groupAItems.Count + $groupBItems.Count + $groupCItems.Count) -ne $totalCount) { throw '발송 전 검증 실패: 모든 이슈가 A/B/C 중 정확히 한 그룹으로 분류되지 않았습니다. 분석을 다시 실행하세요.' }
$sumGroupedArticles = [int](($reportArticles | ForEach-Object { [Math]::Max(1, [int]$_.coverageCount) } | Measure-Object -Sum).Sum)
if ($sumGroupedArticles -ne $rawArticleCount) { throw '발송 전 검증 실패: 이슈별 기사 합계와 전체 기사 수가 맞지 않습니다.' }
$groupAArticleCount = [int](($groupAItems | ForEach-Object { [Math]::Max(1, [int]$_.coverageCount) } | Measure-Object -Sum).Sum)
$groupBArticleCount = [int](($groupBItems | ForEach-Object { [Math]::Max(1, [int]$_.coverageCount) } | Measure-Object -Sum).Sum)
$groupCArticleCount = [int](($groupCItems | ForEach-Object { [Math]::Max(1, [int]$_.coverageCount) } | Measure-Object -Sum).Sum)
$coverageItems = @($report.coverage)
$companyAnchorIds = @{}
for ($index = 0; $index -lt $coverageItems.Count; $index++) {
  $companyAnchorIds[[string]$coverageItems[$index].company] = "company-card-$index"
}
$coverage = for ($index = 0; $index -lt $coverageItems.Count; $index++) {
  $item = $coverageItems[$index]
  $matchingIssues = if ($item.company -eq '기타 유사기업') { @($reportArticles | Where-Object { $_.collectionGroup -eq 'C' }) } else { @($reportArticles | Where-Object { $_.company -eq [string]$item.company }) }
  $issueCount = $matchingIssues.Count
  $articleCount = [int](($matchingIssues | ForEach-Object { [Math]::Max(1, [int]$_.coverageCount) } | Measure-Object -Sum).Sum)
  $targetId = if ($issueCount -gt 0) { [string]$companyAnchorIds[[string]$item.company] } elseif ($item.company -eq $primaryCompanyName) { 'primary-news' } else { 'competitor-news' }
  "<a href='#$targetId' style='display:inline-block;margin:0 6px 6px 0;padding:6px 10px;border-radius:999px;background:#eee8e1;color:#514941;font-size:12px;text-decoration:none'><b>$(Html $item.company)</b> $issueCount개 이슈(콘텐츠 $($articleCount)건)</a>"
}
$importantCount = @($report.articles | Where-Object { $_.importance -eq '높음' }).Count
$primaryCards = @($renderedCards | Where-Object { $_.Company -eq $primaryCompanyName })
$competitorCards = @($renderedCards | Where-Object { $_.Company -ne $primaryCompanyName } | Sort-Object @{Expression='Company';Descending=$false}, @{Expression='ImportanceRank';Descending=$true}, @{Expression='ThreatRank';Descending=$true}, @{Expression='PublishedAt';Descending=$true})
$primaryOfficialPr = @($primaryCards | Where-Object { $_.PrType -eq '언론보도' })
$primaryUnofficialPr = @($primaryCards | Where-Object { $_.PrType -eq '온라인 게시글' })
function AddCompanyCardAnchors([object[]]$items, [hashtable]$addedAnchors) {
  foreach ($item in @($items)) {
    $anchorKey = [string]$item.Company
    if (-not $companyAnchorIds.ContainsKey($anchorKey) -and [string]$item.CollectionGroup -eq 'C') { $anchorKey = '기타 유사기업' }
    if (-not $companyAnchorIds.ContainsKey($anchorKey)) { continue }
    $anchorId = [string]$companyAnchorIds[$anchorKey]
    if ($addedAnchors.ContainsKey($anchorId)) { continue }
    $item.Html = "<a name='$anchorId' id='$anchorId' style='display:block;height:0;font-size:0;line-height:0'></a>$($item.Html)"
    $addedAnchors[$anchorId] = $true
  }
}
$addedCompanyAnchors = @{}
AddCompanyCardAnchors $primaryOfficialPr $addedCompanyAnchors
AddCompanyCardAnchors $primaryUnofficialPr $addedCompanyAnchors
AddCompanyCardAnchors $competitorCards $addedCompanyAnchors
function SectionContent($items, [string]$emptyMessage, [switch]$PreserveCardOrder) {
  if (-not @($items).Count) { return "<div style='padding:18px;background:#fff;border:1px solid #e7e2dc;border-radius:12px;color:#7a746e;text-align:center'>$emptyMessage</div>" }
  if ($PreserveCardOrder) { return (@($items).Html -join "`n") }
  $useTopicGrouping = $report.PSObject.Properties.Name -contains 'formatVersion' -and [int]$report.formatVersion -ge 2
  if (-not $useTopicGrouping) { return (@($items).Html -join "`n") }
  $titleOnlyItems = @($items | Where-Object { $_.TitleOnly })
  $detailedItems = @($items | Where-Object { -not $_.TitleOnly })
  $groups = @($detailedItems | Group-Object { "$($_.Company)|$($_.Topic)" } | Sort-Object @{Expression={($_.Group | Measure-Object ImportanceRank -Maximum).Maximum};Descending=$true}, @{Expression={($_.Group | Measure-Object ThreatRank -Maximum).Maximum};Descending=$true})
  $groupedContent = @($groups | ForEach-Object {
    $first = $_.Group[0]
    $cards = @($_.Group | Sort-Object ImportanceRank,ThreatRank -Descending).Html -join "`n"
    "<div style='margin:18px 0 10px;padding:9px 12px;border-left:4px solid #7b3f2e;background:#eee8e1;color:#51382f;font-size:13px;font-weight:800'>$(Html $first.Company) &nbsp;·&nbsp; $(Html $first.Topic) &nbsp;·&nbsp; $($_.Count)개 이슈</div>$cards"
  }) -join "`n"
  return (@(@($titleOnlyItems | ForEach-Object { $_.Html }) + @($groupedContent) | Where-Object { $_ }) -join "`n")
}
$primaryOfficialPrContent = SectionContent $primaryOfficialPr '확인된 주 대상 관련 언론보도가 없습니다.' -PreserveCardOrder
$primaryUnofficialPrContent = SectionContent $primaryUnofficialPr '확인된 주 대상 관련 온라인 게시글이 없습니다.' -PreserveCardOrder
$competitorContent = SectionContent $competitorCards '해당 기간에 확인된 경쟁사·유사기업 기사가 없습니다.' -PreserveCardOrder
$primaryItems = @($report.articles | Where-Object { $_.company -eq $primaryCompanyName })
$primaryOfficialItems = @($report.articles | Where-Object { $_.company -eq $primaryCompanyName -and -not (IsPrimaryOnlinePost $_) })
$primaryUnofficialItems = @($report.articles | Where-Object { IsPrimaryOnlinePost $_ })
$primaryReputationItems = $primaryItems
$primaryOfficialExposureCount = [int](($primaryOfficialItems | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'coverageCount') { [int]$_.coverageCount } else { 1 } } | Measure-Object -Sum).Sum)
$primaryInstitutionalExposureCount = [int](($primaryOfficialItems | Where-Object { [string]$_.sourceCategory -eq '공식기관 게시물' } | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'coverageCount') { [int]$_.coverageCount } else { 1 } } | Measure-Object -Sum).Sum)
$primaryUnofficialExposureCount = [int](($primaryUnofficialItems | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'coverageCount') { [int]$_.coverageCount } else { 1 } } | Measure-Object -Sum).Sum)
$primaryExposureCount = [int](($primaryItems | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'coverageCount') { [int]$_.coverageCount } else { 1 } } | Measure-Object -Sum).Sum)
$primaryArticleCount = $primaryExposureCount
$primaryIssueCount = $primaryItems.Count
$competitorIssueCount = $competitorCards.Count
$competitorArticleCount = [int](($competitorCards | ForEach-Object { [Math]::Max(1, [int]$_.CoverageCount) } | Measure-Object -Sum).Sum)
$reputationAttentionCount = @($primaryReputationItems | Where-Object { $_.reputationRisk -eq '높음' -or $_.tone -eq '비판' }).Count
$primaryTopics = @($primaryReputationItems | ForEach-Object {
  NormalizeInsightTopic ([string]$_.topicKey) ([string]$_.keyMessage) $primaryCompanyName
} | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 2)
if ($primaryItems.Count) {
  $sourceSummary = @()
  if ($primaryOfficialExposureCount -gt 0) {
    $officialSourceSummary = "언론보도 $($primaryOfficialExposureCount)건"
    if ($primaryInstitutionalExposureCount -gt 0) { $officialSourceSummary += "(공식기관 게시물 $($primaryInstitutionalExposureCount)건 포함)" }
    $sourceSummary += $officialSourceSummary
  }
  if ($primaryUnofficialExposureCount -gt 0) { $sourceSummary += "온라인 게시글 $($primaryUnofficialExposureCount)건" }
  $topicText = if ($primaryTopics.Count) { " 주요 소재는 $($primaryTopics -join '·')입니다." } else { '' }
  $riskText = if ($reputationAttentionCount -gt 0) { '평판 위험 신호가 있습니다.' } else { '평판 위험 신호는 확인되지 않았습니다.' }
  $summarySentences = @("주 대상 관련 PR은 $($sourceSummary -join ' 및 ') 확인됐습니다.$topicText $riskText")
} else {
  $summarySentences = @('주 대상 관련 기사는 확인되지 않았습니다.')
}
if ($competitorCards.Count) {
  $topCompetitor = $competitorCards[0]
  $topArticle = $reportArticles | Where-Object { $_.company -eq $topCompetitor.Company -and (DisplayTopic ([string]$_.topicKey) @($_.keywords) ([string]$_.keyMessage)) -eq $topCompetitor.Topic } | Sort-Object @{Expression={PriorityRank ([string]$_.importance)};Descending=$true}, @{Expression={PriorityRank ([string]$_.threat)};Descending=$true}, @{Expression={(FormatKstDate ([string]$_.publishedAt))};Descending=$true} | Select-Object -First 1
  $trendText = if ($topArticle.keyMessage) { [string]$topArticle.keyMessage } else { [string]$topArticle.title }
  $trendText = ($trendText -replace '[\s\r\n]+', ' ').Trim().TrimEnd('.', '。')
  $subjectPrefix = "^$([regex]::Escape([string]$topCompetitor.Company))(은|는|이|가)\s*"
  if ($trendText -match $subjectPrefix) {
    $trendText = $trendText -replace $subjectPrefix, ''
    $trendText = "$($topCompetitor.Company)$(SubjectParticle ([string]$topCompetitor.Company)) $trendText"
  } else {
    $trendText = "$($topCompetitor.Company)$(SubjectParticle ([string]$topCompetitor.Company)) $trendText"
  }
  $trendText = PoliteSentence $trendText
  $summarySentences += "경쟁사 중에서는 $trendText"
}
$report.executiveSummary = $summarySentences -join ' '
$toneSummary = @('우호','중립','비판','판단 보류' | ForEach-Object {
  $tone = $_
  $count = @($primaryReputationItems | Where-Object { $_.tone -eq $tone }).Count
  "<span style='display:inline-block;margin:0 6px 6px 0;padding:6px 10px;border-radius:999px;background:#f3eee8;color:#51382f;font-size:12px'><b>$(Html $tone)</b> $count</span>"
}) -join ''
$reputationRisks = @($primaryReputationItems | Where-Object { $_.reputationRisk -eq '높음' -or $_.tone -eq '비판' } | Select-Object -First 5 | ForEach-Object {
  $reason = if ($_.reputationRiskReason) { [string]$_.reputationRiskReason } elseif ($_.toneReason) { [string]$_.toneReason } elseif ($_.keyMessage) { [string]$_.keyMessage } else { '원문 확인 필요' }
  "<li><a href='$(Html ([string]$_.url))' style='color:#7b3f2e'>$(Html ([string]$_.title))</a> · $(Html ([string]$_.publisher)) · $(Html ([string]$_.reputationRisk)) — $(Html $reason)</li>"
}) -join ''
$reputationRiskContent = if ($reputationRisks) { "<ul style='margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.6'>$reputationRisks</ul>" } elseif (-not $primaryItems.Count) { "<div style='margin-top:6px;color:#746b63;font-size:13px'>주 대상 관련 콘텐츠가 없어 평판을 판단할 자료가 없습니다.</div>" } else { "<div style='margin-top:6px;color:#746b63;font-size:13px'>이번에 수집한 주 대상 관련 콘텐츠에서 비판 또는 고위험 평판 신호가 확인되지 않았습니다.</div>" }
$primaryOfficialPrArticleCount = [int](($primaryOfficialPr | ForEach-Object { [Math]::Max(1, [int]$_.CoverageCount) } | Measure-Object -Sum).Sum)
$primaryUnofficialPrArticleCount = [int](($primaryUnofficialPr | ForEach-Object { [Math]::Max(1, [int]$_.CoverageCount) } | Measure-Object -Sum).Sum)
$primaryReputationBlock = @"
<tr><td style='height:22px'></td></tr>
<tr><td><table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='background:#fff;border:1px solid #e7e2dc;border-radius:12px'><tr><td style='padding:18px 20px'>
  <div style='font-size:18px;font-weight:800;color:#7b3f2e;margin-bottom:6px'>주 대상·브랜드 대외 평판</div>
  <div style='font-size:12px;color:#746b63;margin-bottom:9px'>전체 $($primaryItems.Count)개 이슈(콘텐츠 $($primaryExposureCount)건) · 언론보도 $($primaryOfficialItems.Count)개 이슈(콘텐츠 $($primaryOfficialExposureCount)건) · 온라인 게시글 $($primaryUnofficialItems.Count)개 이슈(게시글 $($primaryUnofficialExposureCount)건) · 전체 콘텐츠 평판 판단</div>
  <div>$toneSummary</div>
  <div style='font-size:14px;font-weight:800;color:#51382f;margin-top:8px'>평판 주의 신호</div>
  $reputationRiskContent
</td></tr></table></td></tr>
"@

# 이번 발송 범위에서 경쟁사 후보·노출 빈도·반복 이슈를 요약합니다.
# 대표 기사와 동일 이슈 추가 노출을 구분하되, 추가 매체가 있으면 노출 수에 함께 반영합니다.
$insightArticles = @($report.articles | Where-Object { -not (IsPrimaryOfficialBlog $_) })
$companyStats = @($insightArticles | Group-Object { [string]$_.company } | ForEach-Object {
  $rows = @($_.Group)
  [pscustomobject]@{
    Name = [string]$_.Name
    IssueCount = $rows.Count
    ExposureCount = (($rows | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'coverageCount') { [int]$_.coverageCount } else { 1 } } | Measure-Object -Sum).Sum)
    HighSignal = @($rows | Where-Object { $_.importance -eq '높음' -or $_.threat -eq '높음' }).Count -gt 0
  }
} | Sort-Object @{Expression={$_.ExposureCount};Descending=$true}, @{Expression={$_.IssueCount};Descending=$true})
$mediaNames = foreach ($item in $insightArticles) {
  if ($item.PSObject.Properties.Name -contains 'publisher' -and [string]$item.publisher) { [string]$item.publisher }
  if ($item.PSObject.Properties.Name -contains 'coverageOutlets') { @($item.coverageOutlets | ForEach-Object { [string]$_ }) }
}
$mediaStats = @($mediaNames | Where-Object { $_ } | Group-Object | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; Count = [int]$_.Count }
} | Sort-Object @{Expression='Count';Descending=$true}, @{Expression='Name';Descending=$false})
$reporterStats = @($insightArticles | ForEach-Object {
  $name = [string]$_.reporter
  if ($name -and $name -notmatch '확인 불가|미확인') { $name }
} | Group-Object | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; Count = [int]$_.Count }
} | Sort-Object @{Expression='Count';Descending=$true}, @{Expression='Name';Descending=$false})
$repeatIssues = @($insightArticles | Where-Object {
  $_.PSObject.Properties.Name -contains 'coverageCount' -and [int]$_.coverageCount -gt 1
} | Sort-Object @{Expression={[int]$_.coverageCount};Descending=$true})
if ($report.PSObject.Properties.Name -contains 'rollingInsights' -and $report.rollingInsights) {
  $rolling = $report.rollingInsights
  $companyStats = @($rolling.companies | ForEach-Object {
    [pscustomobject]@{
      Name = [string]$_.name
      IssueCount = [int]$_.issueCount
      ExposureCount = [int]$_.exposureCount
      HighSignal = [bool]$_.highSignal
    }
  })
  $mediaStats = @($rolling.media | ForEach-Object {
    [pscustomobject]@{ Name = [string]$_.name; Count = [int]$_.count }
  })
  $reporterStats = @($rolling.reporters | ForEach-Object {
    [pscustomobject]@{ Name = [string]$_.name; Count = [int]$_.count }
  })
  $repeatIssues = @($rolling.repeatedIssues | ForEach-Object {
    [pscustomobject]@{
      company = [string]$_.company
      topicKey = [string]$_.topicKey
      description = [string]$_.description
      coverageCount = [int]$_.coverageCount
      coverageOutlets = @($_.outlets)
    }
  })
  $collectionPeriodSummary = [string]$rolling.collectionPeriodSummary
  if (-not $collectionPeriodSummary) {
    $archivePath = Join-Path $projectDir 'reports\pr-history.json'
    if (Test-Path -LiteralPath $archivePath) {
      $history = @(Get-Content -LiteralPath $archivePath -Raw -Encoding utf8 | ConvertFrom-Json)
      $runCount = [Math]::Min([int]$rolling.archivedRuns, $history.Count)
      $recentHistory = @($history | Select-Object -Last $runCount)
      $periods = @($recentHistory | ForEach-Object { [string]$_.period } | Where-Object { $_ -match '~' })
      if ($periods.Count) {
        $periodBounds = @($periods | ForEach-Object { ,($_ -split '~' | ForEach-Object { $_.Trim() }) })
        $hasGap = $false
        $hasOverlap = $false
        for ($index = 1; $index -lt $periodBounds.Count; $index++) {
          try {
            $previousEnd = [DateTimeOffset]::ParseExact($periodBounds[$index - 1][1], 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
            $nextStart = [DateTimeOffset]::ParseExact($periodBounds[$index][0], 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
            if ($nextStart -gt $previousEnd) { $hasGap = $true }
            if ($nextStart -lt $previousEnd) { $hasOverlap = $true }
          } catch {}
        }
        $caveat = @()
        if ($hasGap) { $caveat += '중간 공백 있음' }
        if ($hasOverlap) { $caveat += '일부 기간 겹침' }
        $collectionPeriodSummary = "$($periodBounds[0][0])~$($periodBounds[-1][1]) · 저장 보고서 $($periods.Count)회분$(if ($caveat.Count) { ' (' + ($caveat -join '·') + ')' } else { '' })"
      }
    }
  }
}

$candidateRows = @($candidatePool | Select-Object -First 4 | ForEach-Object {
  $signal = if ($_.HighSignal) { '중요도·위협도 높은 신호 포함' } else { '이번 범위에서 2개 이상 이슈 노출' }
  "<li style='margin:0 0 6px'><b>$(Html $_.Name)</b> · $($_.IssueCount)개 이슈(기사 $($_.ExposureCount)건) · $(Html $signal)</li>"
}) -join ''
if (-not $candidateRows) { $candidateRows = '<li>이번 범위에서 자동 후보로 분류할 기업이 없습니다.</li>' }
$topCompanies = @($companyStats | Where-Object { $_.Name -ne $primaryCompanyName -and $_.ExposureCount -ge 3 } | Sort-Object @{Expression='ExposureCount';Descending=$true}, @{Expression='Name';Descending=$false} | Select-Object -First 3)
$companyRows = @($topCompanies | ForEach-Object {
  $companyName = [string]$_.Name
  $companyIssues = @($repeatIssues | Where-Object { $_.company -eq $companyName -and [int]$_.coverageCount -gt 1 } | ForEach-Object {
    [pscustomobject]@{
      Label = NormalizeInsightTopic ([string]$_.topicKey) ([string]$_.description) $companyName
      CoverageCount = [int]$_.coverageCount
    }
  } | Group-Object Label | ForEach-Object {
    [pscustomobject]@{ Label = [string]$_.Name; CoverageCount = [int](($_.Group | Measure-Object CoverageCount -Maximum).Maximum) }
  } | Sort-Object @{Expression='CoverageCount';Descending=$true}, @{Expression='Label';Descending=$false} | Select-Object -First 3)
  $issueMarkup = if ($companyIssues.Count) {
    @($companyIssues | ForEach-Object { "<span style='display:inline-block;margin:0 12px 3px 0'>$(Html ([string]$_.Label)) <span style='color:#746b63'>· 기사 $([int]$_.CoverageCount)건</span></span>" }) -join ''
  } else { '<span style="color:#746b63">반복 이슈 없음</span>' }
  "<tr><td width='20%' style='padding:9px 2px;border-top:1px solid #e2d8cf;vertical-align:top;font-weight:800;color:#25211e'>$(Html $companyName)</td><td width='13%' style='padding:9px 2px;border-top:1px solid #e2d8cf;vertical-align:top;white-space:nowrap;color:#25211e'>전체 $([int]$_.ExposureCount)건</td><td style='padding:9px 2px;border-top:1px solid #e2d8cf;vertical-align:top;color:#655c55'>$issueMarkup</td></tr>"
}) -join ''
if (-not $companyRows) { $companyRows = "<tr><td colspan='3' style='padding:9px 2px;border-top:1px solid #e2d8cf;color:#746b63'>노출 3회 이상인 기업이 없습니다.</td></tr>" }
$insightScopeText = if ($report.PSObject.Properties.Name -contains 'rollingInsights' -and $report.rollingInsights) {
  "최근 $([int]$report.rollingInsights.windowDays)일 누적 기준 · 누적 실행 $([int]$report.rollingInsights.archivedRuns)회 · 중복 제거 기사 $([int]$report.rollingInsights.uniqueArticleCount)건 · 기사 수집 기간 $collectionPeriodSummary"
} else {
  '현재 분석 범위 안에서만 계산한 단기 신호이며, 누적 데이터가 쌓이면 4주 추이로 확장됩니다.'
}
$insightBlock = @"
<tr><td>
  <table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='margin-top:24px;background:#fff;border:1px solid #e7e2dc;border-radius:12px'><tr><td style='padding:18px 20px'>
    <div style='font-size:17px;font-weight:800;color:#7b3f2e;margin-bottom:4px'>자주 언급된 기업 (최근 28일, 노출 3회 이상)</div>
    <div style='font-size:11px;color:#8a817a;margin-bottom:8px'>$(Html $insightScopeText) · 소재 옆 숫자는 해당 소재의 개별 기사 건수입니다.</div>
    <table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='font-size:13px;line-height:1.55;margin:0'>
      <tr><td width='20%' style='padding:5px 2px;color:#8a817a;font-size:11px'>기업</td><td width='13%' style='padding:5px 2px;color:#8a817a;font-size:11px'>전체 노출</td><td style='padding:5px 2px;color:#8a817a;font-size:11px'>주요 소재</td></tr>
      $companyRows
    </table>
  </td></tr></table>
</td></tr>
"@
if ($env:PAPR_PR_ONLY -eq '1') { $insightBlock = '' }
$body = @"
<!doctype html><html><head><meta charset='utf-8'></head>
<body style='margin:0;padding:0;background:#f4f1ed;font-family:Arial,"Malgun Gothic",sans-serif;color:#25211e'>
<table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='background:#f4f1ed'><tr><td align='center' style='padding:28px 12px'>
<table id='brief-top' role='presentation' width='100%' cellspacing='0' cellpadding='0' style='max-width:760px'>
<tr><td style='padding:24px 26px;background:#7b3f2e;border-radius:14px 14px 0 0;color:#fff'>
  $(if ($Test) { "<div style='margin:0 0 12px;padding:9px 12px;border-radius:8px;background:#fff3d6;color:#8a3b12;font-size:13px;font-weight:800'>[테스트] 본 메일은 지정된 테스트 수신자 확인용이며 팀 공유 메일이 아닙니다.</div>" } else { '' })
  <div style='font-size:12px;letter-spacing:1px;opacity:.82'>PR REPUTATION & PR MONITORING</div>
  <h1 style='font-size:25px;line-height:1.35;margin:8px 0 4px'>PR 데일리 브리프</h1>
  <div style='font-size:13px;opacity:.9'>$(Html $report.period)</div>
</td></tr>
<tr><td style='padding:24px 26px;background:#fffaf5;border-radius:0 0 14px 14px'>
  <h2 style='font-size:15px;margin:0 0 9px;color:#7b3f2e'>오늘의 요약</h2>
  <p style='font-size:14px;line-height:1.75;margin:0 0 16px'>$(Html $report.executiveSummary)</p>
  <table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='margin:0 0 18px'><tr>
    <td width='32%' style='padding:12px;background:#f3eee8;border-radius:9px;text-align:center'><div style='font-size:22px;font-weight:800;color:#51382f'>$totalCount</div><div style='font-size:11px;color:#74665d'>전체 이슈</div></td>
    <td width='2%'></td><td width='32%' style='padding:12px;background:#fff3d6;border-radius:9px;text-align:center'><div style='font-size:22px;font-weight:800;color:#8a6100'>$importantCount</div><div style='font-size:11px;color:#74665d'>중요도 높음</div></td>
    <td width='2%'></td><td width='32%' style='padding:12px;background:#fee4e2;border-radius:9px;text-align:center'><div style='font-size:22px;font-weight:800;color:#b42318'>$reputationAttentionCount</div><div style='font-size:11px;color:#74665d'>평판 주의 이슈</div></td>
  </tr></table>
  <div>$($coverage -join '')</div>
</td></tr>
<tr><td style='height:22px'></td></tr>
$primaryReputationBlock
<tr><td id='primary-news'>
  <div style='font-size:16px;font-weight:800;color:#51382f;margin:14px 0 10px'>언론보도 · $($primaryOfficialPr.Count)개 이슈(콘텐츠 $($primaryOfficialPrArticleCount)건)</div>
  $primaryOfficialPrContent
  <div style='font-size:16px;font-weight:800;color:#51382f;margin:22px 0 10px'>온라인 게시글 · $($primaryUnofficialPr.Count)개 이슈(게시글 $($primaryUnofficialPrArticleCount)건)</div>
  $primaryUnofficialPrContent
</td></tr>
$(if ($env:PAPR_PR_ONLY -ne '1') { @"
<tr><td style='height:26px'></td></tr>
<tr><td id='competitor-news'>
  <table role='presentation' width='100%' cellspacing='0' cellpadding='0' style='margin:0 0 12px'><tr><td style='font-size:20px;font-weight:800;color:#7b3f2e'>경쟁사·유사기업 기사</td><td align='right' style='font-size:13px;color:#7a746e'>$competitorIssueCount개 이슈(기사 $competitorArticleCount건)</td></tr></table>
  $competitorContent
</td></tr>
<tr><td style='height:8px'></td></tr>
$insightBlock
"@ } else { '' })
<tr><td style='padding:12px 8px;text-align:center;color:#857c75;font-size:11px'>여러 검색 경로로 후보를 확인하고 접근 가능한 원문과 발행 시각을 대조<br>자동 분석 결과는 중요한 의사결정 전에 원문을 확인해 주세요.</td></tr>
</table></td></tr></table></body></html>
"@

$mail = [System.Net.Mail.MailMessage]::new()
$mail.From = [System.Net.Mail.MailAddress]::new($settings.sender, 'PR 모니터링', [Text.Encoding]::UTF8)
foreach ($recipient in $recipients) { $mail.To.Add([string]$recipient) }
$prefix = if ($Test) { '[테스트] ' } elseif ($env:PAPR_RECIPIENT_OVERRIDE) { '[공유] ' } else { '' }
$mail.Subject = "$prefixPR 브리핑 - $($report.period)"
if ($Test -and -not $mail.Subject.StartsWith('[테스트]', [System.StringComparison]::Ordinal)) {
  $mail.Subject = "[테스트] $($mail.Subject.TrimStart())"
}
if ($Test -and -not $mail.Subject.StartsWith('[테스트]', [System.StringComparison]::Ordinal)) {
  throw '테스트 메일 제목에 [테스트] 표시가 없어 발송을 중단합니다.'
}
$mail.Body = $body
$mail.IsBodyHtml = $true
$mail.BodyEncoding = [Text.Encoding]::UTF8
$mail.SubjectEncoding = [Text.Encoding]::UTF8
$smtpPayload = @{
  host = [string]$settings.smtpHost
  port = [int]$settings.smtpPort
  sender = [string]$settings.sender
  password = $credential.GetNetworkCredential().Password
  recipients = @($recipients)
  subject = [string]$mail.Subject
  html = [string]$mail.Body
} | ConvertTo-Json -Depth 8 -Compress
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$smtpHelper = Join-Path $PSScriptRoot 'send-smtp-email.mjs'
$processInfo = [Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $nodePath
$processInfo.Arguments = '"' + $smtpHelper.Replace('"', '\"') + '"'
$processInfo.RedirectStandardInput = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$processInfo.UseShellExecute = $false
$smtpProcess = [Diagnostics.Process]::Start($processInfo)
try {
  $payloadBytes = [Text.Encoding]::UTF8.GetBytes($smtpPayload)
  $smtpProcess.StandardInput.BaseStream.Write($payloadBytes, 0, $payloadBytes.Length)
  $smtpProcess.StandardInput.BaseStream.Flush()
  $smtpProcess.StandardInput.Close()
  $smtpOutput = $smtpProcess.StandardOutput.ReadToEnd()
  $smtpError = $smtpProcess.StandardError.ReadToEnd()
  $smtpProcess.WaitForExit()
  if ($smtpProcess.ExitCode -ne 0) { throw "SMTP 발송 실패: $($smtpError.Trim())" }
} finally { $smtpProcess.Dispose(); $mail.Dispose() }
if (-not $Test -and -not $env:PAPR_RECIPIENT_OVERRIDE) {
  $recorder = Join-Path $PSScriptRoot 'record-team-brief.mjs'
  & node $recorder
  if ($LASTEXITCODE -ne 0) { throw '메일은 발송됐지만 팀 발송본을 PR 히스토리에 저장하지 못했습니다.' }
}
Write-Output "Sent=$($recipients -join ',') Test=$Test Subject=$($mail.Subject) Articles=$($report.articles.Count)"
