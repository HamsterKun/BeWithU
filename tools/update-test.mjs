/* 自动更新端到端：本地 generic feed，跑通「检查 → 横幅 → 下载 → 立即重启」
 *
 * 不需要真发 release：起一个静态 http 服务当更新源，用 BWU_UPDATE_CONFIG 指过去。
 * 只验证到「下载完成」，不点重启（那会真的结束进程）。
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const currentVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const PORT = Number(process.env.CDP_PORT || 9282)
const FEED_PORT = Number(process.env.FEED_PORT || 18788)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const ok = (k, cond, detail) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✓' : '✗'} ${k}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
}
const jget = async (p) => (await fetch(BASE + p)).json()

class Conn {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      const cb = this.pending.get(m.id)
      if (cb) {
        this.pending.delete(m.id)
        cb(m)
      }
    })
  }
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new Conn(ws)
  }
  call(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error('eval: ' + (ex.exception?.description || ex.text || 'unknown'))
    return r.result?.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const TMP = join(ROOT, '.shots', '.tmp-update')
rmSync(TMP, { recursive: true, force: true })
const feedDir = join(TMP, 'feed')
const ud = join(TMP, 'ud')
mkdirSync(feedDir, { recursive: true })
mkdirSync(ud, { recursive: true })

// 1.2MB 的假安装包：足够看到进度条，又不至于让测试变慢
const assetName = 'BeWithU-9.9.9-x64.exe'
const asset = randomBytes(1200 * 1024)
writeFileSync(join(feedDir, assetName), asset)
const sha512 = createHash('sha512').update(asset).digest('base64')
const size = statSync(join(feedDir, assetName)).size
writeFileSync(
  join(feedDir, 'latest.yml'),
  [
    'version: 9.9.9',
    'files:',
    `  - url: ${assetName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${assetName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-20T00:00:00.000Z'",
    ''
  ].join('\n'),
  'utf8'
)

const hits = []
let hasManifest = false
let latestTag = `v${currentVersion}`
const server = createServer((req, res) => {
  hits.push(req.url)
  // electron-updater 会给清单加 ?noCache=xxx，按路径比较
  const path = String(req.url || '').split('?')[0]
  if (path === '/releases/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tag_name: latestTag }))
    return
  }
  if (path === '/latest.yml' && hasManifest) {
    res.writeHead(200, { 'Content-Type': 'text/yaml' })
    res.end(readFileSync(join(feedDir, 'latest.yml')))
    return
  }
  if (path === `/${assetName}`) {
    // 限速下发，否则本地 1MB 秒传完，看不到下载中的状态
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) })
    const CHUNK = 32 * 1024
    let offset = 0
    const pump = () => {
      if (res.destroyed) return
      if (offset >= size) {
        res.end()
        return
      }
      res.write(asset.subarray(offset, offset + CHUNK))
      offset += CHUNK
      setTimeout(pump, 30)
    }
    pump()
    return
  }
  res.writeHead(404)
  res.end()
})

const configPath = join(TMP, 'dev-app-update.yml')
writeFileSync(
  configPath,
  ['provider: generic', `url: http://127.0.0.1:${FEED_PORT}/`, 'updaterCacheDirName: bewithu-update-test', ''].join('\n'),
  'utf8'
)

let app
let ball
let admin
try {
  await new Promise((r) => server.listen(FEED_PORT, '127.0.0.1', r))

  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BWU_AGENT_TEST: '1',
      BWU_UPDATE_CONFIG: configPath,
      BWU_UPDATE_API: `http://127.0.0.1:${FEED_PORT}/releases/latest`,
      BWU_UPDATE_DELAY: '1200'
    }
  })

  let list = null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = await jget('/json')
    } catch {
      await sleep(400)
    }
  }
  ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(window.bwu && window.bwu.agentTest)')) break
    await sleep(300)
  }

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'about' })
  const ui = admin.conn

  const sameVersion = await ui.eval(`(async () => {
    const kinds = []
    const off = window.bwu.update.onChanged((status) => kinds.push(status.kind))
    const status = await window.bwu.update.check()
    off()
    return { status, kinds }
  })()`)
  ok('missingManifestForCurrentVersionReturnsIdle', sameVersion.status.kind === 'idle' &&
    !sameVersion.kinds.includes('error') && hits.includes('/releases/latest'), sameVersion)

  latestTag = 'v9.9.9'
  const fallback = await ui.eval('window.bwu.update.check()')
  ok('missingManifestForNewVersionOffersManualDownload', fallback.kind === 'available' &&
    fallback.version === '9.9.9' && fallback.manual === true && fallback.portable === false, fallback)
  const fallbackBanner = await ui.eval("document.querySelector('.upd-banner')?.innerText || ''")
  ok('fallbackBannerLinksToRelease', fallbackBanner.includes('前往发布页下载'), fallbackBanner)
  const fallbackDownload = await ui.eval('window.bwu.update.download()')
  ok('fallbackCannotStartAutomaticDownload', fallbackDownload.manual === true &&
    !hits.includes(`/${assetName}`), fallbackDownload)

  // 上传 manifest 后应恢复自动更新，即使之前在同一个版本上走过手动回退。
  hasManifest = true
  const automatic = await ui.eval('window.bwu.update.check()')
  ok('uploadingManifestResumesAutomaticUpdates', automatic.kind === 'available' && !automatic.manual, automatic)

  // 横幅出现（本地 feed 是 9.9.9，比当前版本高）
  let banner = null
  for (let i = 0; i < 40; i++) {
    banner = await ui.eval(
      "(() => { const b = document.querySelector('.upd-banner'); return b ? { text: b.innerText, cls: b.className } : null })()"
    )
    if (banner && banner.text.includes('9.9.9')) break
    await sleep(500)
  }
  ok('bannerShown', Boolean(banner && banner.text.includes('9.9.9')), banner)
  ok('feedFetched', hits.some((u) => String(u).includes('latest.yml')), hits.slice(0, 4))

  // 点一下开始下载
  await ui.eval("document.querySelector('.upd-banner').click()")
  let sawProgress = false
  let ready = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    const s = await ui.eval(`(() => {
      const b = document.querySelector('.upd-banner')
      if (!b) return null
      const bar = b.querySelector('.upd-banner__bar > span')
      return { text: b.innerText, cls: b.className, width: bar ? bar.style.width : '' }
    })()`)
    if (s?.cls.includes('is-downloading')) sawProgress = true
    if (s?.cls.includes('is-ready')) {
      ready = s
      break
    }
  }
  ok('downloadProgressSeen', sawProgress, sawProgress)
  ok('readyToRestart', Boolean(ready && ready.text.includes('立即重启')), ready)
  ok('installerDownloaded', hits.some((u) => String(u).includes(assetName)), hits.slice(-3))

  const status = await ui.eval('window.bwu.update.get()')
  ok('statusReady', status?.kind === 'ready' && status?.version === '9.9.9', status)
  const hitCount = hits.length
  const checkedAgain = await ui.eval('window.bwu.update.check()')
  const restartButton = await ui.eval("document.querySelector('.upd-banner.is-ready')?.innerText || ''")
  ok('checkingAgainKeepsInstallerReady', checkedAgain?.kind === 'ready' && checkedAgain.version === status.version &&
    restartButton.includes('立即重启') && hits.length === hitCount, { checkedAgain, restartButton })

  admin.close()
  ball.close()
  app.kill()
  await sleep(600)
  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
} catch (e) {
  console.error('✗ fatal', e instanceof Error ? e.message : e)
  try {
    admin?.close()
    ball?.close()
    app?.kill()
  } catch {}
  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(1)
} finally {
  server.close()
  rmSync(TMP, { recursive: true, force: true })
}
