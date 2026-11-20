/**
 * 开机自启动。
 *
 * 只在「安装版」注册：便携版每次运行都解压到临时目录，`process.execPath` 指向那个临时文件，
 * 注册进去下次开机就是个死链。所以便携版直接跳过，UI 上也标出来。
 */
import { app } from 'electron'
import { log } from '../logger'
import { isPortable } from '../platform'

export function canAutoLaunch(): boolean {
  return app.isPackaged && !isPortable()
}

/** 幂等：值没变就不碰注册表，免得每次改设置都写一遍 */
export function applyAutoLaunch(enabled: boolean): void {
  if (!canAutoLaunch()) return
  try {
    const current = app.getLoginItemSettings().openAtLogin
    if (current === enabled) return
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
    log('auto-launch: 已更新', enabled ? '随系统启动' : '取消随系统启动')
  } catch (e) {
    log('auto-launch: 设置失败', e instanceof Error ? e.message : e)
  }
}
