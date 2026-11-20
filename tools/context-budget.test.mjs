/* 上下文预算与估算（不需要 Electron：context.ts 只有类型导入） */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  WATERMARK,
  TARGET,
  SAFETY_TOKENS,
  IMAGE_TOKENS,
  reservedOutput,
  usableTokens,
  levelBudgets,
  budgetFor,
  summaryCharsFor,
  estimateTokens,
  estimatePrompt,
  splitForCompaction,
  needsCompaction,
  compactionDone,
  calibrate,
  getCalibration,
  resetCalibration
} = await import('../src/main/services/context.ts')

test('输出预留随窗口增长但封顶 8k', () => {
  assert.equal(reservedOutput(128000), 8192)
  assert.equal(reservedOutput(32000), 4800)
  assert.equal(reservedOutput(2000000), 8192)
})

test('可用上限 = 窗口 − 输出预留 − 安全缓冲', () => {
  assert.equal(usableTokens(128000), 128000 - 8192 - SAFETY_TOKENS)
  // 极端小的窗口不会算出负数
  assert.ok(usableTokens(1000) >= 2000)
})

test('三挡 = 可用上限的 1/3、2/3、全部', () => {
  const usable = usableTokens(128000)
  const levels = levelBudgets(128000)
  assert.equal(levels.high, usable)
  assert.equal(levels.mid, Math.round((usable * 2) / 3))
  assert.equal(levels.low, Math.round(usable / 3))
  // 中档恰好是低档的两倍（同一份可用上限换算出来的）
  assert.ok(Math.abs(levels.mid - levels.low * 2) <= 1)
  assert.equal(budgetFor('mid', 128000), levels.mid)
})

test('摘要字数上限按档位放宽', () => {
  assert.equal(summaryCharsFor('low'), 1800)
  assert.equal(summaryCharsFor('mid'), 3000)
  assert.equal(summaryCharsFor('high'), 4500)
})

test('估算：中文按 1 字 1 token，英文按 3.5 字符 1 token', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcdefg'), 2)
  assert.equal(estimateTokens(''), 0)
  // 中英混排落在两者之间
  const mixed = estimateTokens('你好 hello')
  assert.ok(mixed >= 4 && mixed <= 8, String(mixed))
})

test('估算整段消息：含结构开销与图片', () => {
  const text = estimatePrompt([{ role: 'user', content: '你好' }])
  assert.ok(text > 4 && text < 30, String(text))
  const withImage = estimatePrompt([
    { role: 'user', content: [{ type: 'text', text: '看这个' }, { type: 'image_url', image_url: { url: 'data:,' } }] }
  ])
  assert.ok(withImage >= IMAGE_TOKENS, String(withImage))
})

test('校准：用真实值收敛，离谱值被忽略', () => {
  resetCalibration()
  assert.equal(getCalibration(), 1)
  calibrate(2000, 1000)
  assert.ok(getCalibration() > 1)
  const before = getCalibration()
  calibrate(1000, 1000 * 100) // 比率 0.01，太离谱 → 忽略
  assert.equal(getCalibration(), before)
  calibrate(0, 1000)
  assert.equal(getCalibration(), before)
  resetCalibration()
  assert.equal(getCalibration(), 1)
})

test('压缩切分：保留最近 N 轮，其余归档', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i} 条`,
    at: 1000 + i
  }))
  assert.deepEqual(splitForCompaction(history, 4), { cold: 12, warm: 8 })
  assert.deepEqual(splitForCompaction(history, 1), { cold: 18, warm: 2 })
  // 至少留 2 条：只有 1 条时一条也不压
  assert.deepEqual(splitForCompaction(history.slice(0, 1), 4), { cold: 0, warm: 1 })
  assert.deepEqual(splitForCompaction([], 4), { cold: 0, warm: 0 })
})

test('水位与达标线', () => {
  const budget = 100000
  assert.equal(needsCompaction(budget * WATERMARK - 1, budget), false)
  assert.equal(needsCompaction(budget * WATERMARK, budget), true)
  assert.equal(compactionDone(budget * TARGET, budget), true)
  assert.equal(compactionDone(budget * TARGET + 1, budget), false)
  assert.equal(needsCompaction(999, 0), false)
})
