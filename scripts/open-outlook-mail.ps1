# Opens one warehouse message in the desktop Outlook already signed into that mailbox.
# The browser only passes aspm-mail:<message-id>. This script never takes a shell command.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Raw
)

$ErrorActionPreference = 'Stop'

function Show-Note([string]$text) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($text, 'ASPM Workshop') | Out-Null
}

$Raw = $Raw.Trim().Trim('"')
if ($Raw -notmatch '^aspm-mail:(.*)$') {
  Show-Note 'This link is not an ASPM mail link.'
  exit 1
}

$id = [Uri]::UnescapeDataString($Matches[1]).Trim()
if ($id.Length -lt 3 -or $id.Length -gt 500 -or $id -notmatch '@' -or $id -match '[\r\n"]') {
  Show-Note 'This mail id cannot be opened.'
  exit 1
}
if ($id.StartsWith('<') -eq $false) { $id = '<' + $id.TrimEnd('>') + '>' }
$safe = $id.Replace("'", "''")
$filter = "@SQL=""http://schemas.microsoft.com/mapi/proptag/0x1035001F"" = '$safe'"

function Find-Mail($folder, [int]$depth) {
  if ($null -eq $folder -or $depth -gt 6) { return $null }
  try {
    $items = $folder.Items.Restrict($filter)
    if ($items.Count -gt 0) { return $items.GetFirst() }
  } catch {
    # Some folders do not support this filter. Keep walking.
  }
  foreach ($sub in @($folder.Folders)) {
    $hit = Find-Mail $sub ($depth + 1)
    if ($null -ne $hit) { return $hit }
  }
  return $null
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $session = $outlook.GetNamespace('MAPI')
} catch {
  Show-Note 'Outlook did not start. Open Outlook, wait until the warehouse mailbox is synced, then try again.'
  exit 1
}

foreach ($store in @($session.Stores)) {
  $inbox = $null
  try { $inbox = $store.GetDefaultFolder(6) } catch { continue }
  $hit = Find-Mail $inbox 0
  if ($null -ne $hit) {
    $folder = $null
    try { $folder = $hit.Parent } catch { $folder = $null }
    if ($null -ne $folder) {
      try {
        $explorer = $folder.GetExplorer()
        $explorer.Display()
        try {
          $explorer.ClearSelection()
          $explorer.AddToSelection($hit)
        } catch {
          if ($hit.Sent) { $hit.Display() }
        }
        $explorer.Activate() | Out-Null
        exit 0
      } catch {
        if ($hit.Sent) {
          $hit.Display()
          exit 0
        }
      }
    }
  }
}

Show-Note 'Outlook does not have this message yet. Confirm the warehouse mailbox is in Outlook and the inbox has finished syncing.'
exit 1
