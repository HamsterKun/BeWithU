import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BubbleNotice, Phase } from '@shared/types'
import type { BubbleUpdate } from '@shared/ipc'

interface State {
  phase: Phase
  note: string
  user: string
  userFinal: boolean
  assistant: string
  streaming: boolean
  notice: BubbleNotice | null
  pinned: boolean
  side: 'left' | 'right'
  name: string
  hotkey: string
  animKey: number
  step: { text: string; done: boolean; ok: boolean } | null
  approve: { id: string; title: string; detail: string } | null
}

const initial: State = {
  phase: 'idle',
  note: '',
  user: '',
  userFinal: false,
  assistant: '',
  streaming: false,
  notice: null,
  pinned: false,
  side: 'right',
  name: '小伴',
  hotkey: '开麦键',
  animKey: 0,
  step: null,
  approve: null
}

function reduce(state: State, u: BubbleUpdate): State {
  switch (u.type) {
    case 'phase':
      return {
        ...state,
        phase: u.phase,
        note: u.note ?? '',
        notice: u.phase === 'listening' ? null : state.notice,
        animKey: u.phase === 'listening' ? state.animKey + 1 : state.animKey
      }
    case 'user':
      return { ...state, user: u.text, userFinal: u.final }
    case 'assistant-reset':
      return { ...state, assistant: '', streaming: true, step: null, approve: null }
    case 'assistant-delta':
      return { ...state, assistant: state.assistant + u.text, streaming: true }
    case 'assistant-end':
      return { ...state, streaming: false }
    case 'notice':
      return { ...state, notice: u.notice }
    case 'pin':
      return { ...state, pinned: u.pinned }
    case 'anchor':
      return { ...state, side: u.side }
    case 'agent-step':
      return { ...state, step: { text: `${u.text}`, done: u.done, ok: u.ok === true } }
    case 'approve':
      return { ...state, approve: u.req }
    case 'meta':
      return { ...state, name: u.assistantName, hotkey: u.hotkey || state.hotkey }
    default:
      return state
  }
}

