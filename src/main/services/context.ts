/**
 * 上下文管理内核：预算换算、token 估算、时间戳、消息组装、压缩切分。
 *
 * 两条不能破的约束（破了这功能就没意义）：
 * 1) **前缀稳定**：历史消息只追加不改写，时间戳在写入时冻结；
 *    任何"每轮重算"的内容只能出现在最后一条消息里。
 * 2) **不在稳定窗口上滑动**：不做"只留最近 N 轮"的裁剪，靠压缩（一次压很多）来腾空间。
 */
import type { ContextLevel, HistoryMessage, TimeAwareness } from '../../shared/types'
import type { ChatMessage } from './llm'

/** 涨到预算的这个比例就触发压缩 */
export const WATERMARK = 0.85
/** 一次压到预算的这个比例以下（压够，避免反复触发击穿缓存） */
export const TARGET = 0.45

/** 估算误差缓冲：给"算少了"留后路 */
export const SAFETY_TOKENS = 4096

/** 一张 1280×800 截图的经验值 */
export const IMAGE_TOKENS = 1200

/** 给本轮回答和工具循环留的空间 */
export function reservedOutput(window: number): number {
  return Math.min(8192, Math.floor(window * 0.15))
}

/** 模型窗口里真正能塞上下文的量 */
export function usableTokens(window: number): number {
  return Math.max(2000, Math.floor(window) - reservedOutput(window) - SAFETY_TOKENS)
}

export interface LevelBudgets {
  low: number
  mid: number
  high: number
}

/** 三挡 = 可用上限的 1/3、2/3、全部 */
export function levelBudgets(window: number): LevelBudgets {
  const usable = usableTokens(window)
  return {
    low: Math.round(usable / 3),
    mid: Math.round((usable * 2) / 3),
    high: usable
  }
}

export function budgetFor(level: ContextLevel, window: number): number {
  return levelBudgets(window)[level] ?? levelBudgets(window).mid
}

/** 摘要字数上限：跟着档位走，不单独暴露设置 */
export function summaryCharsFor(level: ContextLevel): number {
  return level === 'low' ? 1800 : level === 'high' ? 4500 : 3000
}

/* ------------------------------------------------------------------ 估算 ---- */

function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (
    (c >= 0x3000 && c <= 0x9fff) || // CJK 标点 / 假名 / 汉字
    (c >= 0xac00 && c <= 0xd7af) || // 韩文
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef) // 全角标点
  )
}

