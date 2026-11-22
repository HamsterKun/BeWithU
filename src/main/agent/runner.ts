/** Agent 主循环：LLM ⇄ 工具，支持超时、确认与中断。 */
import { settingsStore } from '../store/settings'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { historyStore } from '../store/history'
import { contextStore } from '../store/context'
import { assembleMessages, budgetFor, estimateTokens } from '../services/context'
import { providerWindow } from '../services/model-info'
import { resolveModelWindow } from '../../shared/model-window'
import type { ChatMessage, ContentPart } from '../services/llm'
import type { HistoryMessage } from '../../shared/types'
import { log } from '../logger'
import { getTool, listTools, toOpenAiTools, buildWireMap } from './registry'
import { callTool } from './index'
import { ensureMcpTools } from './index'
import { chatWithTools, type AgentToolCall } from './llm-agent'
import { checkDangerous } from './policy'
import { resolvePendingByText } from './approval'
import { skillsPromptSection } from './skills'
import { DELAY_TOOL_ID, parseDelayFollowUp, validDelaySeconds } from './tools/delay'
import type { AgentScreenshot, ToolDef, ToolResult } from './types'
import { serializeToolResult } from './tool-result'
import { AgentTaskContext, type AgentMessage } from './task-context'
import { withSignal } from './cancellation'

export interface AgentEvents {
  /** 模型说的话（用于气泡显示 + 播报） */
  onText: (text: string) => void
  /** 模型的思考内容（只展示，不播报） */
  onReasoning?: (text: string) => void
  /** 中间轮的过程叙述（带工具调用的那一轮说的话），不进最终回答 */
  onNarration?: (text: string) => void
  /** 一步工具开始 */
  onStep: (info: { index: number; toolId: string; summary: string; mode: 'working' | 'waiting' }) => void
  /** 一步工具结束 */
  onStepDone?: (info: { index: number; toolId: string; ok: boolean; summary: string }) => void
  /** 高风险工具需要用户确认（返回 true=允许） */
  onApproval?: (req: { toolId: string; title: string; detail: string }) => Promise<boolean>
}

export interface AgentRunResult {
  text: string
  steps: number
  stopped: boolean
}

type StepResult = ToolResult & { approvalDenied?: true }

/** 两个字符串的最长公共前缀长度 */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * 有些模型/网关会把思考内容再抄一份到正文开头，或者用 <thinking> 包住。
 * 这里做最小限度的清理：去标签、裁掉与 reasoning 重合的前缀。
 */
