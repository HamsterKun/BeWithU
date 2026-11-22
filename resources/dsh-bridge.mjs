import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'bewithu-bridge'
export const inject = ['sessionController']

const profile = dirname(fileURLToPath(import.meta.url))
const connectionFile = join(profile, 'bewithu-connection.json')
const sessionFile = join(profile, 'bewithu-session.txt')

async function readPrompt(req) {
  const pieces = []
  let size = 0
  for await (const data of req) {
    size += data.length
    if (size > 65536) throw new Error('输入过长')
    pieces.push(data)
  }
  const input = JSON.parse(Buffer.concat(pieces).toString('utf8'))
  if (typeof input?.text !== 'string' || !input.text.trim() || typeof input?.sessionId !== 'string') {
    throw new Error('无效的 DSH 输入')
  }
  return input
}

function isUserInput(message, requestId) {
  return message?.source?.rpcId === requestId
}

function rootText(event) {
  return (event.data.message?.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('')
}

export async function runTurn(ctx, agent, input, emit, signal) {
  if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
    throw new Error('所选 DSH 对话正在运行，请等这一轮结束再发送')
  }
  const requestId = randomUUID()
  let claimed = false
  let accepted = false
  let text = ''
  let reason
  let failure
  const start = Promise.withResolvers()
  // An abort can arrive before DSH acknowledges admission.
  void start.promise.catch(() => {})
  const onEvent = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some((item) => isUserInput(item, requestId))) {
      claimed = true
      start.resolve()
    }
    if (!claimed || reason) return
    if (event.type === 'assistant/message') {
      const candidate = rootText(event)
      if (candidate.trim()) text = candidate
    }
    if (event.type === 'turn/end') {
      reason = event.data.reason.kind
      failure = event.data.reason.error?.message
    }
    if (event.type === 'tool/call') emit({ type: 'status', mode: 'working', text: 'DSH 正在执行工具' })
    if (event.type === 'tool/result') emit({ type: 'status', mode: 'thinking', text: 'DSH 正在思考' })
    if (event.type === 'approval/asked') emit({ type: 'status', mode: 'waiting', text: '请在 DSH 窗口确认操作' })
  })
  const onError = ctx.on('agent/error', ({ agent: current, error }) => {
    if (current !== agent) return
    failure = error?.message
    if (!claimed) start.reject(new Error(failure || 'DSH 未能启动这一轮'))
  })
  const stop = () => {
    start.reject(signal.reason)
    if (!accepted) return
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find((item) => isUserInput(item, requestId))
    if (pending) agent.inbox.remove(pending.id)
    else if (claimed && !reason) agent.cancel({ kind: 'user' }, { keepInbox: true })
  }
  const timer = setTimeout(() => start.reject(new Error('DSH 未及时开始处理这条消息')), 30000)
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    await ctx.sessionController.prompt({
      sessionId: agent.session.id, requestId, mode: 'queue', content: [{ type: 'text', text: input.text }]
    }, signal)
    accepted = true
    if (signal.aborted) stop()
    await start.promise
    clearTimeout(timer)
    await agent.whenIdle()
    signal.throwIfAborted()
    if (reason !== 'completed') throw new Error(failure || `DSH 任务未完成（${reason ?? '未知状态'}）`)
    if (!text.trim()) throw new Error('DSH 已完成这一轮，未返回文字')
    return text
  } finally {
    clearTimeout(timer)
    // Retire any input that was accepted but never claimed.
    if (accepted && !claimed) {
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find((item) => isUserInput(item, requestId))
      if (pending) agent.inbox.remove(pending.id)
    }
    signal.removeEventListener('abort', stop)
    onEvent()
    onError()
  }
}

export function apply(ctx) {
  const token = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  let busy = false
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(401, { error: 'DSH 桥接身份已失效' })
      return
    }
    if (req.method === 'GET' && req.url === '/sessions') {
      try {
        const { items } = await ctx.sessionController.list({}, AbortSignal.timeout(4000))
        json(200, { sessions: items.filter((item) => item.origin !== 'subagent' && !item.archived).map((item) => ({
          id: item.sessionId, title: item.title ?? '', cwd: typeof item.cwd === 'string' ? item.cwd : '', running: item.running === true
        })) })
      } catch {
        json(503, { error: 'DSH 暂时无法读取会话列表' })
      }
      return
    }
    if (req.url !== '/turn' || req.method !== 'POST') {
      json(404, { error: '无效的 DSH 请求' })
      return
    }
    if (busy) {
      json(409, { error: 'DSH 正在处理上一条 BeWithU 消息' })
      return
    }
    busy = true
    const abort = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, abort.signal])
    res.once('close', () => { if (!res.writableEnded) abort.abort() })
    const emit = (event) => { if (!signal.aborted && !res.destroyed) res.write(JSON.stringify(event) + '\n') }
    try {
      const input = await readPrompt(req)
      signal.throwIfAborted()
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
      emit({ type: 'status', mode: 'thinking', text: 'DSH 正在准备会话' })
      let sessionId = input.sessionId
      if (!sessionId) {
        sessionId = (await readFile(sessionFile, 'utf8').catch(() => '')).trim()
        if (sessionId && 'error' in await ctx.sessionController.resolveAgent(sessionId)) sessionId = ''
        if (!sessionId) {
          signal.throwIfAborted()
          const created = await ctx.sessionController.create({})
          sessionId = created.sessionId
          await writeFile(sessionFile, sessionId, { mode: 0o600 })
        }
      }
      const result = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in result) throw new Error('所选 DSH 对话已不可用，请在设置中重新选择')
      const answer = await runTurn(ctx, result.agent, input, emit, signal)
      emit({ type: 'result', text: answer })
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      if (!res.headersSent && !res.destroyed) json(400, { error: message })
      else emit({ type: 'error', message })
    } finally {
      busy = false
      if (!res.writableEnded) res.end()
    }
  })
  server.on('error', (error) => ctx.logger.error('BeWithU 桥接监听失败', error))
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address()
    if (!address || typeof address === 'string') return
    const descriptor = JSON.stringify({ version: 1, port: address.port, token })
    const temp = `${connectionFile}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, descriptor, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temp, connectionFile)
    } catch (error) {
      ctx.logger.error('BeWithU 桥接登记失败', error)
      server.close()
    }
  })
  ctx.on('dispose', () => {
    lifetime.abort()
    server.close()
    server.closeAllConnections()
  })
}
