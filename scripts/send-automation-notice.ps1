param(
  [Parameter(Mandatory=$true)][string]$Stage,
  [Parameter(Mandatory=$true)][string]$Message,
  [int]$Attempt = 1,
  [int]$MaxAttempts = 1,
  [switch]$Final
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $projectDir 'config\email-settings.local.json'
$passwordPath = Join-Path $projectDir 'config\gmail-app-password.local.txt'
if (!(Test-Path -LiteralPath $settingsPath) -or !(Test-Path -LiteralPath $passwordPath)) {
  throw '실패 알림 발송 설정을 찾지 못했습니다.'
}
$settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding utf8 | ConvertFrom-Json
$securePassword = (Get-Content -LiteralPath $passwordPath -Raw).Trim() | ConvertTo-SecureString
$credential = [pscredential]::new([string]$settings.sender, $securePassword)
$noticeRecipient = [string]$settings.noticeRecipient
if (-not $noticeRecipient) { $noticeRecipient = [string]$settings.testRecipient }
if (-not $noticeRecipient) { $noticeRecipient = [string](@($settings.recipients) | Select-Object -First 1) }
if (-not $noticeRecipient) { throw '오류 알림 수신 주소를 로컬 메일 설정에 입력하세요.' }
$recipients = @($noticeRecipient)
$status = if ($Final) { '재시도 후 최종 실패' } else { '자동 재시도 진행' }
$subject = "[PR 자동화 알림] $Stage - $status"
$safeStage = [System.Net.WebUtility]::HtmlEncode($Stage)
$safeMessage = [System.Net.WebUtility]::HtmlEncode($Message)
$kst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Korea Standard Time').ToString('yyyy-MM-dd HH:mm:ss')
$html = "<div style='font-family:Arial,sans-serif;line-height:1.7'><h2>PR 수집·분석 자동화 알림</h2><p><b>단계:</b> $safeStage</p><p><b>상태:</b> $status (시도 $Attempt/$MaxAttempts)</p><p><b>시각:</b> $kst KST</p><p><b>오류:</b><br>$($safeMessage -replace "`r?`n", '<br>')</p></div>"
$payload = @{
  host = [string]$settings.smtpHost
  port = [int]$settings.smtpPort
  sender = [string]$settings.sender
  password = $credential.GetNetworkCredential().Password
  recipients = $recipients
  subject = $subject
  html = $html
} | ConvertTo-Json -Depth 5 -Compress
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$helper = Join-Path $PSScriptRoot 'send-smtp-email.mjs'
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $nodePath
$info.Arguments = '"' + $helper.Replace('"', '\"') + '"'
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.UseShellExecute = $false
$process = [Diagnostics.Process]::Start($info)
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "알림 SMTP 발송 실패: $($stderr.Trim())" }
  Write-Output "NoticeSent=$($recipients -join ',') Stage=$Stage Final=$Final"
} finally { $process.Dispose() }
