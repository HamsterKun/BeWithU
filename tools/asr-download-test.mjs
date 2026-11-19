/* ASR 模型下载全流程：下载 → 大小/SHA-256 校验 → 解包 → 文件校验 → 发布。
 *
 * 用本机已下载并校验过的官方归档（D:\coding\bwu-asr-dl\archive.tar.bz2）起一个本地 HTTP 服务，
 * 把 asr-model-manifest 的 URL 换成 127.0.0.1（size/sha256/root 保持官方值），
 * 这样不用重新走 163MB 的外网下载，也能验证真实代码路径：
 *   - 归档大小或 SHA-256 不对 → 报错，不发布（坏归档不进 models 目录）
 *   - 归档正确 → 解包、逐文件 hash/size 校验、原子 rename 发布，modelReady() 变 true
 *
 * 归档不在本机时打印 SKIP 并退出 0（不要让没下过模型的机器误红）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const ARCHIVE = process.env.BWU_ASR_ARCHIVE || 'D:\\coding\\bwu-asr-dl\\archive.tar.bz2'
const ARCHIVE_SIZE = 163002883
const ARCHIVE_SHA = '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'
const ROOT = 'D:\\coding\\BeWithU'

if (!existsSync(ARCHIVE)) {
  console.log(`SKIP: 找不到已校验的官方归档 ${ARCHIVE}（先跑 D:\\coding\\bwu-asr-dl\\fetch-asr.ps1）`)
  process.exit(0)
}

const actualSize = statSync(ARCHIVE).size
assert.equal(actualSize, ARCHIVE_SIZE, '归档大小与 manifest 不一致，先确认下载完整')
const hash = createHash('sha256')
for await (const chunk of createReadStream(ARCHIVE)) hash.update(chunk)
assert.equal(hash.digest('hex'), ARCHIVE_SHA, '归档 SHA-256 与 manifest 不一致')

/** 本地服务：/good 给真归档，/short 只给 1MB（用来验坏归档被拒） */
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': req.url === '/short' ? 1048576 : ARCHIVE_SIZE })
  if (req.url === '/short') {
    res.end(Buffer.alloc(1048576, 7))
    return
  }
  createReadStream(ARCHIVE).pipe(res)
})

let port = 0
await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port
// 本地服务不能拖着进程：unref 让事件循环不被监听句柄占住
server.unref()

const userData = mkdtempSync(join(tmpdir(), 'bwu-flow-'))
globalThis.__bwuFixture = { userData }

const electronMock = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: () => globalThis.__bwuFixture.userData }
  export const utilityProcess = { fork() { throw new Error('utilityProcess 不该在这条测试里被用到') } }
`)}`

const manifestMock = (base) =>
  `data:text/javascript,${encodeURIComponent(`
    export const ASR_MODEL_ARCHIVE = {
      name: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
      url: 'http://127.0.0.1:${port}${base}',
      size: ${ARCHIVE_SIZE},
      sha256: '${ARCHIVE_SHA}',
      root: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
    }
    export const ASR_MODEL_FILES = [
      { name: 'model.int8.onnx', size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
      { name: 'tokens.txt', size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' }
    ]
  `)}`

let goodUrl = manifestMock('/good')
let shortUrl = manifestMock('/short')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { shortCircuit: true, url: electronMock }
    if (specifier.endsWith('asr-model-manifest') && context.parentURL?.includes('/services/asr-model.ts')) {
      return { shortCircuit: true, url: goodUrl }
    }
    // 源码里的相对导入不写扩展名（Vite 负责），用 Node 直接跑时要补 .ts
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const suffix of ['.ts', '.js', '/index.ts']) {
        try {
          return next(specifier + suffix, context)
        } catch {
          /* 换下一个后缀 */
        }
      }
    }
    return next(specifier, context)
  }
})

const asrModel = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/main/services/asr-model.ts`)
const localAsr = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/main/services/local-asr.ts`)

const listModelDir = () => {
  const dir = localAsr.modelDir()
  return existsSync(dir) ? readdirSync(dir).sort() : []
}
const stagingLeftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('bwu-asr-'))

test('坏归档（大小不对）被拒绝，且不发布任何模型文件', async () => {
  // 换成本地 /short 的 URL，重新加载一份 asr-model 模块
  goodUrl = shortUrl
  const url = `file:///${ROOT.replace(/\\/g, '/')}/src/main/services/asr-model.ts?v=short`
  const shortModel = await import(url)
  const before = stagingLeftovers().length
  await assert.rejects(shortModel.downloadModel(() => {}), /大小|SHA-256/)
  assert.deepEqual(listModelDir(), [], '坏归档不该在 models 目录留下文件')
  assert.equal(stagingLeftovers().length, before, '临时目录应清理干净')
})

test('官方归档下载 → 校验 → 解包 → 发布，modelReady() 成立', async () => {
  const states = []
  await asrModel.downloadModel((p) => states.push(p.state))
  assert.ok(states.includes('downloading'), states.join(','))
  assert.equal(asrModel.modelStatus().state, 'ready')
  assert.equal(localAsr.modelReady(), true)
  assert.deepEqual(listModelDir(), ['model.int8.onnx', 'tokens.txt'])
  const model = statSync(join(localAsr.modelDir(), 'model.int8.onnx'))
  const tokens = statSync(join(localAsr.modelDir(), 'tokens.txt'))
  assert.equal(model.size, 239233841)
  assert.equal(tokens.size, 315894)
  assert.equal(stagingLeftovers().length, 0, '下载用的临时目录应清理干净')
})

test('删除模型后 modelReady() 立刻变 false', () => {
  asrModel.deleteModel()
  assert.equal(localAsr.modelReady(), false)
  assert.deepEqual(listModelDir(), [])
})

after(() => {
  try {
    server.closeAllConnections()
  } catch {
    /* 老 Node 没有这个方法 */
  }
  server.close()
  rmSync(userData, { recursive: true, force: true })
})
