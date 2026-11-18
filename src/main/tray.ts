import { Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import { settingsStore } from './store/settings'
import { openSettingsWindow, showBallMenu, showBallWindow } from './windows'

let tray: Tray | null = null

function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)
}

/**
 * 托盘：
 * - 左键：把球叫回来
 * - 右键：用和球一样的自绘菜单（系统菜单在不同缩放下左右留白不一致，而且和 App 风格割裂）
 */
export function createTray(onQuit: () => void): Tray {
  if (tray) return tray
  let image = nativeImage.createFromPath(resourcePath('tray.png'))
  if (image.isEmpty()) image = nativeImage.createEmpty()
  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip('BeWithU · 桌面伙伴')

  tray.on('click', () => showBallWindow())
  tray.on('double-click', () => openSettingsWindow())
  tray.on('right-click', () => {
    const s = settingsStore.get()
    const anchor = tray?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 }
    showBallMenu(
      [
        { id: 'show-ball', label: '显示悬浮球' },
        { id: 'sep0', label: '', separator: true },
        { id: 'settings', label: '设置…' },
        { id: 'mute', label: s.ui.muted ? '取消静音' : '静音', checked: s.ui.muted },
        { id: 'hide-all', label: '隐藏全部窗口' },
        { id: 'clear-context', label: '清空对话上下文' },
        { id: 'sep1', label: '', separator: true },
        { id: 'logs', label: '打开日志目录' },
        { id: 'sep2', label: '', separator: true },
        { id: 'quit', label: '退出 BeWithU', danger: true }
      ],
      anchor
    )
  })
  return tray
}

export function refreshTray(): void {
  // 菜单每次右键现建，不需要预先刷新
}
