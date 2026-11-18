/**
 * 自定义工具执行进程（utilityProcess）。
 * 每次调用新建一个进程：隔离崩溃、避免工具之间共享状态。
 * 能力一律通过 postMessage 回主进程校验，子进程本身不直接碰 fs（防误用）。
 */
const port = (process as unknown as { parentPort: { on: Function; postMessage: Function } }).parentPort

export {}

let apiSeq = 0
const pendingApi = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function apiCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  const reqId = ++apiSeq
  return new Promise((resolve, reject) => {
    pendingApi.set(reqId, { resolve, reject })
    port.postMessage({ type: 'api', reqId, method, params })
    setTimeout(() => {
      const p = pendingApi.get(reqId)
      if (p) {
        pendingApi.delete(reqId)
        reject(new Error(`能力 ${method} 超时`))
      }
    }, 15000)
  })
}

const api = {
  log: (message: unknown) => apiCall('log', { message: String(message ?? '') }),
  fs: {
    read: (path: unknown) => apiCall('fs.read', { path: String(path ?? '') }),
    write: (path: unknown, content: unknown) =>
      apiCall('fs.write', { path: String(path ?? ''), content: String(content ?? '') })
  },
  notify: (title: unknown, body: unknown) =>
    apiCall('notify', { title: String(title ?? ''), body: String(body ?? '') }),
  net: (url: unknown) => apiCall('net', { url: String(url ?? '') })
}

function reply(msg: unknown): void {
  try {
    port.postMessage(msg)
  } catch {
    /* ignore */
  }
}

function normalize(raw: unknown): { ok: boolean; summary: string; data?: unknown } {
  if (typeof raw === 'string') return { ok: true, summary: raw }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return {
      ok: o.ok !== false,
      summary: String(o.summary ?? o.message ?? '（工具没有返回说明）'),
      data: o.data
    }
  }
  return { ok: true, summary: String(raw ?? '（工具没有返回说明）') }
}

port.on('message', async (event: { data: any }) => {
  const msg = event?.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'api-result') {
    const p = pendingApi.get(msg.reqId)
    if (!p) return
    pendingApi.delete(msg.reqId)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(String(msg.error ?? '能力调用失败')))
    return
  }

  if (msg.type !== 'run') return

  const { toolDir, entry, args } = msg as { toolDir: string; entry: string; args: Record<string, unknown> }
  const path = require('node:path') as typeof import('node:path')
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(toolDir, entry))
    const fn = mod?.run ?? mod?.default?.run ?? (typeof mod === 'function' ? mod : null)
    if (typeof fn !== 'function') {
      reply({ type: 'error', message: '入口文件必须导出 async function run(args, api)' })
      return
    }
    const raw = await fn(args ?? {}, api)
    reply({ type: 'result', ...normalize(raw) })
  } catch (e) {
    reply({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
  }
})
