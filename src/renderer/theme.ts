import type { PublicSettings } from '@shared/types'

type Theme = 'dark' | 'light'

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** 每个渲染窗口启动时调用一次：先按当前设置上色，之后跟着设置变化走 */
export function initTheme(): () => void {
  let active = true
  let receivedChange = false
  const off = window.bwu.settings.onChanged((next) => {
    receivedChange = true
    apply(next.ui.theme)
  })
  void window.bwu.settings.get().then((s: PublicSettings) => {
    if (active && !receivedChange) apply(s.ui.theme)
  }).catch(() => {
    if (active && !receivedChange) apply('dark')
  })
  return () => { active = false; off() }
}