export function stripReasoningLeak(text: string, reasoning?: string): string {
  let t = String(text ?? '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim()
  const r = String(reasoning ?? '').trim()
  if (t && r.length >= 20) {
    const n = commonPrefixLen(t, r)
    if (n >= 12) t = t.slice(n).trim() || t
  }
  return t
}

function buildSystemPrompt(shellEnabled: boolean): string {
  const s = settingsStore.get()
  const skills = s.agent.skillsEnabled ? skillsPromptSection() : ''
  const shellRule = shellEnabled
    ? '4. 部分本地工具免确认；MCP 仍须确认。用户拒绝或任务停止后不得继续。'
    : '4. 高风险操作需要确认。用户拒绝或任务停止后不得继续。'
  const rules = (s.prompts?.agent || DEFAULT_SETTINGS.prompts.agent)
    .replaceAll('{{shell_rule}}', shellRule)
  return [s.llm.systemPrompt, '', rules, skills ? `\n${skills}` : ''].filter(Boolean).join('\n')
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 把常见错误翻译成用户能看懂的话（原文进日志，气泡里只放短句） */
function friendlyAgentError(msg: string): string {
  if (/Invalid 'tools|tool_calls|function\.name/i.test(msg)) {
    return '这个模型不接受工具调用（接口返回 400）。可以到「设置 → Agent 能力」关掉 Agent 只聊天，或换一个支持 function calling 的模型。'
  }
  if (/HTTP 401|HTTP 403|invalid_api_key|Unauthorized/i.test(msg)) {
    return '大模型鉴权失败（401/403），检查一下 API Key 是否填对、有没有过期。'
  }
  if (/HTTP 404|model_not_found|does not exist/i.test(msg)) {
    return '模型名找不到（404），检查模型名/接入点 ID 是否正确。'
  }
  if (/abort|cancel/i.test(msg)) return '已取消'
  const short = msg.replace(/\s+/g, ' ').slice(0, 120)
  return `模型调用失败：${short}`
}

function summarizeArgs(def: ToolDef, args: Record<string, unknown>): string {
  const pick = (k: string): string => (args[k] === undefined ? '' : String(args[k]))
  switch (def.id) {
    case 'shell.ps':
      return `${pick('purpose')}\n\n${pick('script').slice(0, 500)}`
    case 'file.write':
      return `写入 ${pick('path')}\n\n${pick('content').slice(0, 240)}`
    case 'input.type':
      return `输入到当前窗口：${pick('text').slice(0, 200)}`
    case 'app.launch':
      return `启动 ${pick('name')}`
    default: {
      const json = JSON.stringify(args)
      return json.length > 300 ? `${json.slice(0, 300)}…` : json
    }
  }
}

function screenshotParts(shot: AgentScreenshot, origin: string, clickTool?: string): ContentPart[] {
  const hint = clickTool
    ? `点击图中位置时，直接将 captureId 和以图像左上角为原点的像素坐标 x、y 传给 ${clickTool}，坐标会自动换算。`
    : ''
  return [
    { type: 'text', text: `${origin}（图像 ${shot.width}×${shot.height}，captureId: ${shot.captureId}）。${hint}` },
    { type: 'image_url', image_url: { url: shot.dataUrl } }
  ]
}

export async function runAgentTask(
  userText: string,
  opts: {
    signal: AbortSignal
    events: AgentEvents
    image?: AgentScreenshot
    /** 未归档的历史快照（由调用方在写入本轮输入之前取） */
    history?: HistoryMessage[]
  }
): Promise<AgentRunResult> {
  const s = settingsStore.get()
  const cfg = s.agent
  // MCP 工具是动态的：每次任务开始前刷新一次（连不上就跳过）
  await ensureMcpTools(opts.signal)
  if (opts.signal.aborted) return { text: '（已停止）', steps: 0, stopped: true }
  const enabled = listTools()
    .filter((t) => !cfg.disabledTools.includes(t.id))
    // 关了技能开关就把 skill.read 一起藏起来，别让模型看见一个必然失败的入口
    .filter((t) => cfg.skillsEnabled || t.id !== 'skill.read')
  const tools = toOpenAiTools(enabled.map((t) => t.id))
  const window = resolveModelWindow(s.llm.model, s.context.modelWindow, providerWindow(s.llm.model)).window
  const contextBudget = Math.max(1000, Math.floor(budgetFor(s.context.level, window) * 0.9) - estimateTokens(JSON.stringify(tools)))
  const taskContext = new AgentTaskContext()
  const enabledById = new Map(enabled.map((t) => [t.id, t]))
  // 模型看到的是 input_type，回来要换回 input.type
  const wireToReal = buildWireMap(enabled.map((t) => t.id))
  const clickTool = [...wireToReal].find(([, id]) => id === 'input.click')?.[0]
  // 和闲聊走同一套组装：摘要、时间戳、历史口径完全一致（以前这里是 recent(6) 且没有摘要）
  const initialMessages = assembleMessages({
    systemPrompt: buildSystemPrompt(cfg.shellEnabled),
    summary: contextStore.getSummary(),
    history: opts.history ?? historyStore.since(contextStore.archivedUpTo()),
    userText,
    now: Date.now(),
    timeAwareness: s.context.timeAwareness
  })
  const messages: AgentMessage[] = [...initialMessages]
  const initialUser = initialMessages[initialMessages.length - 1]
  const initialContent = initialUser.content
  if (opts.image && typeof initialContent === 'string') {
    const note = s.prompts?.visionNote || DEFAULT_SETTINGS.prompts.visionNote
    initialUser.content = screenshotParts(
      opts.image, `${initialContent}\n\n${note}\n这是 BeWithU 在本轮开始时自动截取的桌面画面`, clickTool
    )
  }
  let latestScreenshots: ChatMessage | undefined
  let imagesRejected = false

  const askModel = async (closing?: string) => {
    if (!settingsStore.get().llm.vision.enabled) {
      initialUser.content = initialContent
      if (latestScreenshots) latestScreenshots.content = '屏幕理解已关闭，截屏结果仅保存在本机。'
      latestScreenshots = undefined
    }
    taskContext.fit(messages, initialUser, latestScreenshots, contextBudget)
    const request: Parameters<typeof chatWithTools>[0] = {
      messages: closing ? [...messages, { role: 'user', content: closing }] : messages,
      tools: closing ? [] : tools,
      toolChoice: closing ? 'none' : 'auto',
      signal: opts.signal,
      scenario: userText
    }
    try {
      return await chatWithTools(request)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (opts.signal.aborted || imagesRejected ||
          !(latestScreenshots || Array.isArray(initialUser.content)) ||
          !/image|vision|multi-?modal|content[ _-]?type|unsupported/i.test(msg)) throw error

      imagesRejected = true
      initialUser.content = initialContent
      if (latestScreenshots) {
        latestScreenshots.content = '截图工具已保存画面，但当前模型接口拒绝接收图片，无法查看截图。'
        latestScreenshots = undefined
      }
      log('vision: Agent 模型拒绝图片，降级为纯文字')
      return await chatWithTools(request)
    }
  }

  let steps = 0
  let finalText = ''
  let stopped = false
  /** 记下每一步做了什么，模型没给收尾时用它拼一句人话 */
  const stepLog: { name: string; ok: boolean; summary: string }[] = []

  const runStep = async (toolId: string, args: Record<string, unknown>, error?: string): Promise<StepResult> => {
    const def = enabledById.get(toolId)
    const index = ++steps
    const name = def?.name ?? toolId
    const waiting = toolId === DELAY_TOOL_ID && !error && validDelaySeconds(args.seconds)
    const info = { index, toolId }
    opts.events.onStep({ ...info, summary: waiting ? `等待 ${args.seconds} 秒` : name, mode: waiting ? 'waiting' : 'working' })
    const result = error ? { ok: false, summary: error } : await runOne(def, args, toolId, cfg, opts)
    stepLog.push({ name, ok: result.ok, summary: result.summary.slice(0, 160) })
    if (stepLog.length > 30) stepLog.shift()
    opts.events.onStepDone?.({ ...info, ok: result.ok, summary: result.summary })
    log('agent: 工具结果', `${toolId} ${result.ok ? 'ok' : 'fail'}`)
    return result
  }

  while (!opts.signal.aborted) {
    let turn
    try {
      turn = await askModel()
    } catch (e) {
      if (opts.signal.aborted) break
      const msg = e instanceof Error ? e.message : String(e)
      log('agent: LLM 调用失败', msg)
      const text = friendlyAgentError(msg)
      // 必须走 onText，否则气泡里什么都不显示，用户以为"没反应"
      opts.events.onText(text)
      return { text, steps, stopped: false }
    }
    if (opts.signal.aborted) break
    if (turn.reasoning?.trim()) opts.events.onReasoning?.(turn.reasoning)
    const hasTools = turn.toolCalls.length > 0
    if (turn.text.trim()) {
      if (hasTools) {
        // 带工具调用的那一轮：模型往往在"边想边说"，这段不是给用户的回答，
        // 混进气泡就会变成"回复里掺思考"，这里只留给日志
        opts.events.onNarration?.(turn.text)
      } else {
        finalText = stripReasoningLeak(turn.text, turn.reasoning)
        opts.events.onText(finalText)
      }
    }
    if (!hasTools) break

    messages.push({
      role: 'assistant',
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((c: AgentToolCall) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args }
      }))
    })

    const captures: ContentPart[] = []
    for (let callIndex = 0; callIndex < turn.toolCalls.length; callIndex++) {
      const call = turn.toolCalls[callIndex]
      if (opts.signal.aborted) {
        stopped = true
        break
      }
      const realId = wireToReal.get(call.name)
      if (!realId) {
        steps += 1
        opts.events.onNarration?.('模型返回了本轮未开放的工具名，已拒绝执行。')
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, result: '工具未在本轮授权列表中' }) })
        continue
      }
      const parsed = parseArgs(call.args)
      const args = parsed ?? {}
      const isDelay = realId === DELAY_TOOL_ID
      let after: { id: string; args: Record<string, unknown> } | undefined
      let error = parsed === null ? '工具参数不是有效的 JSON 对象，请修正后再调用' : undefined
      if (isDelay && !error && Object.hasOwn(args, 'then')) {
        const followUp = parseDelayFollowUp(args.then)
        const id = followUp && wireToReal.get(followUp.name)
        if (!followUp) error = '后续工具需提供工具名和参数对象'
        else if (!id || id === DELAY_TOOL_ID) error = '后续工具必须来自本轮已开放的工具列表，且不能是延时工具'
        else after = { id, args: followUp.arguments }
      }

      let result = await runStep(realId, isDelay ? { seconds: args.seconds } : args, error)
      if (result.ok && after && !opts.signal.aborted) {
        const next = await runStep(after.id, after.args)
        result = {
          ...next,
          summary: `${result.summary}。后续工具结果：${next.summary}`,
          data: { wait: result.data, tool: after.id, result: next.data }
        }
      }
      let summary = result.summary
      const images = result.screenshot ? [result.screenshot] : result.images ?? []
      if (images.length) {
        const kind = result.screenshot ? '截图' : '图像'
        if (imagesRejected) summary += `。当前模型接口拒绝图片，无法查看${kind}。`
        else if (!settingsStore.get().llm.vision.enabled) summary += `。开启屏幕理解后才能查看${kind}。`
        else {
          if (result.screenshot) {
            captures.push(...screenshotParts(result.screenshot, `以下为工具调用 ${call.id} 返回的桌面截图`, clickTool))
          } else {
            captures.push(
              { type: 'text', text: `以下为工具调用 ${call.id} 返回的图像。` },
              ...images.map(({ dataUrl }) => ({ type: 'image_url' as const, image_url: { url: dataUrl } }))
            )
          }
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResult(result, summary)
      })
      if (result.approvalDenied) {
        stopped = true
        finalText = '操作未获确认，已停止这次任务。'
        opts.events.onText(finalText)
        break
      }
    }
    if (stopped) break
    if (captures.length && !opts.signal.aborted) {
      initialUser.content = initialContent
      if (latestScreenshots) latestScreenshots.content = '本组工具截图已由后续的截图更新。'
      // Chat Completions 的 tool 消息只支持文本。等这组工具回包齐全后，再用多模态 user 消息附图。
      latestScreenshots = { role: 'user', content: captures }
      messages.push(latestScreenshots)
    }
  }

  if (opts.signal.aborted) stopped = true
  if (!finalText) {
    // 模型跑完工具却没写收尾：单独再来一轮，禁用工具，逼它用人话汇报
    if (!stopped && stepLog.length) {
      try {
        const closing = await askModel(settingsStore.get().prompts?.closing || DEFAULT_SETTINGS.prompts.closing)
        if (closing.text.trim()) {
          finalText = closing.text.trim()
          opts.events.onText(finalText)
        }
      } catch (e) {
        log('agent: 收尾总结失败', e instanceof Error ? e.message : e)
      }
    }
    if (!finalText) {
      finalText = stopped ? '（已停止）' : fallbackText(stepLog)
      opts.events.onText(finalText)
    }
  }
  return { text: finalText, steps, stopped }
}

