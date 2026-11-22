/**
 * 键鼠注入客户端：所有原生调用都转发给 utilityProcess（input-worker）。
 *
 * koffi 在 Electron 主进程里调用会崩（0xC0000005），放到独立 Node 进程就正常；
 * 顺带好处是注入出问题不会带走主进程。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { log } from '../logger'

export const MAX_TYPE_CHARS = 2000

interface Reply {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

let worker: UtilityProcess | null = null
let seq = 0
let ready = false
let loadError = ''
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; dispose: () => void }>()

function failAll(message: string): void {
  for (const [, p] of pending) {
    p.dispose()
    p.reject(new Error(message))
  }
  pending.clear()
}

function ensureWorker(): UtilityProcess | null {
  if (worker) return worker
  if (loadError) return null
  if (process.platform !== 'win32') {
    loadError = '键鼠注入只支持 Windows'
    return null
  }
  try {
    worker = utilityProcess.fork(join(__dirname, 'input-worker.js'), [], {
      serviceName: 'BeWithU Input',
      stdio: 'inherit'
    })
    worker.on('message', (msg: Reply) => {
      if (msg?.id === 0) {
        ready = true
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      p.dispose()
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || '注入失败'))
    })
    worker.on('exit', (code) => {
      log('input: 工作进程退出', code)
      worker = null
      ready = false
      failAll('键鼠注入进程已退出')
    })
    log('input: 工作进程已启动')
    return worker
  } catch (e) {
    loadError = `启动键鼠注入进程失败：${e instanceof Error ? e.message : String(e)}`
    log('input: 工作进程启动失败', loadError)
    return null
  }
}

function request<T = unknown>(
  cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15000, signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const w = ensureWorker()
  if (!w) return Promise.reject(new Error(loadError || '键鼠注入不可用'))
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const cancel = (error: Error): void => {
      pending.delete(id)
      dispose()
      try { w.postMessage({ cancelId: id }) } catch { /* 工作进程已退出 */ }
      reject(error)
    }
    const abort = (): void => cancel(signal?.reason)
    const timer = setTimeout(() => cancel(new Error(`注入命令超时：${cmd}`)), timeoutMs)
    const dispose = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, dispose })
    try {
      w.postMessage({ id, cmd, args })
    } catch (e) {
      pending.delete(id)
      dispose()
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

export function isInputAvailable(): boolean {
  return ensureWorker() !== null
}

export function inputUnavailableReason(): string {
  ensureWorker()
  return loadError
}

export async function sessionLocked(): Promise<boolean> {
  try {
    return Boolean(await request<boolean>('locked', {}, 4000))
  } catch {
    return false
  }
}

export async function workerPing(): Promise<boolean> {
  try {
    const r = await request<string>('ping', {}, 5000)
    return r === 'pong' && ready
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ 键盘 -- */

export async function typeText(text: string, expectTitle?: string, signal?: AbortSignal): Promise<{ length: number; target: string }> {
  return request('type', { text, expectTitle }, undefined, signal)
}

export async function sendKeys(combo: string, expectTitle?: string, signal?: AbortSignal): Promise<void> {
  await request('key', { keys: combo, expectTitle }, undefined, signal)
}

/* ------------------------------------------------------------------ 鼠标 -- */

export interface ScreenMetrics {
  x: number
  y: number
  width: number
  height: number
}

export async function screenMetrics(signal?: AbortSignal): Promise<ScreenMetrics> {
  return request<ScreenMetrics>('metrics', {}, undefined, signal)
}

export async function cursorPos(signal?: AbortSignal): Promise<{ x: number; y: number }> {
  return request('cursor', {}, undefined, signal)
}

export async function moveMouse(x: number, y: number, signal?: AbortSignal): Promise<void> {
  const r = await request<{ sent: boolean; before: { x: number; y: number }; after: { x: number; y: number } }>('move', {
    x,
    y
  }, undefined, signal)
  if (!r.sent) throw new Error('鼠标移动失败（SendInput 未生效）')
  log('input: move diag', JSON.stringify(r))
}

export interface ClickOptions {
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  count?: number
  expectTitle?: string
}

export async function clickMouse(opts: ClickOptions = {}, signal?: AbortSignal): Promise<void> {
  await request('click', opts as Record<string, unknown>, undefined, signal)
}

export async function scrollMouse(notches: number, signal?: AbortSignal): Promise<void> {
  await request('scroll', { notches }, undefined, signal)
}

export async function dragMouse(from: { x: number; y: number }, to: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
  await request('drag', { from, to }, 30000, signal)
}

/* ------------------------------------------------------------------ 窗口 -- */

export async function foregroundWindowTitle(signal?: AbortSignal): Promise<string> {
  const r = await request<{ title: string }>('foreground', {}, undefined, signal)
  return r.title
}

export async function findWindowByTitle(title: string, signal?: AbortSignal): Promise<boolean> {
  return request<boolean>('findWindow', { title }, undefined, signal)
}

export async function focusWindowByTitle(title: string, signal?: AbortSignal): Promise<{ found: boolean; focused: boolean; foreground: string }> {
  return request('focus', { title }, 20000, signal)
}

/** 目标窗口校验：前台标题必须包含 expectTitle，否则拒绝注入 */
export async function assertForeground(expectTitle: string): Promise<void> {
  await request('assertSafe', { expectTitle })
}
