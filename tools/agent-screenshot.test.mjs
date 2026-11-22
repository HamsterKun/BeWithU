import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'bwu-agent-screenshot-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const bounds = { x: -1920, y: 0, width: 1920, height: 1080 }
const display = { id: 42, bounds, size: bounds, scaleFactor: 1 }
const fixture = globalThis.__bwuScreenshotTest = { tmp, settings: null, call: null, captures: [], clicks: [], display, wgc: null }
const stub = (source) => ({ shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` })

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (specifier === 'electron') return stub(`
      export const app = { getPath: () => globalThis.__bwuScreenshotTest.tmp };
      const fixture = globalThis.__bwuScreenshotTest;
      export const screen = {
        getAllDisplays: () => [fixture.display],
        getCursorScreenPoint: () => ({ x: -1, y: 0 }),
        getDisplayNearestPoint: () => fixture.display,
        dipToScreenRect: (_window, rect) => rect
      };
      export const desktopCapturer = { getSources: async () => fixture.captureSources() }
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
    if (specifier === '../vision-grab') return stub('export const grabViaWgc = async () => globalThis.__bwuScreenshotTest.wgc')
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
const { captureScreen } = await import('../src/main/services/vision.ts')
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
fixture.captureSources = () => {
  const dataUrl = fixture.captures.shift()
  if (!dataUrl) return []
  return [{ display_id: '42', name: 'fixture display', thumbnail: {
    isEmpty: () => false,
    resize: () => ({ getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16, 255) }),
    getSize: () => ({ width: 1600, height: 900 }),
    toJPEG: () => Buffer.from(dataUrl.split(',')[1], 'base64')
  } }]
}
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
    const response = replies.shift()
    return typeof response === 'function' ? response(requests.at(-1)) : response
  })
  return requests
}

const run = async (dataUrl) => {
  const signal = new AbortController().signal
  let image
  if (dataUrl) {
    fixture.captures.unshift(dataUrl)
    const captured = await captureScreen(signal)
    assert.ok(captured.ok)
    image = captured.shot
  }
  return runAgentTask('测试截图', { signal, image, events: { onText: () => {}, onStep: () => {} } })
}

test('the model can click directly from the automatic opening screenshot in its first response', async (t) => {
  const requests = setUp(t, {
    captures: [],
    replies: [
      ({ messages }) => {
        const [note, image] = messages.at(-1).content
        assert.equal(image.image_url.url, opening)
        assert.match(note.text, /自动截取的桌面画面.*1600×900/)
        assert.match(note.text, /像素坐标 x、y 传给 input_click/)
        const captureId = /captureId: ([\da-f-]{36})/.exec(note.text)?.[1]
        assert.ok(captureId)
        return reply(null, tool('first-click', 'input_click', { x: 800, y: 450, captureId }))
      },
      reply('clicked')
    ]
  })
  fixture.settings.agent.shellEnabled = true
  fixture.clicks.length = 0
  // The provider replies without first requesting screen.capture.
  const result = await run(opening)
  assert.equal(result.steps, 1)
  assert.equal(result.text, 'clicked')
  assert.equal(requests.length, 2)
  assert.deepEqual(fixture.clicks.map(({ point }) => ({ x: point.x, y: point.y })), [{ x: -960, y: 540 }])
})

test('a delayed screen capture reaches the model after the tool batch and a fresh image replaces it', async (t) => {
  const requests = setUp(t, {
    captures: [older, newest],
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
    captures: [newest],
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
    enabled: false, captures: [newest],
    replies: [reply(null, tool('capture', 'screen_capture')), reply('已保存截图')]
  })
  assert.equal((await run()).text, '已保存截图')
  assert.deepEqual(requests.map((r) => visibleImages(r.messages)), [[], []])
  assert.match(JSON.parse(requests[1].messages.at(-1).content).result, /开启屏幕理解后/)
})

test('the screen.capture ID can drive input.click on the same scaled monitor', async () => {
  const signal = new AbortController().signal
  fixture.clicks.length = 0
  fixture.captures = [newest]
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

test('Windows Graphics Capture fallback registers its own usable captureId', async () => {
  fixture.captures = []
  fixture.clicks.length = 0
  fixture.wgc = { ok: true, dataUrl: newest, width: 1600, height: 900 }
  try {
    const captured = await captureScreen()
    assert.ok(captured.ok)
    assert.equal(captured.shot.via, 'wgc')
    const clicked = await fixture.call('input.click', {
      x: 800, y: 450, captureId: captured.shot.captureId
    }, { signal: new AbortController().signal })
    assert.equal(clicked.ok, true)
    assert.equal(fixture.clicks[0].point.x, -960)
  } finally {
    fixture.wgc = null
  }
})
