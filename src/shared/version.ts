/**
 * 版本号比较。只做「够用且不容易错」的实现，不引 semver 依赖。
 * 规则：去掉 v 前缀，按数字段比较，缺的段当 0；带预发布后缀的永远小于正式版。
 */
function parse(v: string): { nums: number[]; pre: string } {
  const raw = String(v ?? '').trim().replace(/^[vV]/, '')
  const dash = raw.indexOf('-')
  const core = dash >= 0 ? raw.slice(0, dash) : raw
  const pre = dash >= 0 ? raw.slice(dash + 1) : ''
  const nums = core.split('.').map((part) => {
    const n = parseInt(part.replace(/[^\d].*$/, ''), 10)
    return Number.isFinite(n) ? n : 0
  })
  return { nums, pre }
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  // 同样的数字段，带 -beta 的算更旧
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre > pb.pre ? 1 : -1
}

/** candidate 是否比 current 新（只有更新才提示，降级不提示） */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}
