import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SecretPath, TestResult } from '@shared/types'

export function Section(props: { title: string; desc?: string; children: ReactNode }): React.ReactElement {
  return (
    <section className="section">
      <div className="section__head">
        <h3>{props.title}</h3>
        {props.desc ? <p>{props.desc}</p> : null}
      </div>
      <div className="section__body">{props.children}</div>
    </section>
  )
}

export function Field(props: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}): React.ReactElement {
  return (
    <div className={props.wide ? 'field field--wide' : 'field'}>
      <label className="field__label">
        {props.label}
        {props.hint ? <span className="field__hint">{props.hint}</span> : null}
      </label>
      <div className="field__control">{props.children}</div>
    </div>
  )
}

export function TextInput(props: {
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  placeholder?: string
  type?: string
  mono?: boolean
  list?: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <input
      className={props.mono ? 'input input--mono' : 'input'}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      list={props.list}
      disabled={props.disabled}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
    />
  )
}

export function TextArea(props: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}): React.ReactElement {
  return (
    <textarea
      className="textarea"
      rows={props.rows ?? 10}
      value={props.value}
      placeholder={props.placeholder}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
    />
  )
}

export function Select(props: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): React.ReactElement {
  return (
    <select className="input select" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.ReactElement {
  return (
    <div className="segmented" role="tablist">
      {props.options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={props.value === o.value}
          className={props.value === o.value ? 'segmented__item is-active' : 'segmented__item'}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Range(props: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}): React.ReactElement {
  return (
    <div className="range">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="range__value">{props.format ? props.format(props.value) : props.value}</span>
    </div>
  )
}

export function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): React.ReactElement {
  return (
    <button
      type="button"
      className={props.checked ? 'toggle is-on' : 'toggle'}
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="toggle__dot" />
      {props.label ? <span className="toggle__label">{props.label}</span> : null}
    </button>
  )
}

export function Btn(props: {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`btn btn--${props.variant ?? 'ghost'}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  )
}

export function NumberInput(props: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  suffix?: string
}): React.ReactElement {
  return (
    <div className="number">
      <input
        className="input input--num"
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={Number.isFinite(props.value) ? props.value : props.min}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) props.onChange(n)
        }}
      />
      {props.suffix ? <span className="number__suffix">{props.suffix}</span> : null}
    </div>
  )
}

export function SecretInput(props: {
  path: SecretPath
  saved: boolean
  onSave: (value: string) => void
  onClear: () => void
  placeholder?: string
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [flash, setFlash] = useState('')
  const stored = useRef('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  const toggle = async (): Promise<void> => {
    if (!revealed) {
      if (!value) {
        const plain = await window.bwu.settings.revealSecret(props.path)
        stored.current = plain
        setValue(plain)
      }
      setRevealed(true)
    } else {
      setRevealed(false)
    }
  }

  const commit = (): void => {
    const v = value.trim()
    if (!v || v === stored.current) return
    props.onSave(v)
    stored.current = v
    setFlash('已更新')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setFlash(''), 1800)
  }

  const clear = (): void => {
    props.onClear()
    stored.current = ''
    setValue('')
    setRevealed(false)
  }

  return (
    <div className="secret">
      <div className="secret__row">
        <input
          className="input input--mono"
          type={revealed ? 'text' : 'password'}
          value={value}
          placeholder={props.saved ? '已保存 · 输入新值可替换' : (props.placeholder ?? '未设置')}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          onBlur={commit}
        />
        <button className="mini-btn" type="button" onClick={() => void toggle()}>
          {revealed ? '隐藏' : '显示'}
        </button>
        {props.saved ? (
          <button className="mini-btn mini-btn--danger" type="button" onClick={clear}>
            清除
          </button>
        ) : null}
      </div>
      <span className={props.saved ? 'secret__state is-ok' : 'secret__state'}>
        {flash || (props.saved ? '已安全保存' : '尚未设置')}
      </span>
    </div>
  )
}

export function TestRow(props: {
  label: string
  onTest: () => Promise<TestResult>
  extra?: ReactNode
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await props.onTest()
      setResult(r)
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="test-row">
      <Btn onClick={() => void run()} disabled={busy}>
        {busy ? '测试中…' : props.label}
      </Btn>
      {props.extra}
      {result ? (
        <span className={result.ok ? 'badge badge--ok' : 'badge badge--bad'}>
          {result.ok ? '✓ ' : '✕ '}
          {result.message}
          {result.sample ? <em>「{result.sample}」</em> : null}
        </span>
      ) : null}
    </div>
  )
}
