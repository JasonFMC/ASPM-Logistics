import { useFolders } from '../context/FolderContext'

export function TicketTitle({
  ticketId,
  title,
  done = false,
  colleagues = [],
}: {
  ticketId: string
  title: string
  done?: boolean
  colleagues?: string[]
}) {
  const { namesByTicket } = useFolders()
  const names = namesByTicket.get(ticketId) ?? []
  const people = [...new Set(colleagues.map((name) => name.trim()).filter(Boolean))]
  return (
    <>
      {title}
      {names.map((item) => (
        <span key={`${item.kind}-${item.name}`} className={item.kind === 'customer' ? 'customer-tag' : 'folder-tag'}>
          {item.name}
        </span>
      ))}
      {!done &&
        people.map((name) => (
          <span key={name} className="claim-tag">
            {name}
          </span>
        ))}
      {done && <span className="done-tag">完成</span>}
      {done &&
        people.map((name) => (
          <span key={name} className="done-tag">
            {name}
          </span>
        ))}
    </>
  )
}
