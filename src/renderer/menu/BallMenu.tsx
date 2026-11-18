import { useEffect, useRef, useState } from 'react'
import type { BallMenuItem } from '@shared/types'

/**
 * 悬浮球的右键菜单：自绘窗口。
 * 用原生 Menu.popup 时，置顶的透明窗口不是激活窗口，点桌面不会让菜单失焦，
 * 只能选一项或者拖动球才关得掉，所以这里自己画一个：
 * - 窗口是 focusable 的，点任何地方都会让它 blur，主进程收到 blur 就关掉；
 * - Esc 关闭；点菜单项也关闭。
 */
export default function BallMenu(): React.JSX.Element {
  const [items, setItems] = useState<BallMenuItem[]>([])
  const cardRef = useRef<HTMLDivElement | null>(null)
  const reported = useRef('')

  useEffect(() => {
    const off = window.bwu.menu.onItems((list) => setItems(list))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.bwu.menu.close()
    }
    const onBlur = (): void => window.bwu.menu.close()
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      off()
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 内容变了就上报一次尺寸，主进程据此调整窗口大小和位置
  useEffect(() => {
    const el = cardRef.current
    if (!el || items.length === 0) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      const key = `${Math.round(r.width)}x${Math.round(r.height)}`
      if (key === reported.current) return
      reported.current = key
      window.bwu.menu.resize(Math.ceil(r.width), Math.ceil(r.height))
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [items])

  useEffect(() => {
    const off = window.bwu.menu.onMeasure(() => {
      const el = cardRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      reported.current = `${Math.round(r.width)}x${Math.round(r.height)}`
      window.bwu.menu.resize(Math.ceil(r.width), Math.ceil(r.height))
    })
    return off
  }, [])

  return (
    <div className="menu" ref={cardRef}>
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="menu__sep" />
        ) : (
          <button
            key={item.id}
            className={
              'menu__item' +
              (item.danger ? ' menu__item--danger' : '') +
              (item.checked ? ' menu__item--checked' : '')
            }
            onClick={() => window.bwu.menu.pick(item.id)}
          >
            <span className="menu__label">{item.label}</span>
            {item.checked ? <span className="menu__check">✓</span> : null}
          </button>
        )
      )}
    </div>
  )
}
