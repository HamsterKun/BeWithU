import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicSettings, SettingsPatch } from '@shared/types'
import ModelPane from './panes/ModelPane'
import VoicePane from './panes/VoicePane'
import BallPane from './panes/BallPane'
import PromptPane from './panes/PromptPane'
import HotkeyPane from './panes/HotkeyPane'
import AboutPane from './panes/AboutPane'
import AgentPane from './panes/AgentPane'
import ContextPane from './panes/ContextPane'
import DataPane from './panes/DataPane'
import UpdateBanner from './UpdateBanner'

type Tab = 'model' | 'context' | 'voice' | 'ball' | 'prompt' | 'agent' | 'hotkey' | 'data' | 'about'

const TABS: { id: Tab; label: string; title: string; icon: string }[] = [
  { id: 'model', label: '大模型', title: '大模型', icon: 'M8 1.4l1.7 4.6 4.6 1.7-4.6 1.7L8 14l-1.7-4.6L1.7 7.7l4.6-1.7z' },
  { id: 'context', label: '上下文', title: '上下文管理', icon: 'M2 3.2h12v2.2H2zm0 3.7h12v2.2H2zm0 3.7h8v2.2H2z' },
  { id: 'voice', label: '语音', title: '语音合成与识别', icon: 'M8 1.6a2.4 2.4 0 0 1 2.4 2.4v3.4a2.4 2.4 0 1 1-4.8 0V4A2.4 2.4 0 0 1 8 1.6zM3.4 7.2v.4a4.6 4.6 0 0 0 9.2 0v-.4h1.2v.4a5.8 5.8 0 0 1-5.2 5.75V15H7.4v-1.65A5.8 5.8 0 0 1 2.2 7.6v-.4z' },
  { id: 'ball', label: '悬浮球', title: '悬浮球与气泡', icon: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zm0 1.6a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6z' },
  { id: 'prompt', label: '人格提示词', title: '人格提示词', icon: 'M3 3.2h10v1.4H3zm0 3.2h10v1.4H3zm0 3.2h6.4v1.4H3zM3 12.8h8.4v1.4H3z' },
  { id: 'agent', label: 'Agent 能力', title: 'Agent 能力', icon: 'M8 2.2a1.3 1.3 0 0 1 1.3 1.3v1h1.5A2.2 2.2 0 0 1 13 6.7v1.6h1V9.7h-1v1.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 11.3V9.7H2V8.3h1V6.7a2.2 2.2 0 0 1 2.2-2.2h1.5v-1A1.3 1.3 0 0 1 8 2.2Zm-2 5.1v1.4h1.4V7.3Zm2.6 0v1.4H10V7.3Z' },
  { id: 'hotkey', label: '快捷键', title: '开麦键', icon: 'M1.6 4.4h12.8v7.2H1.6zM3.2 6h1.6v1.4H3.2zm2.6 0H7.4v1.4H5.8zm2.6 0h1.6v1.4H8.4zm2.6 0h1.6v1.4h-1.6zM4.4 8.6h7.2v1.4H4.4z' },
  { id: 'data', label: '数据与日志', title: '数据与日志', icon: 'M2 2.6h12v2.2H2zm0 4.3h12v2.2H2zm0 4.3h12v2.2H2z' },
  { id: 'about', label: '关于', title: '关于与隐私', icon: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zM7.2 4.6h1.6v1.6H7.2zm0 2.8h1.6v4H7.2z' }
]

function merge<T>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null) return base
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const prev = out[k]
    out[k] =
      typeof v === 'object' && v !== null && !Array.isArray(v) && typeof prev === 'object' && prev !== null
        ? merge(prev, v)
        : v
  }
  return out as unknown as T
}

function Icon({ d }: { d: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path d={d} fill="currentColor" />
    </svg>
  )
}

