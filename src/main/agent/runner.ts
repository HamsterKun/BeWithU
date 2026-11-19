/** Agent 主循环：LLM ⇄ 工具，带步数上限、超时、确认与中断 */
import { settingsStore } from '../store/settings'
import { historyStore } from '../store/history'
import { log } from '../logger'
import { listTools, toOpenAiTools, buildWireMap } from './registry'
import { callTool } from './index'
import { ensureMcpTools } from './index'
import { chatWithTools, type AgentToolCall } from './llm-agent'
import { checkDangerous } from './policy'
import { resolvePendingByText } from './approval'
import { skillsPromptSection } from './skills'
import type { ToolDef, ToolResult } from './types'

export interface AgentEvents {
  /** 模型说的话（用于气泡显示 + 播报） */
  onText: (text: string) => void
  /** 模型的思考内容（只展示，不播报） */
  onReasoning?: (text: string) => void
  /** 中间轮的过程叙述（带工具调用的那一轮说的话），不进最终回答 */
  onNarration?: (text: string) => void
  /** 一步工具开始 */
  onStep: (info: { index: number; total: number; toolId: string; summary: string }) => void
  /** 一步工具结束 */
  onStepDone?: (info: { index: number; total: number; toolId: string; ok: boolean; summary: string }) => void
  /** 高风险工具需要用户确认（返回 true=允许） */
  onApproval?: (req: { toolId: string; title: string; detail: string }) => Promise<boolean>
}

export interface AgentRunResult {
  text: string
  steps: number
  stopped: boolean
}


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

