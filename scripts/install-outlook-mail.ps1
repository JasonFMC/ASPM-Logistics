# One-time, current user only. Lets ASPM Workshop open the original message in desktop Outlook.
$ErrorActionPreference = 'Stop'

$destDir = Join-Path $env:LOCALAPPDATA 'ASPM Workshop'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$dest = Join-Path $destDir 'open-outlook-mail.ps1'
Copy-Item -Force (Join-Path $PSScriptRoot 'open-outlook-mail.ps1') $dest

$vbs = Join-Path $destDir 'open-outlook-mail.vbs'
$vbsBody = @(
  'Set sh = CreateObject("Wscript.Shell")'
  'If WScript.Arguments.Count = 0 Then WScript.Quit 1'
  ('cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & WScript.Arguments(0) & Chr(34)' -f $dest)
  'sh.Run cmd, 0, False'
) -join "`r`n"
Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII

$cmd = "wscript.exe `"$vbs`" `"%1`""
$base = 'HKCU:\Software\Classes\aspm-mail'
New-Item -Path $base -Force | Out-Null
Set-Item -Path $base -Value 'URL:ASPM Mail'
New-ItemProperty -Path $base -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$base\shell\open\command" -Force | Out-Null
Set-Item -Path "$base\shell\open\command" -Value $cmd

Write-Host "Installed for this Windows user."
Write-Host $dest
