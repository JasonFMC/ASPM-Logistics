# Check the task mailbox over IMAP. The password stays in memory on this machine.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\test-imap.ps1
#
# Messages are ASCII on purpose: Windows PowerShell 5.1 reads a UTF-8 script
# as ANSI and mangles non-ASCII text.

param(
  [string]$ImapHost = 'mail.aspmlogistics.com.au',
  [int]$Port = 993,
  [string]$User = 'warehouse@aspmlogistics.com.au'
)

$secure = Read-Host "Password for $User" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
)

function Read-Reply($reader, $tag) {
  $lines = @()
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    $lines += $line
    if ($line -match "^$tag (OK|NO|BAD)") { break }
  }
  return $lines
}

$client = $null
try {
  Write-Host "Connecting to ${ImapHost}:${Port} ..."
  $client = New-Object Net.Sockets.TcpClient
  $client.Connect($ImapHost, $Port)
  $stream = New-Object Net.Security.SslStream($client.GetStream(), $false)
  $stream.AuthenticateAsClient($ImapHost)

  $reader = New-Object IO.StreamReader($stream)
  $writer = New-Object IO.StreamWriter($stream)
  $writer.AutoFlush = $true

  Write-Host "Greeting: $($reader.ReadLine())"

  # IMAP quoted strings need \ and " escaped.
  $escaped = $plain.Replace('\', '\\').Replace('"', '\"')
  $writer.WriteLine("a1 LOGIN `"$User`" `"$escaped`"")
  $login = Read-Reply $reader 'a1'
  $login | ForEach-Object { Write-Host $_ }

  if ($login[-1] -notmatch '^a1 OK') {
    Write-Host ''
    Write-Host 'LOGIN FAILED. Wrong password, or this host wants an app-specific password.' -ForegroundColor Yellow
    return
  }

  $writer.WriteLine('a2 EXAMINE INBOX')
  Read-Reply $reader 'a2' | ForEach-Object { Write-Host $_ }
  $writer.WriteLine('a3 LOGOUT')

  Write-Host ''
  Write-Host 'LOGIN OK. Use this password for IMAP_PASSWORD in Supabase Secrets.' -ForegroundColor Green
  Write-Host 'The EXISTS line above is how many messages are in the inbox.'
} catch {
  Write-Host "CONNECTION FAILED: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  $plain = $null
  if ($client) { $client.Close() }
}
