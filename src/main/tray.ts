import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { settingsStore } from './store/settings'
import { hideAllWindows, openSettingsWindow, showBallWindow } from './windows'
import { conversation } from './services/pipeline'
import { logPath } from './logger'

let tray: Tray | null = null

function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)
}

export function createTray(onQuit: () => void): Tray {
  if (tray) return tray
  let image = nativeImage.createFromPath(resourcePath('tray.png'))
  if (image.isEmpty()) image = nativeImage.createEmpty()
  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip('BeWithU · 桌面伙伴')

  const rebuild = (): void => {
    if (!tray) return
    const s = settingsStore.get()
    const menu = Menu.buildFromTemplate([
      {
        label: '显示悬浮球',
        click: () => showBallWindow()
      },
      { type: 'separator' },
      {
        label: '设置…',
        click: () => openSettingsWindow()
      },
      {
        label: s.ui.muted ? '取消静音' : '静音',
        type: 'checkbox',
        checked: s.ui.muted,
        click: () => {
          settingsStore.update({ ui: { muted: !s.ui.muted } })
          rebuild()
        }
      },
      {
        label: '隐藏全部窗口',
        click: () => hideAllWindows()
      },
      {
        label: '清空对话上下文',
        click: () => conversation.clearContext()
      },
      { type: 'separator' },
      {
        label: '打开日志目录',
        click: () => void shell.showItemInFolder(logPath())
      },
      { type: 'separator' },
      { label: '退出 BeWithU', click: onQuit }
    ])
    tray?.setContextMenu(menu)
  }

  rebuild()
  tray.on('click', () => showBallWindow())
  tray.on('double-click', () => openSettingsWindow())
  return tray
}

export function refreshTray(): void {
  // 菜单项状态在下次右键时重建即可
}
