/**
 * 极简 MCP 客户端（不引第三方 SDK）
 * - stdio：spawn 子进程，换行分隔的 JSON-RPC
 * - http：POST JSON-RPC（兼容 SSE 响应）
 *
 * 只实现 Agent 需要的四个方法：initialize / notifications/initialized / tools/list / tools/call
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { log } from '../logger'
import type { McpServerConfig, McpToolDef } from '../../shared/types'
import { sseLines } from '../services/sse'
import { withSignal } from './cancellation'
import type { ToolResult } from './types'

const STDIO_PROTOCOL_VERSION = '2024-11-05'
const HTTP_PROTOCOL_VERSION = '2025-11-25'
const TIMEOUT_MS = 15000

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  dispose: () => void
}

class StdioConn {
  private proc: ChildProcessWithoutNullStreams
  private seq = 0
  private pending = new Map<number, Pending>()
  private buffer = ''
  private closed = false

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stdin.on('error', (error) => this.failAll(`MCP 写入失败：${error.message}`))
    this.proc.stderr.on('data', (d) => log('mcp: stderr', String(d).slice(0, 200)))
    this.proc.on('exit', () => this.failAll('MCP 进程已退出'))
    this.proc.on('error', (e) => this.failAll(`启动失败：${e.message}`))
  }

  private failAll(msg: string): void {
    this.closed = true
    for (const [, p] of this.pending) {
      p.dispose()
      p.reject(new Error(msg))
    }
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      idx = this.buffer.indexOf('\n')
      if (!line) continue
      try {
        this.handle(JSON.parse(line))
      } catch {
        /* 忽略不合法行 */
      }
    }
  }

  private handle(msg: any): void {
    if (msg && typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      p.dispose()
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP 调用失败'))
      else p.resolve(msg.result)
      return
    }
    // 服务端发起的请求（采样等）：直接回不支持
    if (msg && msg.id !== undefined && msg.method) {
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })
    }
  }

  private write(obj: unknown): void {
    if (this.closed) return
    try {
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`)
    } catch (e) {
      log('mcp: 写入失败', e)
    }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.closed) return Promise.reject(new Error('MCP 连接已关闭'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const cancel = (reason: unknown): void => {
        this.pending.delete(id)
        dispose()
        if (method !== 'initialize') {
          this.notify('notifications/cancelled', { requestId: id, reason: String(reason) })
        }
        reject(reason)
      }
      const abort = (): void => cancel(signal?.reason)
      const timer = setTimeout(() => cancel(new Error(`${method} 超时`)), TIMEOUT_MS)
      const dispose = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, dispose })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  close(): void {
    this.failAll('MCP 连接已撤销')
    try {
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}

class HttpConn {
  private readonly url: string
  private readonly headers: Headers
  private seq = 0
  private readonly lifetime = new AbortController()
  private sessionId: string | null = null
  private protocolVersion: string | null = null

  constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    })
  }

  get isClosed(): boolean {
    return this.lifetime.signal.aborted
  }

  private async post(method: string, params: unknown, id?: number, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.headers)
    if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId)
    if (this.protocolVersion) headers.set('MCP-Protocol-Version', this.protocolVersion)
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.any([this.lifetime.signal, signal ?? AbortSignal.timeout(TIMEOUT_MS)])
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      if (res.status === 404 && this.sessionId) this.close()
      throw new Error(`HTTP ${res.status}`)
    }
    return res
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    const id = ++this.seq
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const execution = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await this.post(method, params, id, execution)
      const type = res.headers.get('content-type') ?? ''
      const json = type.includes('text/event-stream') && res.body
        ? await this.readEventResponse(res.body, id)
        : await res.json()
      execution.throwIfAborted()
      if (json?.id !== id) throw new Error('MCP 响应 ID 与请求不匹配')
      if (json.error) throw new Error(json.error.message ?? 'MCP 调用失败')
      if (method === 'initialize') {
        this.sessionId = res.headers.get('Mcp-Session-Id')
        const version = json.result?.protocolVersion
        this.protocolVersion = typeof version === 'string' && version !== STDIO_PROTOCOL_VERSION ? version : null
      }
      return json.result
    } catch (error) {
      if (execution.aborted && method !== 'initialize') {
        void this.notify('notifications/cancelled', { requestId: id, reason: String(execution.reason) }).catch(() => {})
      }
      throw error
    }
  }

  private async readEventResponse(body: ReadableStream<Uint8Array>, id: number): Promise<any> {
    let data: string[] = []
    for await (const line of sseLines(body as unknown as AsyncIterable<Uint8Array>)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      if (line !== '' || !data.length) continue
      const event = data.join('\n')
      data = []
      try {
        const msg = JSON.parse(event)
        if (msg?.id === id) return msg
      } catch {
        /* 不是有效的 JSON-RPC 事件，继续读后续行 */
      }
    }
    throw new Error('SSE 没有返回结果')
  }

  async notify(method: string, params: unknown): Promise<void> {
    // 兼容既不声明协议版本也不分配会话的旧 HTTP 服务。
    if (!this.sessionId && !this.protocolVersion) return
    const res = await this.post(method, params)
    await res.body?.cancel()
  }

  close(): void {
    this.lifetime.abort()
  }
}

type Conn = StdioConn | HttpConn

const conns = new Map<string, { key: string; conn: Conn; ready: Promise<Conn> }>()

export function mcpConfigKey(server: McpServerConfig): string {
  return JSON.stringify([server.enabled, server.name, server.transport, server.command, server.args, server.url, server.headers])
}

function parseArgs(raw: string): string[] {
  // 支持带引号的参数，例如: "-y @modelcontextprotocol/server-filesystem C:\docs"
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out.filter(Boolean)
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

async function connect(server: McpServerConfig): Promise<Conn> {
  const key = mcpConfigKey(server)
  const cached = conns.get(server.id)
  if (cached?.key === key && !cached.conn.isClosed) return cached.ready
  if (cached) disconnectMcp(server.id)
  let conn: Conn
  if (server.transport === 'http') {
    conn = new HttpConn(server.url.trim(), parseHeaders(server.headers))
  } else {
    const cmd = server.command.trim()
    if (!cmd) throw new Error('没有配置启动命令')
    conn = new StdioConn(cmd, parseArgs(server.args))
  }
  const ready = (async () => {
    try {
      await conn.request('initialize', {
        protocolVersion: conn instanceof HttpConn ? HTTP_PROTOCOL_VERSION : STDIO_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'BeWithU', version: '0.1.0' }
      })
      if (conns.get(server.id)?.conn !== conn) throw new Error('MCP 连接已撤销')
      await conn.notify('notifications/initialized', {})
      return conn
    } catch (error) {
      if (conns.get(server.id)?.conn === conn) disconnectMcp(server.id)
      throw error
    }
  })()
  conns.set(server.id, { key, conn, ready })
  return ready
}

export function disconnectMcp(serverId: string): void {
  const c = conns.get(serverId)
  if (c) {
    conns.delete(serverId)
    c.conn.close()
  }
}

export function disconnectAllMcp(): void {
  for (const id of [...conns.keys()]) disconnectMcp(id)
}

export async function mcpListTools(server: McpServerConfig, signal?: AbortSignal): Promise<McpToolDef[]> {
  signal?.throwIfAborted()
  const conn = await withSignal(connect(server), signal)
  const seen = new Set<string>()
  const tools = new Map<string, McpToolDef>()
  let cursor: string | undefined
  do {
    const res = await conn.request('tools/list', cursor === undefined ? {} : { cursor }, signal)
    if (!Array.isArray(res?.tools)) throw new Error('MCP 返回了无效的工具清单')
    for (const t of res.tools) {
      if (typeof t?.name !== 'string' || !t.name || tools.has(t.name)) continue
      tools.set(t.name, {
        name: t.name,
        description: String(t.description ?? ''),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
          ? t.inputSchema as Record<string, unknown>
          : { type: 'object', properties: {} }
      })
    }
    cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 1000) throw new Error('MCP 工具清单的分页游标异常')
      seen.add(cursor)
    }
  } while (cursor !== undefined)
  return [...tools.values()]
}

export async function mcpCallTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolResult> {
  signal?.throwIfAborted()
  const conn = await withSignal(connect(server), signal)
  const res = await conn.request('tools/call', { name: toolName, arguments: args }, signal)
  signal?.throwIfAborted()
  const content: any[] = Array.isArray(res?.content) ? res.content : []
  const images: NonNullable<ToolResult['images']> = []
  const resources: unknown[] = []
  const notes: string[] = []
  const text: string[] = []
  for (const c of content) {
    if (typeof c?.text === 'string') {
      text.push(c.text)
    } else if (c?.type === 'image') {
      if (images.length < 4 && typeof c.data === 'string' && c.data.length > 0 &&
          c.data.length <= 2_800_000 && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType) &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(c.data)) {
        images.push({ dataUrl: `data:${c.mimeType};base64,${c.data}` })
      } else if (!notes.includes('部分图片因格式、大小或数量限制未返回')) {
        notes.push('部分图片因格式、大小或数量限制未返回')
      }
    } else if (c?.type === 'resource' || c?.type === 'resource_link') {
      const item = c.type === 'resource' ? c.resource : c
      if (typeof item?.uri === 'string') resources.push({ uri: item.uri, mimeType: item.mimeType, text: item.text })
    } else if (typeof c?.type === 'string') {
      notes.push(`[${c.type}]`)
    }
  }
  if (images.length) notes.push(`返回 ${images.length} 张图片`)
  if (res?.structuredContent !== undefined) notes.push('返回结构化数据')
  const data = res?.structuredContent !== undefined || resources.length
    ? { structuredContent: res.structuredContent, ...(resources.length && { resources }), ...(text.length && { text: text.join('\n') }) }
    : undefined
  return {
    ok: res?.isError !== true,
    summary: [...notes, ...text].join('\n') || '（没有文本结果）',
    ...(data !== undefined && { data }),
    ...(images.length && { images })
  }
}
