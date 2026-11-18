// 开发辅助：通过 CDP 操作正在运行的窗口（只在 dev 调试时使用）
// 用法：
//   node tools/cdp.mjs list
//   node tools/cdp.mjs eval <url包含> "<js表达式>"
//   node tools/cdp.mjs shot <url包含> <输出png路径>
const port = process.env.CDP_PORT || '9222'
const [, , cmd, filter = '', arg = ''] = process.argv

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()

if (cmd === 'list') {
  for (const t of targets) console.log(t.type, '|', t.title, '|', t.url)
  process.exit(0)
}

const target = targets.find((t) => t.type === 'page' && t.url.includes(filter))
if (!target) {
  console.error('没有找到目标窗口：', filter)
  for (const t of targets) console.error(' -', t.url)
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  const cb = pending.get(msg.id)
  if (cb) {
    pending.delete(msg.id)
    cb(msg)
  }
})

function call(method, params = {}) {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

if (cmd === 'eval') {
  const res = await call('Runtime.evaluate', {
    expression: arg,
    awaitPromise: true,
    returnByValue: true,
    userGesture: process.env.USER_GESTURE !== '0'
  })
  console.log(JSON.stringify(res.result, null, 2))
} else if (cmd === 'click') {
  // 用法：click <url包含> <x> <y>（视口坐标）
  const [x, y] = arg.split(',').map(Number)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 60))
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  console.log('clicked', x, y)
} else if (cmd === 'shot') {
  const res = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg, Buffer.from(res.result.data, 'base64'))
  console.log('saved', arg)
}
ws.close()
