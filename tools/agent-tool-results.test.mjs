import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === '../services/context' ? specifier + '.ts' : specifier, context)
  }
})
const { serializeToolResult } = await import('../src/main/agent/tool-result.ts')
const { AgentTaskContext } = await import('../src/main/agent/task-context.ts')
const { registerTool, buildWireMap, toOpenAiTools } = await import('../src/main/agent/registry.ts')
const { rememberScreenshot, screenshotPoint } = await import('../src/main/agent/screenshot-coordinates.ts')

test('large escaped tool results remain valid JSON with failure status, metadata and truncation', () => {
  const text = '"\\\n😃'.repeat(10000)
  const raw = serializeToolResult({ ok: false, summary: text, data: { text, exitCode: 42, nested: { field: 2 } } })
  const { ok, data, truncated } = JSON.parse(raw)
  assert.ok(raw.length < 12500)
  assert.equal(ok, false)
  assert.equal(data.exitCode, 42)
  assert.deepEqual(data.nested, { field: 2 })
  assert.ok(data.text.endsWith('…'))
  assert.equal(truncated, true)
})

test('function aliases resolve collisions and length limits consistently for both schema and invocation', () => {
  const ids = ['input.type', 'input_type', 'mcp.server.' + 'long_name'.repeat(20), 'mcp.~abcd.fixture_tool']
  for (const id of ids) registerTool({ id, name: id, description: id, params: {}, risk: 'low', run: () => {} })
  const mapping = buildWireMap(ids)
  assert.equal(mapping.get('input_type'), 'input.type')
  assert.equal(mapping.size, ids.length)
  const schema = toOpenAiTools(ids)
  for (const { function: fn } of schema) {
    assert.match(fn.name, /^[A-Za-z0-9_-]{1,64}$/)
    assert.equal(mapping.get(fn.name), fn.description)
  }
})

test('screenshot clicks use physical pixels on a scaled monitor left of the primary', () => {
  const physicalBounds = { x: -2560, y: -120, width: 2560, height: 1440 }
  rememberScreenshot('left', { displayId: '2', width: 1600, height: 900, physicalBounds })
  const get = (id) => id === '2' ? physicalBounds : undefined
  assert.deepEqual(screenshotPoint('left', 800, 450, get), { x: -1280, y: 600 })
  assert.deepEqual(screenshotPoint('left', 1599, 899, get), { x: -1, y: 1319 })
  assert.throws(() => screenshotPoint('left', 1600, 20, get), /超出截图范围/)
  assert.throws(() => screenshotPoint('left', 0, 0, () => ({ ...physicalBounds, x: 0 })), /布局已变化/)
  assert.throws(() => screenshotPoint('missing', 0, 0, get), /截图已失效/)
})

test('long Agent tasks compact complete batches without losing the user goal, current observation or latest response', () => {
  const state = new AgentTaskContext()
  const goal = { role: 'user', content: 'read until the end and then click' }
  const system = { role: 'system', content: 'system prompt' }
  const messages = [system, { role: 'assistant', content: 'old chat '.repeat(1200) }, goal]
  let screenshot
  for (let i = 0; i < 70; i++) {
    const id = String(i)
    messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id, function: { name: 'file_read', arguments: '{"path":"file.txt"}' } }] },
      {
        role: 'tool', tool_call_id: id, content: serializeToolResult({
          ok: true, summary: 'page read', data: { path: 'file.txt', text: 'abcdef '.repeat(1000), nextOffsetBytes: 7000 * (i + 1) }
        })
      }
    )
    if (i === 0) {
      screenshot = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,WA==' } }] }
      messages.push(screenshot)
    }
    state.fit(messages, goal, screenshot, 5400)
    const calls = messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))
    const results = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    assert.deepEqual(results, calls)
    assert.equal(results.at(-1), id)
    assert.ok(messages.includes(screenshot))
    assert.equal(messages[0], system)
    assert.ok(messages.includes(goal))
    assert.ok(messages.length < 11)
  }
  assert.ok(messages.some((m) => typeof m.content === 'string' && /已收拢.*批调用/.test(m.content) && /续读位置/.test(m.content)))
})
