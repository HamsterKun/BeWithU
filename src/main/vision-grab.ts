import type { GrabResult } from '../shared/ipc'
import { IPC } from '../shared/ipc'
import { getBallWindow } from './windows'
import { log } from './logger'

let pending: ((r: GrabResult) => void) | null = null

export function resolveGrab(result: GrabResult): void {
  const cb = pending
  pending = null
  cb?.(result)
}

/**
 * 让渲染进程用 getDisplayMedia（Windows Graphics Capture）抓一帧。
 * 普通抓屏在独占全屏游戏里会黑屏，WGC 往往还能拿到画面。
 */
export function grabViaWgc(timeoutMs = 5000): Promise<GrabResult | null> {
  const win = getBallWindow()
  if (!win) return Promise.resolve(null)
  return new Promise((resolve) => {
    pending = resolve
    win.webContents.send(IPC.visionGrab)
    setTimeout(() => {
      if (pending === resolve) {
        pending = null
        log('vision: WGC 抓帧超时')
        resolve(null)
      }
    }, timeoutMs)
  })
}
