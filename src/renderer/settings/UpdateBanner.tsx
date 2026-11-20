import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

/**
 * 侧栏底部的更新横幅。
 * 安装版：点一下开始下载 → 进度条 → 下完变「立即重启」。
 * 便携版：没法原地替换，点了直接去 release 页。
 */
export default function UpdateBanner(): React.ReactElement | null {
  const [st, setSt] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    let alive = true
    void window.bwu.update.get().then((s) => {
      if (alive) setSt(s)
    })
    const off = window.bwu.update.onChanged((s) => setSt(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!st) return null
  if (st.kind === 'idle' || st.kind === 'checking') return null

  const busy = st.kind === 'downloading'
  const click = (): void => {
    if (st.kind === 'available') {
      if (st.portable) void window.bwu.update.openPage()
      else void window.bwu.update.download().then(setSt)
      return
    }
    if (st.kind === 'ready') void window.bwu.update.install()
    if (st.kind === 'error') void window.bwu.update.check().then(setSt)
  }

  const label = ((): string => {
    if (st.kind === 'available') {
      return st.portable ? `新版本 ${st.version} · 便携版点此下载` : `新版本 ${st.version} · 点击更新`
    }
    if (st.kind === 'downloading') return `正在下载 ${st.percent ?? 0}%`
    if (st.kind === 'ready') return '立即重启完成更新'
    return st.message || '更新失败，点此重试'
  })()

  return (
    <button
      type="button"
      className={`upd-banner is-${st.kind}`}
      onClick={click}
      disabled={busy}
      title={label}
    >
      <span className="upd-banner__main">
        {st.kind === 'ready' ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 1.5a1 1 0 0 1 1 1v6.1l1.9-1.9a1 1 0 1 1 1.4 1.4l-3.6 3.6a1 1 0 0 1-1.4 0L3.7 8.1a1 1 0 0 1 1.4-1.4L7 8.6V2.5a1 1 0 0 1 1-1zM3 12.5a1 1 0 0 1 1 1v.5h8v-.5a1 1 0 1 1 2 0v.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-.5a1 1 0 0 1 1-1z"
            />
          </svg>
        ) : (
          <span className="upd-banner__dot" />
        )}
        <span className="upd-banner__label">{label}</span>
      </span>
      {busy ? (
        <span className="upd-banner__bar">
          <span style={{ width: `${st.percent ?? 0}%` }} />
        </span>
      ) : null}
    </button>
  )
}
