export function planToolCalls<T>(remaining: number, calls: T[]): { allowed: T[]; skipped: T[] } {
  const count = Math.max(0, Math.min(Math.floor(remaining), calls.length))
  return { allowed: calls.slice(0, count), skipped: calls.slice(count) }
}
