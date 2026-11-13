# Opens one warehouse message in desktop Outlook.
# The browser passes aspm-mail: plus a short-lived handoff. This script downloads
# that exact message from the mailbox and opens the file. It does not search Outlook.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Raw
)

$ErrorActionPreference = 'Stop'

function Show-Note([string]$text) {
  Add-Type -AssemblyName System.Windows.Forms
  $shown = $text
  if ($shown.Length -gt 400) { $shown = $shown.Substring(0, 400) }
  [System.Windows.Forms.MessageBox]::Show($shown, 'ASPM Workshop') | Out-Null
}

function Decode-B64Url([string]$text) {
  $padded = $text.Replace('-', '+').Replace('_', '/')
  switch ($padded.Length % 4) {
    2 { $padded += '==' }
    3 { $padded += '=' }
  }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($padded))
}

function Read-Failure($err) {
  $response = $err.Exception.Response
  if ($null -eq $response) { return $err.Exception.Message }
  try {
    $stream = $response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $text = $reader.ReadToEnd()
    $reader.Close()
    $parsed = $text | ConvertFrom-Json
    if ($parsed.error) { return [string]$parsed.error }
  } catch {}
  return 'The mailbox did not return this message.'
}

$Raw = $Raw.Trim().Trim('"')
if ($Raw -notmatch '^aspm-mail:(.*)$') {
  Show-Note 'This link is not an ASPM mail link.'
  exit 1
}

$payload = $Matches[1].Trim()
if ($payload -notmatch '^[A-Za-z0-9_-]{20,8000}$') {
  Show-Note 'This mail link is not valid.'
  exit 1
}
$json = $null
try {
  $json = Decode-B64Url $payload | ConvertFrom-Json
} catch {
  Show-Note 'This mail link is not valid.'
  exit 1
}

$url = [string]$json.url
$key = [string]$json.key
$token = [string]$json.token
if ($url -notmatch '^https://[a-z0-9-]+\.supabase\.co$') {
  Show-Note 'This mail link does not point at the workshop.'
  exit 1
}
if ($key -notmatch '^[A-Za-z0-9._-]{20,4000}$' -or $token -notmatch '^[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,200}$') {
  Show-Note 'This mail link is not valid.'
  exit 1
}

$dir = Join-Path $env:TEMP 'ASPM-Workshop'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Get-ChildItem -LiteralPath $dir -Filter '*.eml' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
$out = Join-Path $dir ([guid]::NewGuid().ToString('n') + '.eml')

$ProgressPreference = 'SilentlyContinue'
try {
  Invoke-WebRequest `
    -Uri ($url.TrimEnd('/') + '/functions/v1/mail-read') `
    -Method POST `
    -Headers @{ Authorization = "Bearer $key"; apikey = $key } `
    -ContentType 'application/json' `
    -Body (@{ handoffToken = $token } | ConvertTo-Json -Compress) `
    -OutFile $out `
    -UseBasicParsing `
    -TimeoutSec 180
} catch {
  Show-Note (Read-Failure $_)
  exit 1
}

$info = Get-Item -LiteralPath $out
$first = ''
$reader = New-Object System.IO.StreamReader($out)
try { $first = $reader.ReadLine() } finally { $reader.Dispose() }
if ($null -eq $first) { $first = '' }
if ($info.Length -lt 20 -or $first.StartsWith('{')) {
  Show-Note 'The mailbox did not return this message.'
  exit 1
}
Unblock-File -LiteralPath $out -ErrorAction SilentlyContinue

function Read-MessageId([string]$path) {
  $reader = New-Object System.IO.StreamReader($path)
  $id = ''
  $pending = ''
  try {
    while (-not $reader.EndOfStream) {
      $line = $reader.ReadLine()
      if ($null -eq $line -or $line -eq '') { break }
      if ($line.StartsWith(' ') -or $line.StartsWith("`t")) {
        $pending += ' ' + $line.Trim()
        continue
      }
      if ($pending -match '^(?i)Message-ID:\s*(.*)$') { $id = $Matches[1].Trim() }
      $pending = $line
    }
    if ($pending -match '^(?i)Message-ID:\s*(.*)$') { $id = $Matches[1].Trim() }
  } finally { $reader.Dispose() }
  return $id
}

function Find-Mail($folder, $filters, $depth) {
  if ($depth -gt 12) { return $null }
  foreach ($filter in $filters) {
    try {
      $hit = $folder.Items.Find($filter)
      if ($hit) { return $hit }
    } catch {}
  }
  foreach ($sub in @($folder.Folders)) {
    $hit = Find-Mail $sub $filters ($depth + 1)
    if ($hit) { return $hit }
  }
  return $null
}

$id = Read-MessageId $info.FullName
if (-not $id) {
  Show-Note 'This message has no id, so Outlook cannot locate it.'
  exit 1
}
$forms = @($id)
if ($id.StartsWith('<') -and $id.EndsWith('>')) {
  $forms += $id.Substring(1, $id.Length - 2)
} else {
  $forms += ('<' + $id + '>')
}
$filters = @()
foreach ($form in $forms) {
  $safe = $form.Replace("'", "''")
  $filters += "@SQL=""http://schemas.microsoft.com/mapi/proptag/0x1035001F"" = '$safe'"
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace('MAPI')
  $mail = $null
  foreach ($store in @($ns.Stores)) {
    try { $mail = Find-Mail $store.GetRootFolder() $filters 0 } catch { $mail = $null }
    if ($mail) { break }
  }
  if (-not $mail) {
    Show-Note 'Outlook is open, but this message is not in that mailbox.'
    exit 1
  }
  $mail.Display()
  exit 0
} catch {
  Show-Note ("Outlook could not open the message file.`r`n" + $_.Exception.Message)
  exit 1
}