function buildSystemPrompt(maxSteps: number, shellEnabled: boolean): string {
  const s = settingsStore.get()
  const skills = s.agent.skillsEnabled ? skillsPromptSection() : ''
  const searchOn = s.search.enabled
  return [
    s.llm.systemPrompt,
    '',
    '【你现在可以使用工具直接操作这台电脑】',
    '工作规则：',
    '1. 改文件、处理文档、批量操作时优先用文件工具或 shell，不要用模拟键鼠去打字编辑文本；键鼠只用来操作图形界面（点按钮、切窗口、拖拽）。',
    '2. 一步只做一件小事，看结果再决定下一步；不要重复同样的失败尝试。',
    `3. 本次任务最多 ${maxSteps} 步，做完用 1-3 句话汇报结果。`,
    shellEnabled
      ? '4. 完全信任模式已开启：所有工具（Shell、文件写入、键鼠）都直接执行，不会再有确认卡。删盘/格式化这类硬红线仍然执行不了。'
      : '4. 高风险操作会弹确认卡；看到"用户拒绝"就停下并说明。如果用户嫌麻烦，可以让 TA 去「设置 → Agent 能力」开「完全信任模式」。',
    '5. 高风险操作需要用户确认；看到"用户拒绝"就停下并说明，不要绕过。',
    '6. 不要编造工具结果，只根据工具返回汇报。',
    '7. 调用工具之前不要写"我先把…打开"这类过程叙述；直接用工具，最后一次性汇报结果。',
    '8. 汇报时不要复述用户的原话，不要描述你的思考过程或用了哪个工具。',
    searchOn
      ? '7. 遇到时效性问题（今天/最近/最新、新闻、比分、价格、版本、发布会、谁赢了、有没有出新东西）先调 web.search 查，再基于结果回答，并带上来源链接；日常闲聊、情感陪伴、写代码、常识问题不要搜。'
      : '7. 现在没有联网搜索能力：涉及最新消息时如实说查不到，不要编造。',
    skills ? `\n${skills}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
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

export async function runAgentTask(
  userText: string,
  opts: { signal: AbortSignal; events: AgentEvents; image?: { dataUrl: string } }
): Promise<AgentRunResult> {
  const cfg = settingsStore.get().agent
  const maxSteps = cfg.maxSteps
  // MCP 工具是动态的：每次任务开始前刷新一次（连不上就跳过）
  await ensureMcpTools()
  const enabled = listTools()
    .filter((t) => !cfg.disabledTools.includes(t.id))
    // 关了技能开关就把 skill.read 一起藏起来，别让模型看见一个必然失败的入口
    .filter((t) => cfg.skillsEnabled || t.id !== 'skill.read')
  const tools = toOpenAiTools(enabled.map((t) => t.id))
  // 模型看到的是 input_type，回来要换回 input.type
  const wireToReal = buildWireMap(enabled.map((t) => t.id))
  const history = historyStore.recent(6).map((m) => ({ role: m.role, content: m.content }))
  // 屏幕理解：首轮带上截图；模型不支持图片时自动降级为纯文字
  let useImage = Boolean(opts.image?.dataUrl)
  const userMessage = (): Record<string, unknown> =>
    useImage && opts.image
      ? {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: opts.image.dataUrl } }
          ]
        }
      : { role: 'user', content: userText }
  const messages: unknown[] = [
    { role: 'system', content: buildSystemPrompt(maxSteps, cfg.shellEnabled) },
    ...history,
    userMessage()
  ]
  const userIndex = messages.length - 1
  let retriedNoImage = false

  let steps = 0
  let finalText = ''
  let stopped = false
  /** 记下每一步做了什么，模型没给收尾时用它拼一句人话 */
  const stepLog: { name: string; ok: boolean; summary: string }[] = []

  while (steps < maxSteps && !opts.signal.aborted) {
    let turn
    try {
      turn = await chatWithTools({ messages, tools, signal: opts.signal, scenario: userText })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 模型不支持图片：去掉图再试一次
      if (useImage && !retriedNoImage && /image|vision|multi-?modal|content[ _-]?type|unsupported/i.test(msg)) {
        retriedNoImage = true
        useImage = false
        messages[userIndex] = { role: 'user', content: userText }
        log('vision: Agent 模型拒绝图片，降级为纯文字', msg)
        opts.events.onText('（这个模型不支持看图，这次先不看了）')
        continue
      }
      log('agent: LLM 调用失败', msg)
      const text = friendlyAgentError(msg)
      // 必须走 onText，否则气泡里什么都不显示，用户以为"没反应"
      opts.events.onText(text)
      return { text, steps, stopped: false }
    }
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

    for (const call of turn.toolCalls) {
      if (opts.signal.aborted) {
        stopped = true
        break
      }
      steps += 1
      const realId = wireToReal.get(call.name) ?? call.name
      const def = listTools().find((t) => t.id === realId)
      const args = parseArgs(call.args)
      opts.events.onStep({
        index: steps,
        total: maxSteps,
        toolId: realId,
        summary: def?.name ?? realId
      })

      const result = await runOne(def, args, { ...call, name: realId }, cfg, opts)
      stepLog.push({ name: def?.name ?? realId, ok: result.ok, summary: result.summary })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: result.ok, result: result.summary }).slice(0, 4000)
      })
      opts.events.onStepDone?.({ index: steps, total: maxSteps, toolId: realId, ok: result.ok, summary: result.summary })
      log('agent: 工具结果', `${realId} ${result.ok ? 'ok' : 'fail'}`)
    }
    if (stopped) break
  }

  if (!finalText) {
    // 模型跑完工具却没写收尾：单独再来一轮，禁用工具，逼它用人话汇报
    if (!stopped && stepLog.length) {
      try {
        const closing = await chatWithTools({
          messages: [
            ...messages,
            {
              role: 'user',
              content: '现在用 1-3 句话直接告诉用户结果（做了什么、结果如何、下一步建议），不要再调用任何工具。'
            }
          ],
          tools: [],
          toolChoice: 'none',
          signal: opts.signal,
          scenario: userText
        })
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
  call: AgentToolCall,
  cfg: ReturnType<typeof settingsStore.get>['agent'],
  opts: { signal: AbortSignal; events: AgentEvents }
): Promise<ToolResult> {
  if (!def) return { ok: false, summary: `没有这个工具：${call.name}` }
  if (cfg.disabledTools.includes(def.id)) return { ok: false, summary: `工具 ${def.id} 已被用户禁用` }

  // shell 未开启：不执行，交给工具自己给出"去开启"的引导
  const dangerText = [String(args.script ?? ''), String(args.path ?? ''), String(args.content ?? '')].join('\n')
  const danger = checkDangerous(dangerText)
  if (!danger.ok) return { ok: false, summary: danger.reason ?? '被安全策略拒绝' }

  // 完全信任模式：所有工具（含 Shell / 写文件 / 键鼠）直接执行，不再逐次确认。
  // 硬红线（policy.ts）仍然在上面拦过，删盘/格式化这类永远执行不了。
  if (def.risk === 'high' && !cfg.shellEnabled) {
    const approved = opts.events.onApproval
      ? await opts.events.onApproval({ toolId: def.id, title: def.name, detail: summarizeArgs(def, args) })
      : false
    if (!approved) return { ok: false, summary: '用户拒绝了这次操作，请停下来并向用户说明' }
  }

  const timeout = new Promise<ToolResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, summary: '工具执行超时' }), cfg.stepTimeoutMs)
  )
  try {
    return await Promise.race([callTool(def.id, args, { signal: opts.signal }), timeout])
  } catch (e) {
    return { ok: false, summary: e instanceof Error ? e.message : String(e) }
  }
}

export { resolvePendingByText }
