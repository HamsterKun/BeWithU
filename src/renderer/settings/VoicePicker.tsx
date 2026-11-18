import { useMemo, useRef, useState } from 'react'
import { VOICE_CATALOG, type VoiceEntry } from '@shared/voices'

function guessResource(id: string): string {
  if (id.startsWith('S_')) return 'seed-icl-2.0'
  if (id.includes('uranus')) return 'seed-tts-2.0'
  return 'volc.service_type.10029'
}

/** 音色版本标签：面向用户的说法，不暴露内部代号 */
function tagLabel(tag: string): string {
  if (tag === 'ICL') return '复刻'
  return tag
}

export function VoicePicker(props: {
  speaker: string
  onSelect: (speaker: string, resourceId: string) => void
  onPreview: (speaker: string, resourceId: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [previewing, setPreviewing] = useState('')
  const blurTimer = useRef<number | null>(null)

  const selected = useMemo(
    () => VOICE_CATALOG.find((v) => v.id === props.speaker),
    [props.speaker]
  )

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? VOICE_CATALOG.filter(
          (v) =>
            v.name.toLowerCase().includes(q) ||
            v.id.toLowerCase().includes(q) ||
            v.group.includes(query.trim())
        )
      : VOICE_CATALOG
    return list.slice(0, 120)
  }, [query])

  const pick = (v: VoiceEntry): void => {
    props.onSelect(v.id, v.resourceId)
    setOpen(false)
    setQuery('')
  }

  const commitCustom = (): void => {
    const id = query.trim()
    if (!id) return
    props.onSelect(id, guessResource(id))
    setOpen(false)
    setQuery('')
  }

  const preview = (v: VoiceEntry | { id: string; name: string; resourceId: string }): void => {
    setPreviewing(v.id)
    props.onPreview(v.id, v.resourceId)
    window.setTimeout(() => setPreviewing(''), 2500)
  }

  const display = open ? query : selected ? selected.name : props.speaker

  return (
    <div className="voice-picker">
      <div className="voice-picker__field">
        <input
          className="input"
          value={display}
          placeholder="搜索音色，或输入音色 ID"
          spellCheck={false}
          onFocus={() => {
            if (blurTimer.current) window.clearTimeout(blurTimer.current)
            setOpen(true)
            setQuery('')
          }}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCustom()
            if (e.key === 'Escape') setOpen(false)
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 160)
          }}
        />
        <button className="mini-btn" type="button" onClick={() => preview(selected ?? { id: props.speaker, name: props.speaker, resourceId: guessResource(props.speaker) })}>
          {previewing === props.speaker ? '试听中…' : '试听'}
        </button>
      </div>
      <div className="voice-picker__hint">
        {selected ? (
          <>
            <b>{selected.name}</b> · {selected.group}
          </>
        ) : (
          <>
            自定义音色 <code>{props.speaker || '（未设置）'}</code>
          </>
        )}
      </div>

      {open ? (
        <div className="voice-list" onMouseDown={(e) => e.preventDefault()}>
          <div className="voice-list__head">
            <span>{query ? `匹配 ${results.length} 个` : `共 ${VOICE_CATALOG.length} 个音色`}</span>
            <span>回车使用输入的内容</span>
          </div>
          {results.map((v) => (
            <div
              key={v.id}
              className={v.id === props.speaker ? 'voice-row is-active' : 'voice-row'}
              onClick={() => pick(v)}
            >
              <span className="voice-row__name">{v.name}</span>
              <span className="voice-row__group">{v.group}</span>
              <span className={`voice-row__tag tag-${v.tag.replace('.', '')}`}>{tagLabel(v.tag)}</span>
              <span className="voice-row__id">{v.id}</span>
              <button
                type="button"
                className="voice-row__play"
                onClick={(e) => {
                  e.stopPropagation()
                  preview(v)
                }}
              >
                {previewing === v.id ? '▶ 播放中' : '▶ 试听'}
              </button>
            </div>
          ))}
          {results.length === 0 ? (
            <div className="voice-empty">没有匹配结果，回车使用「{query}」</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