export default function Settings(): React.ReactElement {
  const [s, setS] = useState<PublicSettings | null>(null)
  const [tab, setTab] = useState<Tab>('model')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const pending = useRef<SettingsPatch>({})
  const timer = useRef<number | null>(null)
  const saveRevision = useRef(0)

  useEffect(() => {
    void window.bwu.settings.get().then(setS)
    const offTab = window.bwu.settings.onFocusTab((t) => {
      if (TABS.some((x) => x.id === t)) setTab(t as Tab)
    })
    // 托盘静音、气泡「清空上下文」等外部改动也要回显；
    // 本地还有未提交的编辑时不整块覆盖，只同步密钥状态。
    const offChanged = window.bwu.settings.onChanged((next) => {
      if (Object.keys(pending.current).length === 0) setS(next)
      else setS((prev) => (prev ? { ...prev, secretSet: next.secretSet } : next))
    })
    return () => {
      offTab()
      offChanged()
    }
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const p = pending.current
    if (Object.keys(p).length === 0) return
    pending.current = {}
    const revision = ++saveRevision.current
    setStatus('saving')
    try {
      const res = await window.bwu.settings.update(p)
      if (revision !== saveRevision.current) return
      setS((prev) => (prev ? { ...prev, secretSet: res.secretSet } : prev))
      setStatus('saved')
      window.setTimeout(() => {
        if (revision === saveRevision.current) setStatus('idle')
      }, 1400)
    } catch {
      pending.current = merge(p, pending.current)
      if (revision === saveRevision.current) setStatus('error')
      return
    }
    if (Object.keys(pending.current).length) window.setTimeout(() => void flush(), 0)
  }, [])

  const patch = useCallback(
    (p: SettingsPatch, immediate = false): void => {
      setS((prev) => (prev ? merge(prev, p) : prev))
      pending.current = merge(pending.current, p)
      if (immediate) {
        void flush()
      } else {
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => void flush(), 420)
      }
    },
    [flush]
  )

  if (!s) {
    return <div className="loading">正在加载设置…</div>
  }

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]
  const paneProps = { s, patch }

  return (
    <div className="app">
      <div className="titlebar" />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__logo" />
          <div className="brand__text">
            <b>BeWithU</b>
            <span>桌面语音伙伴</span>
          </div>
        </div>
        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'nav__item is-active' : 'nav__item'}
              onClick={() => setTab(t.id)}
            >
              <Icon d={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">
          <UpdateBanner />
          <button
            className="nav__item theme-toggle"
            onClick={() => patch({ ui: { theme: s.ui.theme === 'dark' ? 'light' : 'dark' } }, true)}
            title="切换亮色 / 暗色"
          >
            <span className="theme-toggle__icon">{s.ui.theme === 'dark' ? '☀' : '☾'}</span>
            {s.ui.theme === 'dark' ? '亮色模式' : '暗色模式'}
          </button>
          <button className="nav__item" onClick={() => window.bwu.settings.openDataDir()}>
            <Icon d="M1.6 4.2h4.6l1.2 1.6h7v6.6H1.6z" />
            数据目录
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main__head">
          <h1>{current.title}</h1>
          <span className={`save-state${status === 'idle' ? '' : ' is-active'}${status === 'error' ? ' is-error' : ''}`}>
            {status === 'saving'
              ? '保存中…'
              : status === 'saved'
                ? '已保存'
                : status === 'error'
                  ? '保存失败，请检查磁盘空间或权限'
                  : '改动会自动保存'}
          </span>
        </header>
        <div className="main__body">
          {tab === 'model' ? <ModelPane {...paneProps} /> : null}
          {tab === 'context' ? <ContextPane {...paneProps} /> : null}
          {tab === 'voice' ? <VoicePane {...paneProps} /> : null}
          {tab === 'ball' ? <BallPane {...paneProps} /> : null}
          {tab === 'prompt' ? <PromptPane {...paneProps} /> : null}
          {tab === 'hotkey' ? <HotkeyPane {...paneProps} /> : null}
          {tab === 'agent' ? <AgentPane {...paneProps} /> : null}
          {tab === 'data' ? <DataPane {...paneProps} /> : null}
          {tab === 'about' ? <AboutPane {...paneProps} /> : null}
        </div>
      </main>
    </div>
  )
}
