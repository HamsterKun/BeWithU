import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DshConnectionInfo, DshSessionInfo, TestResult } from '../../shared/types'
import { sseLines } from './sse'

const PATCH_BEGIN = '# >>> BeWithU DSH bridge >>>'
const PATCH_END = '# <<< BeWithU DSH bridge <<<'
const NOT_CONNECTED = '未连接到 DSH。请打开 DeepSeek Harness，首次使用时安装连接组件并重启 DSH。'

function desktopProfile(): string {
  return join(process.env.DSH_HOME || join(app.getPath('home'), '.dsh'), 'profiles', 'desktop')
}

function atomicWrite(file: string, content: string): void {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function updateDshPatch(existing: string, plugin: string): string {
  const escaped = JSON.stringify(plugin.replaceAll('\\', '/'))
  const managed = `${PATCH_BEGIN}\n- insert:\n    - id: bewithu-bridge\n      name: ${escaped}\n${PATCH_END}`
  const start = existing.indexOf(PATCH_BEGIN)
  const end = existing.indexOf(PATCH_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + managed + existing.slice(end + PATCH_END.length)
  }
  if (start >= 0 || end >= 0 || /^\s*-\s+id:\s*bewithu-bridge\s*$/m.test(existing)) {
    throw new Error('DSH 配置中的连接组件条目不完整，请检查 cordis.patch.yml')
  }
  const body = existing.replace(/^\uFEFF/, '')
  const lines = body.split(/\r?\n/)
  const top = lines.filter((line) => /^(?!#|---\s*$)\S/.test(line))
  if (top.length === 1 && /^\[\s*\]\s*(?:#.*)?$/.test(top[0])) {
    const comments = lines.filter((line) => line.trim().startsWith('#')).join('\n')
    return `${comments ? comments + '\n\n' : ''}${managed}\n`
  }
  if (top.some((line) => !/^-\s/.test(line)) || lines.filter((line) => /^---\s*$/.test(line)).length > 1) {
    throw new Error('DSH 的 cordis.patch.yml 需要是单个 YAML 列表，请先检查该文件')
  }
  return `${body ? body + '\n\n' : ''}${managed}\n`
}

export function installDshBridge(): TestResult {
  try {
    const profile = desktopProfile()
    if (!existsSync(join(profile, 'package.json'))) {
      return { ok: false, message: '请先启动一次 DeepSeek Harness 桌面版，完成初始化' }
    }
    const patch = join(profile, 'cordis.patch.yml')
    const plugin = join(profile, 'bewithu-bridge.mjs')
    const source = app.isPackaged
      ? join(process.resourcesPath, 'dsh-bridge.mjs')
      : join(app.getAppPath(), 'resources', 'dsh-bridge.mjs')
    const before = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
    const after = updateDshPatch(before, plugin)
    atomicWrite(plugin, readFileSync(source, 'utf8'))
    if (after !== before) {
      const backup = join(profile, 'cordis.patch.yml.before-bewithu')
      if (existsSync(patch) && !existsSync(backup)) copyFileSync(patch, backup)
      atomicWrite(patch, after)
    }
    return { ok: true, message: '连接组件已安装，请重启 DeepSeek Harness，然后刷新对话列表' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '安装连接组件失败' }
  }
}

function connection(): { port: number; token: string } {
  try {
    const value = JSON.parse(readFileSync(join(desktopProfile(), 'bewithu-connection.json'), 'utf8'))
    if (value?.version === 1 && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 &&
        typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)) return value
  } catch { /* DSH may be starting or stopped */ }
  throw new Error(NOT_CONNECTED)
}

async function bridgeFetch(path: '/sessions' | '/turn', init: RequestInit): Promise<Response> {
  const { port, token } = connection()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, redirect: 'error' }).catch(() => {
    init.signal?.throwIfAborted()
    throw new Error(NOT_CONNECTED)
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof data?.error === 'string' ? data.error : NOT_CONNECTED)
  }
  return res
}

export async function listDshSessions(): Promise<DshConnectionInfo> {
  try {
    const res = await bridgeFetch('/sessions', { signal: AbortSignal.timeout(5000) })
    const data = await res.json() as { sessions?: unknown } | null
    if (!Array.isArray(data?.sessions)) throw new Error('DSH 返回了无效的对话列表')
    const sessions = data.sessions.filter((s: DshSessionInfo) => s?.id && typeof s.id === 'string' &&
      typeof s.title === 'string' && typeof s.cwd === 'string' && typeof s.running === 'boolean')
    return { ok: true, message: '已连接到 DSH', sessions }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : NOT_CONNECTED, sessions: [] }
  }
}

export type DshProgress = { mode: 'thinking' | 'working' | 'waiting'; text: string }

export async function runDsh(
  text: string, sessionId: string, signal: AbortSignal, onProgress: (progress: DshProgress) => void
): Promise<string> {
  const res = await bridgeFetch('/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId }),
    signal
  })
  if (!res.body) throw new Error('DSH 没有返回任务状态')
  for await (const line of sseLines(res.body as unknown as AsyncIterable<Uint8Array>)) {
    const event = JSON.parse(line)
    signal.throwIfAborted()
    if (event.type === 'status' && ['thinking', 'working', 'waiting'].includes(event.mode) && typeof event.text === 'string') {
      onProgress(event)
    }
    if (event.type === 'result' && typeof event.text === 'string' && event.text.trim()) return event.text
    if (event.type === 'error' && typeof event.message === 'string') throw new Error(event.message)
  }
  throw new Error('DSH 连接已关闭，本轮没有返回结果')
}
