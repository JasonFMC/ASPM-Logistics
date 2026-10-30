const KINDS: Array<{ color: string; extensions: string[]; types?: RegExp }> = [
  { color: '#d93025', extensions: ['pdf'], types: /^application\/pdf$/ },
  { color: '#2b579a', extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt'], types: /wordprocessing|msword/ },
  { color: '#217346', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'], types: /spreadsheet|ms-excel|text\/csv/ },
  { color: '#c43e1c', extensions: ['ppt', 'pptx', 'pps', 'ppsx', 'odp'], types: /presentation|powerpoint/ },
  { color: '#0078d4', extensions: ['eml', 'msg', 'ics'], types: /^message\/|ms-outlook|text\/calendar/ },
  { color: '#8e44ad', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tif', 'tiff', 'svg'], types: /^image\// },
  { color: '#b7791f', extensions: ['zip', 'rar', '7z', 'gz', 'tar'], types: /zip|rar|7z|compressed|tar/ },
  { color: '#0f766e', extensions: ['mp3', 'wav', 'm4a', 'mp4', 'mov', 'avi'], types: /^(audio|video)\// },
]

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function MailFileIcon({ name, type }: { name: string; type: string }) {
  const extension = extensionOf(name)
  const kind =
    KINDS.find((item) => item.extensions.includes(extension)) ?? KINDS.find((item) => item.types?.test(type))
  const label = (extension || type.split('/')[1] || 'file').slice(0, 4).toUpperCase()
  return (
    <svg className="mail-file-icon" viewBox="0 0 32 40" aria-hidden="true">
      <path d="M3 1h18l8 8v28a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="#fff" stroke="#cbd5e1" />
      <path d="M21 1v6a2 2 0 0 0 2 2h6" fill="#f1f5f9" stroke="#cbd5e1" />
      <rect x="0" y="20" width="26" height="12" rx="2" fill={kind?.color ?? '#64748b'} />
      <text x="13" y="29" textAnchor="middle" fontSize={label.length > 3 ? 6.5 : 8} fontWeight="700" fill="#fff">
        {label}
      </text>
    </svg>
  )
}
