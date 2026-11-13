import { useEffect, useRef } from 'react'

export function linesFromText(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return rows.length ? rows : ['']
}

export function textFromLines(rows: string[]) {
  return rows
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

export function RuleLines({
  label,
  hint,
  values,
  onChange,
  minus = false,
  saving = false,
  saved = false,
  onSave,
}: {
  label: string
  hint: string
  values: string[]
  onChange: (values: string[]) => void
  /** 左侧用减号删掉这一行，不再显示「去掉」。 */
  minus?: boolean
  saving?: boolean
  saved?: boolean
  onSave?: () => void
}) {
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const focusNext = useRef(false)

  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    inputs.current[values.length - 1]?.focus()
  }, [values.length])

  function change(index: number, value: string) {
    onChange(values.map((row, rowIndex) => (rowIndex === index ? value : row)))
  }

  function add() {
    focusNext.current = true
    onChange([...values, ''])
  }

  function remove(index: number) {
    const next = values.filter((_, rowIndex) => rowIndex !== index)
    onChange(next.length ? next : [''])
  }

  return (
    <div className="rule-lines">
      <div className="rule-lines-title">
        <span>{label}</span>
        {hint ? <p className="folder-hint">{hint}</p> : null}
      </div>
      <ul>
        {values.map((value, index) => (
          <li key={index}>
            {minus && (
              <button
                type="button"
                className="btn small rule-minus"
                aria-label="删掉这一条"
                disabled={values.length === 1 && !value.trim()}
                onClick={() => remove(index)}
              >
                −
              </button>
            )}
            <input
              ref={(node) => {
                inputs.current[index] = node
              }}
              value={value}
              maxLength={200}
              aria-label={`${label} ${index + 1}`}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault()
              }}
              onChange={(event) => change(index, event.target.value)}
            />
            {!minus && (
              <button
                type="button"
                className="btn small ghost rule-remove"
                aria-label="去掉这一条"
                disabled={values.length === 1 && !value.trim()}
                onClick={() => remove(index)}
              >
                去掉
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="rule-actions">
        <button type="button" className="btn small rule-add" aria-label={`再加一条${label}`} onClick={add}>
          +
        </button>
        {onSave && (
          <button type="button" className="btn small" disabled={saving} onClick={onSave}>
            {saving ? '保存中…' : '保存'}
          </button>
        )}
        {saved && <span className="rule-saved">已保存</span>}
      </div>
    </div>
  )
}
