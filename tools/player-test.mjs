/* 播放器收尾逻辑的单元测试（不需要 Electron / 不需要音频设备）。
 *
 * 用法：
 *   node tools/player-test.mjs
 *   # 本机没有系统 Node 时：
 *   "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\player-test.mjs
 *
 * 覆盖：正常播放后收尾、缺包时守护兜底、长音频不误触发、无音频立即收尾、stop 后不再回调。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 编译 player.ts ---------------- */
// 放在 .shots/ 下（已 gitignore），避免系统临时目录的权限限制
const outDir = join(ROOT, '.shots', '.tmp-player-test')
mkdirSync(outDir, { recursive: true })
try {
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/typescript/lib/tsc.js'),
      '--ignoreConfig',
      join(ROOT, 'src/renderer/ball/player.ts'),
      '--outDir',
      outDir,
      '--target',
      'es2022',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--lib',
      'es2022,dom',
      '--skipLibCheck'
    ],
    { stdio: 'inherit' }
  )

  /* ---------------- 浏览器环境替身 ---------------- */
  class FakeBuffer {
    constructor(len, rate) {
      this.length = len
      this.duration = len / rate
      this.ch = new Float32Array(len)
    }
    getChannelData() {
      return this.ch
    }
  }

  class FakeSource {
    constructor() {
      this.onended = null
      this.buffer = null
      this._dur = 0
    }
    connect() {}
    start() {
      setTimeout(() => {
        if (typeof this.onended === 'function') this.onended()
      }, this._dur * 1000)
    }
    stop() {}
  }

  class FakeCtx {
    constructor() {
      this.currentTime = 0
      this.state = 'running'
      this.destination = {}
      this.onstatechange = null
    }
    createGain() {
      return { gain: { value: 0 }, connect() {} }
    }
    createAnalyser() {
      return { fftSize: 256, connect() {}, getByteTimeDomainData() {} }
    }
    createBuffer(_c, len, rate) {
      return new FakeBuffer(len, rate)
    }
    createBufferSource() {
      const src = new FakeSource()
      return new Proxy(src, {
        set(target, prop, value) {
          if (prop === 'buffer') {
            target.buffer = value
            target._dur = value ? value.duration : 0
            return true
          }
          target[prop] = value
          return true
        }
      })
    }
    resume() {
      return Promise.resolve()
    }
  }

  globalThis.window = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id)
  }
  globalThis.AudioContext = FakeCtx

  const { Player } = await import(pathToFileURL(join(outDir, 'player.js')).href)

  const pcm = (n) => new Int16Array(n)
  const results = []
  const test = async (name, fn) => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log('✓', name)
    } catch (e) {
      results.push({ name, ok: false, error: e.message })
      console.log('✗', name, '-', e.message)
    }
  }

  // 1. 正常两句话：按时收尾，且只收尾一次
  await test('正常播放后收尾且只触发一次', async () => {
    const p = new Player()
    let n = 0
    p.onDrained = () => n++
    p.push(0, pcm(2400), 24000, false)
    p.push(0, pcm(0), 24000, true)
    p.push(1, pcm(2400), 24000, false)
    p.push(1, pcm(0), 24000, true)
    p.endStream()
    await sleep(700)
    assert.equal(n, 1)
    await sleep(500)
    assert.equal(n, 1)
  })

  // 2. 丢包（缺 seq1，seq2 永远等不到）：不应卡死，守护触发收尾
  await test('缺一个 seq 时由守护兜底收尾', async () => {
    const p = new Player()
    let n = 0
    p.onDrained = () => n++
    p.push(0, pcm(2400), 24000, false)
    p.push(0, pcm(0), 24000, true)
    p.push(2, pcm(2400), 24000, false)
    p.push(2, pcm(0), 24000, true)
    p.endStream()
    await sleep(800)
    assert.equal(n, 0, '刚开始不该收尾')
    await sleep(3000)
    assert.equal(n, 1, '守护应在约 2.5s 后收尾')
  })

  // 手动推进两个时钟，覆盖一分钟以上的播报和设备停滞，无需等待真实音频。
  const withPlaybackClock = async (run) => {
    const savedWindow = globalThis.window
    const realNow = Date.now
    let now = 1000
    let tick
    let ctx
    let src
    globalThis.window = { setInterval: (callback) => { tick = callback; return 1 }, clearInterval: () => {} }
    globalThis.AudioContext = class extends FakeCtx {
      constructor() { super(); ctx = this }
      createBufferSource() { src = new FakeSource(); src.start = () => {}; return src }
    }
    Date.now = () => now
    const p = new Player()
    let drained = 0
    p.onDrained = () => drained++
    try {
      p.push(0, pcm(24000 * 75), 24000, true)
      p.endStream()
      await run({
        player: p,
        source: src,
        count: () => drained,
        step: (wallMs, audioSeconds) => { now += wallMs; ctx.currentTime = audioSeconds; tick() }
      })
    } finally {
      p.stop()
      Date.now = realNow
      globalThis.window = savedWindow
      globalThis.AudioContext = FakeCtx
    }
  }

  await test('75 秒播报超过原兜底时限仍播放到末尾', () => withPlaybackClock(({ player, source, step, count }) => {
    step(61000, 61)
    assert.equal(count(), 0)
    assert.equal(player.playing, true)
    step(13000, 74)
    source.onended()
    assert.equal(count(), 1)
    assert.equal(player.playing, false)
  }))

  await test('音频设备的时钟持续停滞时仍能释放播放状态', () => withPlaybackClock(({ player, step, count }) => {
    step(61000, 0)
    assert.equal(count(), 1)
    assert.equal(player.playing, false)
  }))

  // 4. 完全没音频（TTS 全失败）：立即收尾
  await test('无音频时立即收尾', async () => {
    const p = new Player()
    let n = 0
    p.onDrained = () => n++
    p.endStream()
    await sleep(100)
    assert.equal(n, 1)
  })

  // 5. stop() 后守护失效，不再回调
  await test('stop() 后不再回调', async () => {
    const p = new Player()
    let n = 0
    p.onDrained = () => n++
    p.push(2, pcm(2400), 24000, true) // 制造缺包
    p.endStream()
    p.stop()
    await sleep(3500)
    assert.equal(n, 0)
  })

  // 6. 试听被打断后，新的一段音频必须立刻能播（不能排队等旧的放完）
  await test('打断后新音频流立即生效', async () => {
    const p = new Player()
    let n = 0
    p.onDrained = () => n++
    p.push(0, pcm(24000 * 3), 24000, false) // 旧的一段 3 秒，正在播
    p.stop() // 模拟点击下一次试听时的 audioStop
    await sleep(80)
    const t0 = Date.now()
    p.push(900000, pcm(2400), 24000, false) // 新试听：seq 与旧的完全不连续
    p.push(900000, pcm(0), 24000, true)
    p.endStream()
    await sleep(600)
    assert.equal(n, 1, '新流应收尾')
    assert.ok(Date.now() - t0 < 2000, '新流不应等待旧音频播放完')
  })

  const failed = results.filter((r) => !r.ok)
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length, failedTests: failed }, null, 2))
  process.exitCode = failed.length ? 1 : 0
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
