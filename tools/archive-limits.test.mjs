/* 归档导入的限制与清理（REVIEW A6）：不需要 Electron 运行时 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const mock = `data:text/javascript,${encodeURIComponent(
  'export const app = { getPath: () => globalThis.__bwuTemp };'
)}`
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/agent/import-archive.ts') && specifier === 'electron') {
      return { shortCircuit: true, url: mock }
    }
    return next(specifier, context)
  }
})
const { extractZip, DEFAULT_LIMITS } = await import('../src/main/agent/import-archive.ts')

/** 和应用里一致：优先用系统自带 tar，避免 PATH 上的 GNU tar 把 C:\ 当成远程主机 */
const TAR = (() => {
  const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(systemTar) ? systemTar : 'tar'
})()

/** 每个用例独立一个「系统临时目录」，便于断言没有残留 */
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bwu-archive-'))
  const temp = join(root, 'temp')
  mkdirSync(temp)
  globalThis.__bwuTemp = temp
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, temp }
}

function makeZip(root, files) {
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(src, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const zip = join(root, 'pkg.zip')
  execFileSync(TAR, ['-a', '-cf', zip, '-C', src, '.'], { stdio: 'ignore' })
  return zip
}

/** 手写 ustar 头，用来构造带符号链接/越级路径的归档（不依赖 python） */
function tarHeader({ name, size = 0, type = '0', linkname = '' }) {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100)
  buf.write('0000000\0', 108)
  buf.write('0000000\0', 116)
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  buf.write('00000000000\0', 136)
  buf.write('        ', 148)
  buf.write(type, 156)
  buf.write(linkname, 157, 100, 'utf8')
  buf.write('ustar\0', 257)
  buf.write('00', 263)
  let sum = 0
  for (const b of buf) sum += b
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return buf
}

function makeTar(root, entries) {
  const chunks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '')
    chunks.push(tarHeader({ ...entry, size: data.length }))
    if (data.length) {
      chunks.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad) chunks.push(Buffer.alloc(pad))
    }
  }
  chunks.push(Buffer.alloc(1024))
  const file = join(root, 'custom.tar')
  writeFileSync(file, Buffer.concat(chunks))
  return file
}

test('正常压缩包解包并下钻到唯一顶层目录，cleanup 后彻底删除', async (t) => {
  const { root, temp } = fixture(t)
  const zip = makeZip(root, { 'pkg/manifest.json': '{}', 'pkg/sub/a.txt': 'hello' })
  const { dir, cleanup } = await extractZip(zip)
  assert.equal(dir, join(temp, readdirSync(temp)[0], 'pkg'))
  assert.ok(existsSync(join(dir, 'manifest.json')))
  assert.ok(existsSync(join(dir, 'sub', 'a.txt')))
  cleanup()
  assert.deepEqual(readdirSync(temp), [])
})

test('条目数超过上限时拒绝，且不残留临时目录', async (t) => {
  const { root, temp } = fixture(t)
  const zip = makeZip(root, { 'pkg/a.txt': 'a', 'pkg/b.txt': 'b', 'pkg/c.txt': 'c' })
  await assert.rejects(extractZip(zip, { maxEntries: 2 }), /条目太多/)
  assert.deepEqual(readdirSync(temp), [])
})

test('解压后总体积超过上限时拒绝（流式计量，不落盘）', async (t) => {
  const { root, temp } = fixture(t)
  const zip = makeZip(root, { 'pkg/big.txt': 'x'.repeat(4000) })
  await assert.rejects(extractZip(zip, { maxTotalBytes: 1000 }), /体积过大/)
  assert.deepEqual(readdirSync(temp), [])
})

test('单个文件超过上限时拒绝', async (t) => {
  const { root, temp } = fixture(t)
  const zip = makeZip(root, { 'pkg/big.txt': 'x'.repeat(4000) })
  await assert.rejects(extractZip(zip, { maxFileBytes: 1000 }), /单个文件过大/)
  assert.deepEqual(readdirSync(temp), [])
})

test('目录层级超过上限时拒绝', async (t) => {
  const { root, temp } = fixture(t)
  const zip = makeZip(root, { 'pkg/a/b/c/d/e.txt': 'deep' })
  await assert.rejects(extractZip(zip, { maxDepth: 3 }), /层级过深/)
  assert.deepEqual(readdirSync(temp), [])
})

test('含符号链接的归档被拒绝', async (t) => {
  const { root, temp } = fixture(t)
  const tar = makeTar(root, [
    { name: 'pkg', type: '5' },
    { name: 'pkg/link', type: '2', linkname: '/etc/passwd' }
  ])
  await assert.rejects(extractZip(tar), /链接或特殊文件/)
  assert.deepEqual(readdirSync(temp), [])
})

test('含向上越级路径的归档被拒绝', async (t) => {
  const { root, temp } = fixture(t)
  const tar = makeTar(root, [{ name: '../escape.txt', content: 'evil' }])
  await assert.rejects(extractZip(tar), /越级/)
  assert.deepEqual(readdirSync(temp), [])
})

test('默认上限足够放下正常扩展包', () => {
  assert.ok(DEFAULT_LIMITS.maxEntries >= 100)
  assert.ok(DEFAULT_LIMITS.maxTotalBytes >= 8 * 1024 * 1024)
  assert.ok(DEFAULT_LIMITS.maxFileBytes <= DEFAULT_LIMITS.maxTotalBytes)
})
