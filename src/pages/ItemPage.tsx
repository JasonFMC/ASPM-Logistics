import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { compressImage } from '../lib/images'
import { shipItem } from '../lib/items'
import { photoPublicUrl, supabase } from '../lib/supabase'
import type { Item, ItemStatus, Location, Movement, Photo } from '../lib/types'
import { ITEM_STATUS_LABEL } from '../lib/types'

export function ItemPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const { user } = useAuth()

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState<ItemStatus>('in_yard')
  const [locationId, setLocationId] = useState(params.get('location') ?? '')
  const [locations, setLocations] = useState<Location[]>([])
  const [item, setItem] = useState<Item | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [siteId, setSiteId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const { data: site } = await supabase.from('sites').select('id').limit(1).maybeSingle()
      if (site) setSiteId(site.id)

      const { data: locs } = await supabase
        .from('locations')
        .select('*, areas(code, name, color)')
        .order('code')
      setLocations((locs as Location[]) ?? [])
    })()
  }, [])

  useEffect(() => {
    if (isNew || !id) return
    void (async () => {
      const { data, error: itemError } = await supabase
        .from('items')
        .select('*, locations(*, areas(code, name))')
        .eq('id', id)
        .maybeSingle()
      if (itemError || !data) {
        setError(itemError?.message ?? '货物不存在')
        return
      }
      const row = data as Item
      setItem(row)
      setCode(row.code)
      setName(row.name ?? '')
      setDescription(row.description ?? '')
      setNotes(row.notes ?? '')
      setStatus(row.status)
      setLocationId(row.location_id ?? '')

      const { data: photoRows } = await supabase
        .from('photos')
        .select('*')
        .eq('item_id', id)
        .order('created_at', { ascending: false })
      setPhotos((photoRows as Photo[]) ?? [])

      const { data: moveRows } = await supabase
        .from('movements')
        .select('*')
        .eq('item_id', id)
        .order('created_at', { ascending: false })

      const moves = (moveRows as Movement[]) ?? []
      const locIds = [
        ...new Set(
          moves.flatMap((m) => [m.from_location_id, m.to_location_id]).filter(Boolean) as string[],
        ),
      ]
      let locMap = new Map<string, { code: string; label: string | null }>()
      if (locIds.length) {
        const { data: locRows } = await supabase.from('locations').select('id, code, label').in('id', locIds)
        locMap = new Map((locRows ?? []).map((l) => [l.id, { code: l.code, label: l.label }]))
      }
      setMovements(
        moves.map((m) => ({
          ...m,
          from_location: m.from_location_id ? locMap.get(m.from_location_id) ?? null : null,
          to_location: m.to_location_id ? locMap.get(m.to_location_id) ?? null : null,
        })),
      )
    })()
  }, [id, isNew])

  async function uploadPhotos(itemId: string, files: FileList | null) {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      const compressed = await compressImage(file)
      const path = `${itemId}/${crypto.randomUUID()}.jpg`
      const { error: upError } = await supabase.storage.from('photos').upload(path, compressed, {
        contentType: 'image/jpeg',
        upsert: false,
      })
      if (upError) throw upError
      const { error: rowError } = await supabase.from('photos').insert({
        item_id: itemId,
        storage_path: path,
      })
      if (rowError) throw rowError
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault()
    if (!siteId || !user) return
    setBusy(true)
    setError(null)

    try {
      if (isNew) {
        const { data, error: insertError } = await supabase
          .from('items')
          .insert({
            site_id: siteId,
            code: code.trim(),
            name: name.trim() || null,
            description: description.trim() || null,
            notes: notes.trim() || null,
            status,
            location_id: locationId || null,
          })
          .select('*')
          .single()
        if (insertError) throw insertError

        await supabase.from('movements').insert({
          item_id: data.id,
          from_location_id: null,
          to_location_id: locationId || null,
          movement_type: 'inbound',
          operator_id: user.id,
          notes: '新建入库',
        })

        navigate(`/item/${data.id}`, { replace: true })
      } else if (item) {
        const prevLocation = item.location_id
        const nextLocation = locationId || null

        const { error: updateError } = await supabase
          .from('items')
          .update({
            code: code.trim(),
            name: name.trim() || null,
            description: description.trim() || null,
            notes: notes.trim() || null,
            status,
            location_id: nextLocation,
          })
          .eq('id', item.id)
        if (updateError) throw updateError

        if (prevLocation !== nextLocation) {
          await supabase.from('movements').insert({
            item_id: item.id,
            from_location_id: prevLocation,
            to_location_id: nextLocation,
            movement_type: 'move',
            operator_id: user.id,
          })
        }

        // reload
        navigate(0)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function onPhotoChange(files: FileList | null) {
    if (!item || !files?.length) return
    setBusy(true)
    setError(null)
    try {
      await uploadPhotos(item.id, files)
      navigate(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  async function onShip() {
    if (!item || !user) return
    if (!confirm(`确认运走 ${item.code}？将清空位置并删除相关照片。`)) return
    setBusy(true)
    try {
      await shipItem(item, user.id)
      navigate('/yard/search')
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <button type="button" className="btn ghost" onClick={() => navigate(-1)}>
          返回
        </button>
        <h1>{isNew ? '新增货物' : code}</h1>
      </div>

      <form className="stack-form" onSubmit={onSave}>
        <label>
          货物编号 *
          <input value={code} onChange={(e) => setCode(e.target.value)} required placeholder="如 m1111" />
        </label>
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          描述
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </label>
        <label>
          位置
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">未绑定</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.code}
                {loc.label ? ` · ${loc.label}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
            {(Object.keys(ITEM_STATUS_LABEL) as ItemStatus[]).map((key) => (
              <option key={key} value={key}>
                {ITEM_STATUS_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          备注
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </form>

      {!isNew && item && (
        <>
          <section className="section">
            <h2>照片</h2>
            <label className="btn secondary">
              拍照 / 上传
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                hidden
                onChange={(e) => void onPhotoChange(e.target.files)}
              />
            </label>
            <div className="photo-grid">
              {photos.map((p) => (
                <a key={p.id} href={photoPublicUrl(p.storage_path)} target="_blank" rel="noreferrer">
                  <img src={photoPublicUrl(p.storage_path)} alt="" />
                </a>
              ))}
            </div>
            {photos.length === 0 && <p className="muted">暂无照片</p>}
          </section>

          <section className="section">
            <h2>移动历史</h2>
            <ul className="timeline">
              {movements.map((m) => (
                <li key={m.id}>
                  <time>{new Date(m.created_at).toLocaleString()}</time>
                  <div>
                    {m.movement_type} · {m.from_location?.code ?? '—'} → {m.to_location?.code ?? '—'}
                    {m.notes ? ` · ${m.notes}` : ''}
                  </div>
                </li>
              ))}
            </ul>
            {movements.length === 0 && <p className="muted">暂无记录</p>}
          </section>

          {item.locations && (
            <Link className="btn secondary block" to={`/yard?loc=${item.locations.id}`}>
              在地图查看
            </Link>
          )}

          {item.status !== 'shipped' && (
            <button type="button" className="btn danger block" disabled={busy} onClick={() => void onShip()}>
              运走并删除照片
            </button>
          )}
        </>
      )}
    </div>
  )
}
