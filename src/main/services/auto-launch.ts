import { app, shell } from 'electron'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../logger'
import { isPortable } from '../platform'
import { elevatedStartupArguments } from './auto-launch-command'

const shortcutName = 'BeWithU - Startup.lnk'

function canAutoLaunch(): boolean {
  // 便携版的 exe 在临时解包目录。隔离用户目录也不应注册本机的登录启动项。
  return app.isPackaged && process.platform === 'win32' && !isPortable() && !app.commandLine.hasSwitch('user-data-dir')
}

export function applyAutoLaunch(enabled: boolean): void {
  if (!canAutoLaunch()) return
  try {
    const startupDir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    const shortcutPath = join(startupDir, shortcutName)
    if (enabled) {
      // 登录时先由普通进程发起 RunAs，Windows 随后显示正常的 UAC 提示。
      const target = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (!existsSync(target)) throw new Error('找不到 Windows PowerShell')
      const args = elevatedStartupArguments
      const cwd = dirname(process.execPath)
      let current: Electron.ShortcutDetails | undefined
      try { current = shell.readShortcutLink(shortcutPath) } catch { /* 首次安装或快捷方式已损坏 */ }
      if (current?.target.toLowerCase() !== target.toLowerCase() || current.args !== args ||
        current.cwd?.toLowerCase() !== cwd.toLowerCase()) {
        mkdirSync(startupDir, { recursive: true })
        const written = shell.writeShortcutLink(shortcutPath, 'create', {
          target,
          args,
          cwd,
          description: 'BeWithU: 启动前请求管理员权限',
          icon: process.execPath,
          iconIndex: 0
        })
        if (!written) throw new Error('创建登录启动快捷方式失败')
        log('auto-launch: 已注册登录启动快捷方式')
      }
    } else if (existsSync(shortcutPath)) {
      rmSync(shortcutPath)
      log('auto-launch: 已移除登录启动快捷方式')
    }
    // 清掉旧版以应用 ID 注册的 Run 项，升级后同一登录会话只会启动一次。
    app.setLoginItemSettings({ openAtLogin: false })
  } catch (e) {
    log('auto-launch: 设置失败', e instanceof Error ? e.message : e)
  }
}