/** 纯估算，不做校准（单测依赖它的确定性） */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of String(text ?? '')) {
    if (isCjk(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 3.5)
}

/** 每条消息的结构开销（role / 分隔符） */
const PER_MESSAGE = 4

/** 校准系数：用服务端返回的 prompt_tokens 反推，进程内有效 */
let calibration = 1

export function getCalibration(): number {
  return calibration
}

export function resetCalibration(): void {
  calibration = 1
}

/** 用真实值校准估算（EWMA）。真实值明显离谱时忽略，避免一次脏数据带偏 */
export function calibrate(actualTokens: number, estimatedTokens: number): void {
  if (!actualTokens || !estimatedTokens) return
  const ratio = actualTokens / estimatedTokens
  if (ratio < 0.5 || ratio > 2) return
  calibration = calibration * 0.7 + ratio * 0.3
  if (calibration < 0.6) calibration = 0.6
  if (calibration > 1.6) calibration = 1.6
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function hasImage(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((p) => p.type === 'image_url')
}

/** 估算整段 messages 的 token（已含校准与图片） */
export function estimatePrompt(messages: ChatMessage[]): number {
  let total = 3
  for (const message of messages) {
    total += PER_MESSAGE + estimateTokens(textOf(message))
    if (hasImage(message)) total += IMAGE_TOKENS
  }
  return Math.ceil(total * calibration)
}

/* ------------------------------------------------------------ 时间戳 ---- */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 历史消息的时间戳。**必须手写拼**，不能用 toLocaleString：
 * 后者受系统 locale 影响（本机是 `2026/11/20 12:32:23`），换机器就变字节，前缀立刻失效。
 */
export function formatStamp(at: number, now = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getFullYear() !== n.getFullYear()) return `${d.getFullYear()}-${md} ${hhmm}`
  return `${md} ${hhmm}`
}

function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** 本轮的时间标记：绝对时间 + 星期，间隔够久才附带"距上一条多久" */
export function formatNow(now: number, lastAt?: number): string {
  const d = new Date(now)
  let text = `现在 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${WEEK[d.getDay()]}`
  if (lastAt && lastAt > 0) {
    const gap = now - lastAt
    if (gap > 5 * 60 * 1000) text += ` · 距上一条 ${formatGap(gap)}`
  }
  return `[${text}]`
}

/** 写进 system 的静态说明：内容永不变，否则每轮都会击穿缓存 */
export const TIME_NOTE =
  '消息前的 [MM-DD HH:mm] 是该消息的发生时间，只用来判断事情先后与间隔；不要主动报时，也不要拿它当话题。'

/* -------------------------------------------------------------- 组装 ---- */

export interface AssembleInput {
  systemPrompt: string
  /** 已经压缩过的更早对话 */
  summary: string
  /** 未归档的历史，按时间升序 */
  history: HistoryMessage[]
  userText: string
  now: number
  timeAwareness: TimeAwareness
  /** 本轮附带的截图（只影响最后一条消息，不影响前缀） */
  image?: { dataUrl: string; note: string }
}

/** 摘要块的固定开头：内容只在压缩时变，标题必须稳定 */
export const SUMMARY_HEADER = '【更早的对话摘要】以下是更早之前聊过的要点，回答时当作你已经知道：'

/** 把 system / 摘要 / 历史 / 本轮输入拼成一条可直接发送的消息数组 */
export function assembleMessages(input: AssembleInput): ChatMessage[] {
  const parts = [input.systemPrompt.trim()]
  if (input.summary.trim()) parts.push(`${SUMMARY_HEADER}\n${input.summary.trim()}`)
  if (input.timeAwareness !== 'off') parts.push(TIME_NOTE)
  const messages: ChatMessage[] = [{ role: 'system', content: parts.filter(Boolean).join('\n\n') }]

  for (const item of input.history) {
    const text = input.timeAwareness === 'full' ? `[${formatStamp(item.at, input.now)}] ${item.content}` : item.content
    messages.push({ role: item.role, content: text })
  }

  const lastAt = input.history.length ? input.history[input.history.length - 1].at : undefined
  const stamp = input.timeAwareness === 'off' ? '' : `\n\n${formatNow(input.now, lastAt)}`
  if (input.image) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `${input.userText}${stamp}\n\n${input.image.note}` },
        { type: 'image_url', image_url: { url: input.image.dataUrl } }
      ]
    })
  } else {
    messages.push({ role: 'user', content: `${input.userText}${stamp}` })
  }
  return messages
}

/* -------------------------------------------------------------- 压缩 ---- */

export interface SplitResult {
  /** 需要归档进摘要的条数（从头开始） */
  cold: number
  /** 保留原文的条数（从尾开始） */
  warm: number
}

/**
 * 压缩切分：保留最近 keepTurns 轮（1 轮 = 用户 + 助手 2 条），其余进摘要。
 * 至少要留 2 条，否则模型连"刚才说到哪"都不知道。
 */
export function splitForCompaction(history: HistoryMessage[], keepTurns: number): SplitResult {
  const total = history.length
  const warm = Math.min(total, Math.max(2, Math.floor(keepTurns) * 2))
  return { cold: total - warm, warm }
}

/** 是否该压缩了 */
export function needsCompaction(used: number, budget: number): boolean {
  return budget > 0 && used >= budget * WATERMARK
}

/** 压缩后是否已经降到达标线（用于判断要不要再压一轮） */
export function compactionDone(used: number, budget: number): boolean {
  return used <= budget * TARGET
}
