/** 高风险工具的用户确认：气泡卡片 + 语音"同意"两条路 */
import { log } from '../logger'
import { sendBubble } from '../windows'

export interface ApprovalRequest {
  id: string
  toolId: string
  title: string
  detail: string
}

interface Pending extends ApprovalRequest {
  turnId: number
  resolve: (allowed: boolean) => void
  timer: NodeJS.Timeout
  abortCleanup: () => void
}

const pending = new Map<string, Pending>()
export const APPROVAL_TIMEOUT_MS = 15000

/** 发起确认；超时默认拒绝（安全优先） */
export function requestApproval(
  req: Omit<ApprovalRequest, 'id'>,
  turnId: number,
  signal: AbortSignal
): Promise<boolean> {
  const id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const settle = (allowed: boolean, reason: string): void => {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      clearTimeout(p.timer)
      p.abortCleanup()
      sendBubble({ type: 'approve', req: null })
      log('agent: 审批结束', `${req.toolId}: ${reason}`)
      resolve(allowed)
    }
    const abort = (): void => settle(false, '任务已取消，默认拒绝')
    const timer = setTimeout(() => settle(false, '审批超时，默认拒绝'), APPROVAL_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    const abortCleanup = (): void => signal.removeEventListener('abort', abort)
    pending.set(id, { ...req, id, turnId, resolve, timer, abortCleanup })
    sendBubble({ type: 'approve', req: { id, title: req.title, detail: req.detail } })
    log('agent: 等待确认', `${req.toolId} ${req.title}`)
  })
}

export function cancelApprovalsForTurn(turnId: number): void {
  for (const p of [...pending.values()]) {
    if (p.turnId === turnId) resolveApproval(p.id, false)
  }
}

export function cancelAllApprovals(): void {
  for (const p of [...pending.values()]) resolveApproval(p.id, false)
}

export function isApprovalPending(): boolean {
  return pending.size > 0
}

export function pendingApproval(): ApprovalRequest | null {
  const first = [...pending.values()][0]
  return first ? { id: first.id, toolId: first.toolId, title: first.title, detail: first.detail } : null
}

/** 用户点击气泡上的按钮 */
export function resolveApproval(id: string, allowed: boolean): boolean {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  clearTimeout(p.timer)
  p.abortCleanup()
  sendBubble({ type: 'approve', req: null })
  log('agent: 用户确认', `${p.toolId} -> ${allowed ? '允许' : '拒绝'}`)
  p.resolve(allowed)
  return true
}

const ALLOW_WORDS = new Set(['同意', '可以', '确认', '好的', '好', '行', '允许', '执行', 'go', 'yes', 'ok'])
const DENY_WORDS = new Set(['拒绝', '不要', '不行', '取消', '停', '别', 'no', 'cancel', 'stop'])

function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/[。！.]+$/u, '').trimEnd()
}

/**
 * 语音/文字回复是否在回答确认请求。
 * 返回 true=允许，false=拒绝，null=不是确认语句（走正常对话）
 */
export function interpretApprovalReply(text: string): boolean | null {
  const t = normalizeReply(text)
  if (!t) return null
  if (DENY_WORDS.has(t)) return false
  if (ALLOW_WORDS.has(t)) return true
  return null
}

export function resolvePendingByText(text: string, turnId: number): boolean | null {
  const p = [...pending.values()].find((item) => item.turnId === turnId)
  if (!p) return null
  const verdict = interpretApprovalReply(text)
  if (verdict === null) return null
  resolveApproval(p.id, verdict)
  return verdict
}
