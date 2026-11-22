import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'bwu-agent-screenshot-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const fixture = globalThis.__bwuScreenshotTest = { tmp, settings: null, call: null, captures: [], displays: [], clicks: [] }
const stub = (source) => ({ shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` })

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (specifier === 'electron') return stub(`
      export const app = { getPath: () => globalThis.__bwuScreenshotTest.tmp };
      export const screen = { getAllDisplays: () => globalThis.__bwuScreenshotTest.displays }
    `)
    if (specifier === '../store/settings') return stub('export const settingsStore = { get: () => globalThis.__bwuScreenshotTest.settings }')
    if (specifier === '../store/history') return stub('export const historyStore = { since: () => [] }')
    if (specifier === '../store/context') return stub('export const contextStore = { getSummary: () => "", archivedUpTo: () => 0 }')
    if (specifier === '../store/usage') return stub('export const recordTokens = () => {}')
    if (specifier === '../logger') return stub('export const log = () => {}')
    if (specifier === '../windows') return stub('export const sendBubble = () => {}')
    if (parent.endsWith('/runner.ts') && specifier === './index') {
      return stub(`export const ensureMcpTools = async () => {};
        export const callTool = (...args) => globalThis.__bwuScreenshotTest.call(...args)`)
    }
    if (parent.endsWith('/runner.ts') && specifier === './skills') return stub('export const skillsPromptSection = () => ""')
    if (specifier === '../../services/vision') {
      return stub(`
        export const captureScreen = async () => globalThis.__bwuScreenshotTest.captures.shift();
        export const displayPhysicalBounds = (display) => display.bounds
      `)
    }
    if (specifier === '../../services/input-inject') {
      return stub(`
        export const isInputAvailable = () => true;
        export const clickMouse = async (point, signal) => globalThis.__bwuScreenshotTest.clicks.push({ point, signal });
        export const cursorPos = null, dragMouse = null, findWindowByTitle = null, focusWindowByTitle = null,
          foregroundWindowTitle = null, inputUnavailableReason = null, moveMouse = null, screenMetrics = null,
          scrollMouse = null, sendKeys = null, typeText = null;
      `)
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  }
})

const { registerScreenTools } = await import('../src/main/agent/tools/screen.ts')
const { registerInputTools } = await import('../src/main/agent/tools/input.ts')
const { getTool, registerTool } = await import('../src/main/agent/registry.ts')
const { registerDelayTool } = await import('../src/main/agent/tools/delay.ts')
const { runAgentTask } = await import('../src/main/agent/runner.ts')
const { DEFAULT_SETTINGS } = await import('../src/shared/defaults.ts')

registerScreenTools()
registerInputTools()
registerDelayTool()
registerTool({
  id: 'fixture.status', name: '状态', description: '测试专用', risk: 'low',
  params: { type: 'object' }, run: async () => ({ ok: true, summary: '已读取状态' })
})
fixture.call = (id, args, { signal }) => getTool(id).run(args, { callId: id, signal, log: () => {} })

const makeImage = (label) => `data:image/jpeg;base64,${Buffer.from(label).toString('base64')}`
const opening = makeImage('opening')
const older = makeImage('after-wait')
const newest = makeImage('latest')
const capture = (dataUrl) => ({
  ok: true,
  shot: { dataUrl, width: 1600, height: 900, bytes: 32, displayId: '42', physicalBounds: { x: -1920, y: 0, width: 1920, height: 1080 } }
})
const tool = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (content, ...tool_calls) => Response.json({ choices: [{ message: { content, tool_calls } }] })
const visibleImages = (messages) => messages.flatMap((m) => Array.isArray(m.content)
  ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url)
  : [])

function setUp(t, { enabled = true, replies, captures }) {
  fixture.settings = structuredClone(DEFAULT_SETTINGS)
  fixture.settings.llm.baseUrl = 'http://localhost'
  fixture.settings.llm.apiKey = 'fixture'
  fixture.settings.llm.model = 'fixture'
  fixture.settings.llm.vision.enabled = enabled
  fixture.settings.llm.thinking.enabled = false
  fixture.settings.agent.enabled = true
  fixture.captures = captures
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body))
    assert.ok(replies.length, 'unexpected extra model request')
    return replies.shift()
  })
  return requests
}

const run = (dataUrl) => runAgentTask('测试截图', {
  signal: new AbortController().signal, image: dataUrl ? { dataUrl } : undefined,
  events: { onText: () => {}, onStep: () => {} }
})

test('a delayed screen capture reaches the model after the tool batch and a fresh image replaces it', async (t) => {
  const requests = setUp(t, {
    captures: [capture(older), capture(newest)],
    replies: [
      reply(null, tool('wait', 'delay', { seconds: 0.001, then: { name: 'screen_capture', arguments: {} } }),
        tool('status', 'fixture_status')),
      reply(null, tool('refresh', 'screen_capture')),
      reply('已看到新画面')
    ]
  })
  const result = await run(opening)
  assert.equal(result.text, '已看到新画面')
  assert.equal(result.steps, 4)
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map((r) => visibleImages(r.messages)), [[opening], [older], [newest]])

  const afterWait = requests[1].messages.slice(-4)
  assert.deepEqual(afterWait.map((m) => m.role), ['assistant', 'tool', 'tool', 'user'])
  assert.deepEqual(afterWait.slice(1, 3).map((m) => m.tool_call_id), ['wait', 'status'])
  assert.match(JSON.parse(afterWait[1].content).result, /已截屏/)
  const shot = JSON.parse(afterWait[1].content).data.result
  assert.equal(shot.displayId, '42')
  assert.equal(shot.physicalBounds.x, -1920)
  assert.ok(shot.captureId)
  assert.match(shot.path, /\.jpg$/)
  assert.ok(afterWait[3].content[0].text.includes(shot.captureId))
  assert.match(afterWait[3].content[0].text, /wait/)
})

test('an interface that rejects tool screenshot images is retried with a text explanation', async (t) => {
  const requests = setUp(t, {
    captures: [capture(newest)],
    replies: [
      reply(null, tool('capture', 'screen_capture')),
      Response.json({ error: { message: 'model does not support image_url' } }, { status: 400 }),
      reply('无法查看画面')
    ]
  })
  assert.equal((await run()).text, '无法查看画面')
  assert.deepEqual(requests.map((r) => visibleImages(r.messages)), [[], [newest], []])
  assert.match(requests[2].messages.at(-1).content, /拒绝接收图片/)
})

test('turning screen understanding off keeps tool screenshots local', async (t) => {
  const requests = setUp(t, {
    enabled: false, captures: [capture(newest)],
    replies: [reply(null, tool('capture', 'screen_capture')), reply('已保存截图')]
  })
  assert.equal((await run()).text, '已保存截图')
  assert.deepEqual(requests.map((r) => visibleImages(r.messages)), [[], []])
  assert.match(JSON.parse(requests[1].messages.at(-1).content).result, /开启屏幕理解后/)
})

test('the screen.capture ID can drive input.click on the same scaled monitor', async () => {
  const signal = new AbortController().signal
  const shot = capture(newest)
  fixture.captures = [shot]
  fixture.displays = [{ id: 42, bounds: shot.shot.physicalBounds }]
  const result = await fixture.call('screen.capture', {}, { signal })
  const captureId = result.data.captureId
  const incomplete = await fixture.call('input.click', { x: 800, captureId }, { signal })
  assert.equal(incomplete.ok, false)
  assert.equal(fixture.clicks.length, 0)
  const clicked = await fixture.call('input.click', { x: 800, y: 450, captureId, expectTitle: 'Fixture' }, { signal })
  assert.equal(clicked.ok, true)
  assert.deepEqual(fixture.clicks, [{
    point: { x: -960, y: 540, button: 'left', count: 1, expectTitle: 'Fixture' }, signal
  }])
})
