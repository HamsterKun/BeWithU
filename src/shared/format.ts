/** 数字展示的小工具（纯函数，方便单测） */

function trimZero(text: string): string {
  return text.replace(/\.0$/, '')
}

/**
 * token 数的紧凑显示：
 * 987 654 → 988k、1 000 000 → 1M、77 141 → 77.1k。
 * 十万以下保留一位小数（77.1k 比 77k 有用），再往上取整免得字太长。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? Math.round(m) : trimZero(m.toFixed(1))}M`
  }
  if (n >= 10_000) {
    return n >= 100_000 ? `${Math.round(n / 1000)}k` : `${trimZero((n / 1000).toFixed(1))}k`
  }
  return String(Math.round(n))
}
