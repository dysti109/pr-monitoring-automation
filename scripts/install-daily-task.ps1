$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-daily-brief.ps1'
$precollector = Join-Path $PSScriptRoot 'precollect-daily-brief.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $projectDir
$precollectAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$precollector`" -SearchPass 1" -WorkingDirectory $projectDir
$precollectAction2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$precollector`" -SearchPass 2" -WorkingDirectory $projectDir
$precollectAction3 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$precollector`" -SearchPass 3" -WorkingDirectory $projectDir
$firstRunDate = (Get-Date).Date.AddDays(1)
$trigger = New-ScheduledTaskTrigger -Daily -At ($firstRunDate.AddHours(10).AddMinutes(1))
$precollectTrigger = New-ScheduledTaskTrigger -Daily -At ($firstRunDate.AddHours(9).AddMinutes(5))
$precollectTrigger2 = New-ScheduledTaskTrigger -Daily -At ($firstRunDate.AddHours(9).AddMinutes(25))
$precollectTrigger3 = New-ScheduledTaskTrigger -Daily -At ($firstRunDate.AddHours(9).AddMinutes(50))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName 'PrMonitoringDailyBrief' -Action $action -Trigger $trigger -Settings $settings -Description '매일 지정 기간의 PR 분석 후 설정된 테스트 수신자에게 발송.' -Force | Out-Null
Register-ScheduledTask -TaskName 'PrMonitoringDailyPrecollection' -Action $precollectAction -Trigger $precollectTrigger -Settings $settings -Description '매일 09:05 KST 1차 PR 후보 사전 수집. 메일 발송 없음.' -Force | Out-Null
Register-ScheduledTask -TaskName 'PrMonitoringDailyPrecollectionPass2' -Action $precollectAction2 -Trigger $precollectTrigger2 -Settings $settings -Description '매일 09:25 KST 2차 제품·서비스·고객사 관련 후보 사전 수집. 메일 발송 없음.' -Force | Out-Null
Register-ScheduledTask -TaskName 'PrMonitoringDailyPrecollectionPass3' -Action $precollectAction3 -Trigger $precollectTrigger3 -Settings $settings -Description '매일 09:50 KST 3차 표기 변형·확장 검색 후보 사전 수집. 메일 발송 없음.' -Force | Out-Null
Write-Output 'Scheduled=PrMonitoringDailyPrecollection Time=09:05 KST Pass=1 SearchOnly=True'
Write-Output 'Scheduled=PrMonitoringDailyPrecollectionPass2 Time=09:25 KST Pass=2 SearchOnly=True'
Write-Output 'Scheduled=PrMonitoringDailyPrecollectionPass3 Time=09:50 KST Pass=3 SearchOnly=True'
Write-Output 'Scheduled=PrMonitoringDailyBrief Time=10:01 KST Window=Monday:PreviousFriday10:00-To-Today10:00;OtherDays:PreviousDay10:00-To-Today10:00 TestOnly=True'
