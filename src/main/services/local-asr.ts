import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { log } from '../logger'

const MODEL_FILES = ['model.int8.onnx', 'tokens.txt']
const IDLE_MS = 5 * 60 * 1000

export function modelDir(): string {
  return join(app.getPath('userData'), 'models', 'sensevoice-2024-07-17')
}

export function modelReady(): boolean {
  try {
    return MODEL_FILES.every((f) => {
      const p = join(modelDir(), f)
      return existsSync(p) && statSync(p).size > 0
    })
  } catch {
    return false
  }
}

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void }

let child: Electron.UtilityProcess | null = null
let readyPromise: Promise<void> | null = null
let idleTimer: NodeJS.Timeout | null = null
let seq = 0
const pending = new Map<number, Pending>()

function clearIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdle(): void {
  clearIdle()
  idleTimer = setTimeout(() => {
    if (pending.size === 0) {
      log('local-asr: 闲置回收 worker')
      killWorker()
    }
  }, IDLE_MS)
}

function killWorker(): void {
  clearIdle()
  if (child) {
    try {
      child.postMessage({ type: 'dispose' })
      child.kill()
    } catch {
      /* ignore */
    }
  }
  child = null
  readyPromise = null
  for (const [, p] of pending) p.reject(new Error('本地识别进程已退出'))
  pending.clear()
}

function startWorker(): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = new Promise<void>((resolve, reject) => {
    let settled = false
    const entry = join(__dirname, 'asr-worker.js')
    try {
      child = utilityProcess.fork(entry, [], { serviceName: 'BeWithU Local ASR' })
    } catch (e) {
      readyPromise = null
      reject(new Error('本地识别启动失败，请重试'))
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      readyPromise = null
      log('local-asr: 加载超时')
      killWorker()
      reject(new Error('模型加载超时，请重试'))
    }, 30000)

    child.on('message', (msg: any) => {
      if (msg?.type === 'ready') {
        if (settled) return
        settled = true
        clearTimeout(timer)
        log('local-asr: 模型就绪', `${msg.loadMs}ms`)
        resolve()
        return
      }
      if (msg?.type === 'init-error') {
        if (settled) return
        settled = true
        clearTimeout(timer)
        readyPromise = null
        reject(new Error('模型加载失败，请重试'))
        return
      }
      if (msg?.type === 'result' || msg?.type === 'error') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        scheduleIdle()
        if (msg.type === 'result') p.resolve(String(msg.text || ''))
        else p.reject(new Error(String(msg.message || '识别失败')))
      }
    })

    child.on('exit', () => {
      child = null
      readyPromise = null
      for (const [, p] of pending) p.reject(new Error('本地识别进程意外退出'))
      pending.clear()
    })

    child.postMessage({ type: 'init', modelDir: modelDir(), numThreads: 2 })
  })
  return readyPromise
}

/** 识别一段 16k 单声道 float 采样 */
export async function recognize(samples: Float32Array): Promise<string> {
  if (!modelReady()) throw new Error('还没有下载语音识别模型')
  await startWorker()
  const id = ++seq
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('识别超时，请重试'))
      }
    }, 30000)
    const wrap = (fn: (v: any) => void) => (v: any) => {
      clearTimeout(timer)
      fn(v)
    }
    const entry = pending.get(id)!
    pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) })
    child?.postMessage({ type: 'recognize', id, samples })
  })
}

export function disposeLocalAsr(): void {
  killWorker()
}

/** 预热：把模型加载进 worker（设置页"测试加载"用） */
export async function warmupLocalAsr(): Promise<number> {
  if (!modelReady()) throw new Error('还没有下载语音识别模型')
  const t = Date.now()
  await startWorker()
  scheduleIdle()
  return Date.now() - t
}

/** 一次按住说话的本地会话：先攒 PCM，松手后整段识别 */
export class LocalAsrSession {
  private chunks: Int16Array[] = []
  private cancelled = false

  sendAudio(buf: Buffer): void {
    if (this.cancelled) return
    const len = Math.floor(buf.byteLength / 2)
    if (!len) return
    const copy = new Int16Array(len)
    for (let i = 0; i < len; i++) copy[i] = buf.readInt16LE(i * 2)
    this.chunks.push(copy)
  }

  async finish(): Promise<string> {
    if (this.cancelled) return ''
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    if (total < 1600) return ''
    const samples = new Float32Array(total)
    let offset = 0
    for (const c of this.chunks) {
      for (let i = 0; i < c.length; i++) samples[offset + i] = c[i] / 32768
      offset += c.length
    }
    this.chunks = []
    return recognize(samples)
  }

  cancel(): void {
    this.cancelled = true
    this.chunks = []
  }
}
