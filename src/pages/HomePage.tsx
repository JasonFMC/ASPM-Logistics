import { Link } from 'react-router-dom'
import { platformModules } from '../platform/modules'

export function HomePage() {
  return (
    <div className="module-home">
      <p className="eyebrow">ASPM Workshop</p>
      <h1>选择板块</h1>
      <p className="lede">Tickets 和 YARD 是并列的子板块。之后新的板块也从这里进入。</p>
      <div className="module-grid">
        {platformModules.map((mod) => (
          <Link key={mod.id} className="module-card" to={mod.path}>
            <strong>{mod.name}</strong>
            <span>{mod.summary}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
