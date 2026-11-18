import type { PublicSettings } from '@shared/types'

type Theme = 'dark' | 'light'

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** 每个渲染窗口启动时调用一次：先按当前设置上色，之后跟着设置变化走 */
export function initTheme(): () => void {
  let off: (() => void) | null = null
  void window.bwu.settings
    .get()
    .then((s: PublicSettings) => {
      apply(s.ui.theme)
      off = window.bwu.ball.onSettings((next) => apply(next.ui.theme))
    })
    .catch(() => apply('dark'))
  return () => off?.()
}