const clean = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, '［代码］')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]*)`/g, '$1')

export default function Bubble(): React.ReactElement {
  const [state, setState] = useState<State>(initial)
  const [draft, setDraft] = useState('')
  const cardRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const measureRef = useRef<(() => void) | null>(null)
  const lastSize = useRef<{ w: number; h: number } | null>(null)

  const report = useCallback((): void => {
    const el = cardRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 120 || rect.height < 40) return
    const w = Math.ceil(rect.width)
    const h = Math.ceil(rect.height)
    if (lastSize.current && lastSize.current.w === w && lastSize.current.h === h) return
    lastSize.current = { w, h }
    window.bwu.bubble.resize(w, h)
  }, [])

  useEffect(() => {
    const offUpdate = window.bwu.bubble.onUpdate((u) => setState((s) => reduce(s, u)))
    const offMeasure = window.bwu.bubble.onMeasure(() => {
      report()
      window.setTimeout(report, 120)
    })
    measureRef.current = report
    return () => {
      offUpdate()
      offMeasure()
    }
  }, [report])

  // 内容自适应窗口尺寸
  useLayoutEffect(() => {
    report()
    const ro = new ResizeObserver(report)
    if (cardRef.current) ro.observe(cardRef.current)
    // 窗口隐藏时 Chromium 会报 0 尺寸，这里用低频轮询兜底，确保尺寸最终收敛
    const timer = window.setInterval(() => {
      if (!document.hidden) report()
    }, 500)
    document.addEventListener('visibilitychange', report)
    return () => {
      ro.disconnect()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
    }
  }, [report])

  // 每次开始新的对话时让气泡"弹"一下
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    el.classList.remove('is-pop')
    void el.offsetWidth
    el.classList.add('is-pop')
  }, [state.animKey])

  // 自动滚到底部
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.assistant, state.user, state.notice])

  // 确认卡出现时把它滚进视野（不然会被"自动滚到底"顶出去）
  useEffect(() => {
    if (!state.approve) return
    const el = bodyRef.current?.querySelector('.approve')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [state.approve])

  // 点击输入框：窗口平时 focusable:false 不抢焦点，这里临时申请焦点再聚焦输入框
  const grabFocus = useCallback((): void => {
    window.bwu.bubble.requestFocus()
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }, [])

  const submit = useCallback((): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    window.bwu.bubble.submit(text)
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }, [draft])

  const stateText = useMemo(() => {
    if (state.note && state.phase !== 'idle') return state.note
    switch (state.phase) {
      case 'acting':
        return '工作中'
      case 'listening':
        return '正在听…'
      case 'thinking':
        return '思考中…'
      case 'speaking':
        return '正在说…'
      default:
        return state.notice ? '' : '待命中'
    }
  }, [state.phase, state.note, state.notice])

  const hasContent = Boolean(state.user || state.assistant)
  const assistantText = clean(state.assistant)

  const onStop = (): void => window.bwu.bubble.stop()
  const onClose = (): void => window.bwu.bubble.close()
  const onPin = (): void => window.bwu.bubble.pin(!state.pinned)

  return (
    <div className="bubble-root" data-side={state.side} data-phase={state.phase}>
      <div className="card" ref={cardRef}>
        <header className="card__head">
          <span className="pulse" data-phase={state.phase} />
          <span className="card__name">{state.name}</span>
          <span className="card__state">{stateText}</span>
          <div className="card__actions">
            <button
              className={state.pinned ? 'icon-btn active' : 'icon-btn'}
              title={state.pinned ? '取消固定' : '固定气泡'}
              onClick={onPin}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path
                  d="M9.6 1.8 14 6.2l-1.7.5-2.6 2.6.3 2.3-1.2 1.2-2.5-2.5-3 3-.7-.7 3-3L3.1 7.1 4.3 6l2.3.3L9.2 3.7l.4-1.9Z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <button className="icon-btn" title="关闭" onClick={onClose}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        <div className="card__body" ref={bodyRef}>
          {state.approve ? (
            <div className="approve">
              <span className="approve__title">需要你确认：{state.approve.title}</span>
              <pre className="approve__detail">{state.approve.detail}</pre>
              <div className="approve__actions">
                <button className="approve__ok" onClick={() => window.bwu.agent.approve(state.approve!.id, true)}>
                  允许
                </button>
                <button
                  className="approve__no"
                  onClick={() => window.bwu.agent.approve(state.approve!.id, false)}
                >
                  拒绝
                </button>
                <span className="approve__hint">也可以直接说“同意”</span>
              </div>
            </div>
          ) : null}
          {state.step ? (
            <div className="card__step" data-done={state.step.done} data-ok={state.step.ok}>
              <span className="card__step-dot" />
              <span className="card__step-text">
                {state.step.done ? (state.step.ok ? '已完成' : '失败') : '正在'}：{state.step.text}
              </span>
            </div>
          ) : null}

          {state.user ? (
            <div className="row row--user">
              <span className="row__label">你说</span>
              <p className="row__text">{state.user}</p>
            </div>
          ) : null}

          {assistantText ? (
            <div className="row row--ai">
              <span className="row__label">{state.name}</span>
              <p className="row__text row__text--ai">
                {assistantText}
                {state.streaming ? <span className="caret" /> : null}
              </p>
            </div>
          ) : null}

          {!hasContent && !state.notice ? (
            <div className="empty">
              <p>按住 {state.hotkey} 和我说句话</p>
              <span>也可以在下面的输入框里打字</span>
            </div>
          ) : null}

          {state.notice ? (
            <div className="notice" data-kind={state.notice.kind}>
              <span>{state.notice.text}</span>
              {state.notice.action ? (
                <button
                  onClick={() =>
                    window.bwu.settings.open(state.notice?.action === 'open-voice' ? 'voice' : undefined)
                  }
                >
                  去设置
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {state.phase !== 'listening' ? (
          <div className="composer">
            <input
              ref={inputRef}
              className="composer__input"
              value={draft}
              placeholder={`打字和${state.name}说话…`}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onPointerDown={grabFocus}
              onFocus={() => window.bwu.bubble.requestFocus()}
              onBlur={() => window.bwu.bubble.releaseFocus()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
                if (e.key === 'Escape') e.currentTarget.blur()
              }}
            />
            <button className="composer__send" onClick={submit} disabled={!draft.trim()}>
              发送
            </button>
          </div>
        ) : null}

        <footer className="card__foot">
          {state.phase === 'listening' ? (
            <span className="hint-text">松开 {state.hotkey} 发送</span>
          ) : state.phase === 'speaking' || state.phase === 'thinking' ? (
            <>
              <span className="wave" aria-hidden>
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <button className="ghost-btn" onClick={onStop}>
                停止
              </button>
            </>
          ) : (
            <>
              <span className="hint-text">按住 {state.hotkey} 继续说</span>
              {hasContent ? (
                <button
                  className="ghost-btn ghost-btn--sm"
                  title="忘掉之前的对话，重新开始"
                  onClick={() => window.bwu.bubble.clearContext()}
                >
                  清空上下文
                </button>
              ) : null}
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
