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
  resolve: (allowed: boolean) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
export const APPROVAL_TIMEOUT_MS = 15000

/** 发起确认；超时默认拒绝（安全优先） */
export function requestApproval(req: Omit<ApprovalRequest, 'id'>): Promise<boolean> {
  const id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      sendBubble({ type: 'approve', req: null })
      log('agent: 确认超时，默认拒绝', req.toolId)
      resolve(false)
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, { ...req, id, resolve, timer })
    sendBubble({ type: 'approve', req: { id, title: req.title, detail: req.detail } })
    log('agent: 等待确认', `${req.toolId} ${req.title}`)
  })
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
  sendBubble({ type: 'approve', req: null })
  log('agent: 用户确认', `${p.toolId} -> ${allowed ? '允许' : '拒绝'}`)
  p.resolve(allowed)
  return true
}

const ALLOW_WORDS = /^(同意|可以|确认|好的|好|行|允许|执行|go|yes|ok)/i
const DENY_WORDS = /^(拒绝|不要|不行|取消|停|别|no|cancel|stop)/i

/**
 * 语音/文字回复是否在回答确认请求。
 * 返回 true=允许，false=拒绝，null=不是确认语句（走正常对话）
 */
export function interpretApprovalReply(text: string): boolean | null {
  const t = text.trim()
  if (!t) return null
  if (DENY_WORDS.test(t)) return false
  if (ALLOW_WORDS.test(t)) return true
  return null
}

export function resolvePendingByText(text: string): boolean | null {
  if (!isApprovalPending()) return null
  const verdict = interpretApprovalReply(text)
  if (verdict === null) return null
  const p = [...pending.values()][0]
  if (p) resolveApproval(p.id, verdict)
  return verdict
}
