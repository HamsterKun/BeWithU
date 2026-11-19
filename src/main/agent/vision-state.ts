/** 视觉能力状态：当前会话里模型是否已经明确拒绝过图片 */
let unsupported = false

export function markVisionUnsupported(): void {
  unsupported = true
}

export function isVisionUnsupported(): boolean {
  return unsupported
}

export function resetVisionUnsupported(): void {
  unsupported = false
}
