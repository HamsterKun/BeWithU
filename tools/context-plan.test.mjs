/* 上下文组装：顺序、前缀稳定、时间戳（不需要 Electron） */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { assembleMessages, formatStamp, formatNow, SUMMARY_HEADER, TIME_NOTE } = await import(
  '../src/main/services/context.ts'
)

const base = {
  systemPrompt: '你是小伴。',
  summary: '',
  history: [],
  userText: '在吗',
  now: new Date(2026, 10, 20, 12, 32, 0).getTime(),
  timeAwareness: 'current'
}

test('消息顺序固定：system → 历史 → 本轮', () => {
  const messages = assembleMessages({
    ...base,
    history: [
      { role: 'user', content: '第一句', at: base.now - 60000 },
      { role: 'assistant', content: '第一答', at: base.now - 59000 }
    ]
  })
  assert.equal(messages.length, 4)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[2].role, 'assistant')
  assert.equal(messages[3].role, 'user')
  assert.equal(String(messages[3].content).startsWith('在吗'), true)
})

test('摘要拼在 system 尾部；为空时不留空标题', () => {
  const withSummary = assembleMessages({ ...base, summary: '他在打黑神话。' })
  assert.ok(String(withSummary[0].content).includes(SUMMARY_HEADER))
  assert.ok(String(withSummary[0].content).includes('他在打黑神话。'))
  const without = assembleMessages(base)
  assert.equal(String(without[0].content).includes(SUMMARY_HEADER), false)
})

test('时间说明只在开启时间感知时出现，且文案固定', () => {
  assert.ok(String(assembleMessages(base)[0].content).includes(TIME_NOTE))
  const off = assembleMessages({ ...base, timeAwareness: 'off' })
  assert.equal(String(off[0].content).includes(TIME_NOTE), false)
  assert.equal(String(off[off.length - 1].content), '在吗')
})

test('时间戳格式不依赖 locale，且跨年补年份', () => {
  const now = new Date(2026, 10, 20, 12, 32, 0).getTime()
  assert.equal(formatStamp(new Date(2026, 10, 20, 14, 5, 0).getTime(), now), '11-20 14:05')
  assert.equal(formatStamp(new Date(2025, 0, 3, 9, 7, 0).getTime(), now), '2025-01-03 09:07')
  // 不能出现 toLocaleString 那种 `2026/11/20 14:05:00`
  assert.equal(formatStamp(now, now).includes('/'), false)
})

test('当前时间只加在最后一条，间隔够久才带相对时间', () => {
  const history = [
    { role: 'user', content: '早', at: base.now - 3 * 3600 * 1000 },
    { role: 'assistant', content: '早啊', at: base.now - 3 * 3600 * 1000 + 1000 }
  ]
  const messages = assembleMessages({ ...base, history })
  // 历史消息本身不带戳（current 模式）
  assert.equal(String(messages[1].content), '早')
  const tail = String(messages[3].content)
  assert.ok(tail.includes('[现在 11-20 12:32 周五'), tail)
  assert.ok(tail.includes('距上一条 3 小时'), tail)
})

test('full 模式给每条历史加冻结时间戳', () => {
  const history = [
    { role: 'user', content: '早', at: new Date(2026, 10, 20, 9, 0, 0).getTime() },
    { role: 'assistant', content: '早啊', at: new Date(2026, 10, 20, 9, 1, 0).getTime() }
  ]
  const messages = assembleMessages({ ...base, history, timeAwareness: 'full' })
  assert.equal(String(messages[1].content), '[11-20 09:00] 早')
  assert.equal(String(messages[2].content), '[11-20 09:01] 早啊')
})

test('间隔太短不写"距上一条"，避免噪音', () => {
  const text = formatNow(base.now, base.now - 30 * 1000)
  assert.equal(text.includes('距上一条'), false)
})

test('前缀稳定性：连续追加 20 轮，前面已发出的内容一字不变', () => {
  // 模拟真实对话：每轮追加 user + assistant，摘要不变
  const history = []
  let previous = null
  for (let turn = 0; turn < 20; turn++) {
    const now = base.now + turn * 60000
    const messages = assembleMessages({
      ...base,
      history: history.slice(),
      userText: `第 ${turn} 问`,
      now
    })
    if (previous) {
      // 上一轮发的每条消息（除了它自己的最后一条 user）必须原样出现在这一轮的前缀里
      const prefix = messages.slice(0, previous.length - 1)
      for (let i = 0; i < prefix.length; i++) {
        assert.equal(
          JSON.stringify(prefix[i]),
          JSON.stringify(previous[i]),
          `第 ${turn} 轮第 ${i} 条被改写了（前缀缓存会失效）`
        )
      }
    }
    previous = messages
    // 这一轮结束，两条都进历史
    history.push({ role: 'user', content: `第 ${turn} 问`, at: now })
    history.push({ role: 'assistant', content: `第 ${turn} 答`, at: now + 1000 })
  }
})

test('图片只出现在最后一条，不影响前缀', () => {
  const history = [{ role: 'user', content: '上一句', at: base.now - 1000 }]
  const plain = assembleMessages({ ...base, history })
  const withImage = assembleMessages({
    ...base,
    history,
    image: { dataUrl: 'data:image/png;base64,AAA', note: '（附上我此刻的屏幕截图）' }
  })
  assert.equal(JSON.stringify(plain[0]), JSON.stringify(withImage[0]))
  assert.equal(JSON.stringify(plain[1]), JSON.stringify(withImage[1]))
  assert.equal(Array.isArray(withImage[2].content), true)
  assert.ok(String(withImage[2].content[0].text).includes('（附上我此刻的屏幕截图）'))
})
