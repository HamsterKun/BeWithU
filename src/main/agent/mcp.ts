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

const PROTOCOL_VERSION = '2024-11-05'
const TIMEOUT_MS = 15000

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
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
    this.proc.stderr.on('data', (d) => log('mcp: stderr', String(d).slice(0, 200)))
    this.proc.on('exit', () => this.failAll('MCP 进程已退出'))
    this.proc.on('error', (e) => this.failAll(`启动失败：${e.message}`))
  }

  private failAll(msg: string): void {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
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
      clearTimeout(p.timer)
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

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('MCP 连接已关闭'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
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
}

class HttpConn {
  private seq = 0
  private lifetime = new AbortController()
  constructor(
    private url: string,
    private headers: Record<string, string>
  ) {}

  async request(method: string, params: unknown): Promise<any> {
    const id = ++this.seq
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.any([controller.signal, this.lifetime.signal])
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream') && res.body) {
        // 逐行读 SSE，找到 id 匹配的响应
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let found: any = null
        while (!found) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx = buf.indexOf('\n\n')
          while (idx >= 0) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            idx = buf.indexOf('\n\n')
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data) continue
              try {
                const msg = JSON.parse(data)
                if (msg.id === id) found = msg
              } catch {
                /* ignore */
              }
            }
            if (found) break
          }
        }
        try {
          reader.cancel()
        } catch {
          /* ignore */
        }
        if (!found) throw new Error('SSE 没有返回结果')
        if (found.error) throw new Error(found.error.message ?? 'MCP 调用失败')
        return found.result
      }
      const json = (await res.json()) as any
      if (json.error) throw new Error(json.error.message ?? 'MCP 调用失败')
      return json.result
    } finally {
      clearTimeout(timer)
    }
  }

  notify(): void {
    /* HTTP 传输不需要 initialized 通知 */
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
  if (cached?.key === key) return cached.ready
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
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'BeWithU', version: '0.1.0' }
      })
      if (conns.get(server.id)?.conn !== conn) throw new Error('MCP 连接已撤销')
      conn.notify('notifications/initialized', {})
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

export async function mcpListTools(server: McpServerConfig): Promise<McpToolDef[]> {
  const conn = await connect(server)
  const res = await conn.request('tools/list', {})
  const tools: any[] = Array.isArray(res?.tools) ? res.tools : []
  return tools.map((t) => ({
    name: String(t.name ?? ''),
    description: String(t.description ?? ''),
    inputSchema:
      t.inputSchema && typeof t.inputSchema === 'object'
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} }
  }))
}

export async function mcpCallTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; summary: string }> {
  const conn = await connect(server)
  const res = await conn.request('tools/call', { name: toolName, arguments: args })
  const content: any[] = Array.isArray(res?.content) ? res.content : []
  const text = content
    .map((c) => (typeof c?.text === 'string' ? c.text : c?.type ? `[${c.type}]` : ''))
    .filter(Boolean)
    .join('\n')
  return { ok: res?.isError !== true, summary: text.slice(0, 4000) || '（没有文本结果）' }
}