/** 连收尾轮都失败时，用人话说一句，别把步骤日志摊给用户 */
function fallbackText(stepLog: { name: string; ok: boolean; summary: string }[]): string {
  const clip = (s: string, n: number): string => s.replace(/\s+/g, ' ').slice(0, n)
  const failed = stepLog.filter((s) => !s.ok)
  if (failed.length) {
    return `中间卡住了：${clip(failed[failed.length - 1].summary, 80)}。要不要我换个方式再试一次？`
  }
  const last = stepLog[stepLog.length - 1]
  if (last) return `${clip(last.summary, 100)}。你看看这样是不是你要的？`
  return '这次没拿到结果，你换个说法我再试试。'
}

/** 单个工具：禁用检查 → 危险命令检查 → 高风险确认 → 执行（带超时） */
async function runOne(
  def: ToolDef | undefined,
  args: Record<string, unknown>,
  toolId: string,
  cfg: ReturnType<typeof settingsStore.get>['agent'],
  opts: { signal: AbortSignal; events: AgentEvents }
): Promise<StepResult> {
  if (opts.signal.aborted) return { ok: false, summary: '任务已取消，工具未执行' }
  if (!def) return { ok: false, summary: `没有这个工具：${toolId}` }
  if (cfg.disabledTools.includes(def.id)) return { ok: false, summary: `工具 ${def.id} 已被用户禁用` }
  const agent = settingsStore.get().agent
  if (!agent.enabled || agent.disabledTools.includes(def.id) || getTool(def.id) !== def ||
    (!agent.skillsEnabled && def.id === 'skill.read')) {
    return { ok: false, summary: '工具权限或配置已变更，本次操作未执行' }
  }

  // shell 未开启：不执行，交给工具自己给出"去开启"的引导
  const dangerText = [String(args.script ?? ''), String(args.path ?? ''), String(args.content ?? '')].join('\n')
  const danger = checkDangerous(dangerText)
  if (!danger.ok) return { ok: false, summary: danger.reason ?? '被安全策略拒绝' }

  // MCP 未知副作用始终需要确认。命令检查只是补充，不构成隔离。
  const requiresApproval = def.risk === 'high' && (!settingsStore.get().agent.shellEnabled || def.id.startsWith('mcp.'))
  if (requiresApproval) {
    const approved = opts.events.onApproval
      ? await withSignal(
        opts.events.onApproval({ toolId: def.id, title: def.name, detail: summarizeArgs(def, args) }),
        opts.signal
      ).catch((error) => {
        if (opts.signal.aborted) return false
        throw error
      })
      : false
    if (opts.signal.aborted) return { ok: false, summary: '任务已取消，工具未执行' }
    if (!approved) return { ok: false, approvalDenied: true, summary: '用户拒绝或未确认，本次任务已停止' }
  }

  const currentAgent = settingsStore.get().agent
  if (!currentAgent.enabled || currentAgent.disabledTools.includes(def.id) || getTool(def.id) !== def ||
    (!currentAgent.skillsEnabled && def.id === 'skill.read')) {
    return { ok: false, summary: '工具权限或配置已变更，本次操作未执行' }
  }
  if (opts.signal.aborted) return { ok: false, summary: '任务已取消，工具未执行' }
  // 延时有自己的计时上限，仍随当前任务取消。普通工具的执行超时应用于后续工具本身。
  if (toolId === DELAY_TOOL_ID) return await callTool(def.id, args, { signal: opts.signal })
  const operation = new AbortController()
  const signal = AbortSignal.any([opts.signal, operation.signal])
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      operation.abort()
      resolve({ ok: false, summary: '工具超时；操作已请求取消，外部副作用结果未知' })
    }, cfg.stepTimeoutMs)
  })
  try {
    return await withSignal(Promise.race([callTool(def.id, args, { signal }), timeout]), opts.signal)
  } catch (e) {
    return { ok: false, summary: timedOut ? '工具超时；外部副作用结果未知' : (e instanceof Error ? e.message : String(e)) }
  } finally {
    if (timer) clearTimeout(timer)
    operation.abort()
  }
}

export { resolvePendingByText }
