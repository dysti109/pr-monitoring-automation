$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $projectDir 'config'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

Write-Host '메일 발송 계정과 수신 주소를 입력하세요. Gmail은 앱 비밀번호를 사용하세요.' -ForegroundColor Yellow
$sender = (Read-Host '발신 이메일 주소').Trim()
$teamText = Read-Host '팀 수신 주소 (쉼표 또는 세미콜론으로 구분)'
$recipients = @($teamText -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $sender -or -not $recipients.Count) { throw '발신 주소와 팀 수신 주소가 필요합니다.' }
$testRecipient = (Read-Host "테스트 수신 주소 [$($recipients[0])]" ).Trim()
if (-not $testRecipient) { $testRecipient = $recipients[0] }
$noticeRecipient = (Read-Host "오류 알림 수신 주소 [$testRecipient]" ).Trim()
if (-not $noticeRecipient) { $noticeRecipient = $testRecipient }
$securePassword = Read-Host '메일 앱 비밀번호' -AsSecureString
if ($securePassword.Length -eq 0) { throw '앱 비밀번호가 입력되지 않았습니다.' }

$settings = [ordered]@{
  smtpHost = 'smtp.gmail.com'
  smtpPort = 587
  sender = $sender
  recipients = $recipients
  testRecipient = $testRecipient
  noticeRecipient = $noticeRecipient
  sendTimeKst = '10:01'
}
$settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configDir 'email-settings.local.json') -Encoding utf8
$securePassword | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $configDir 'gmail-app-password.local.txt') -Encoding ascii
Write-Host '설정이 현재 Windows 사용자 계정으로 암호화되어 저장되었습니다.' -ForegroundColor Green
Read-Host '창을 닫으려면 Enter'
