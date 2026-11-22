import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const mock = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: () => globalThis.__bwuFixture?.home ?? 'C:/tmp' }
  export const settingsStore = { get: () => ({ agent: { files: { fullAccess: true, dirs: [] } } }) }
  export const registerTool = (t) => { (globalThis.__bwuTools ||= {})[t.id] = t }
`)}`
registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.endsWith('/agent/tools/files.ts') &&
      ['electron', '../../store/settings', '../registry'].includes(specifier)
    ) {
      return { shortCircuit: true, url: mock }
    }
    return next(specifier, context)
  }
})
const { registerFileTools, readTextPrefix, listDirPage } = await import('../src/main/agent/tools/files.ts')
const { serializeToolResult } = await import('../src/main/agent/tool-result.ts')
registerFileTools()
const tools = globalThis.__bwuTools

const fixture = (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bwu-file-io-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  globalThis.__bwuFixture = { home: root }
  return root
}

test('readTextPrefix 只读开头：大文件不整读、带截断标记', async (t) => {
  const root = fixture(t)
  const big = join(root, 'big.txt')
  writeFileSync(big, 'a'.repeat(4 * 1024 * 1024))
  const started = Date.now()
  const got = await readTextPrefix(big, 1000)
  assert.equal(got.text.length, 1000)
  assert.equal(got.truncated, true)
  assert.equal(got.size, 4 * 1024 * 1024)
  assert.ok(Date.now() - started < 2000, '读 4MB 文件的开头应远快于整读')
})

test('readTextPrefix 不把多字节字符切一半', async (t) => {
  const root = fixture(t)
  const file = join(root, 'cn.txt')
  writeFileSync(file, '啊'.repeat(100), 'utf8')
  // 15 个字符约 45 字节，按字节截断会落在第 16 个字符中间
  const got = await readTextPrefix(file, 15)
  assert.equal(got.text.includes('\uFFFD'), false, got.text)
  assert.ok(got.text.length <= 15)
  assert.ok(got.text.startsWith('啊啊啊'))
})

test('readTextPrefix 拒绝非普通文件', async (t) => {
  const root = fixture(t)
  await assert.rejects(readTextPrefix(root, 100), /不是普通文件/)
})

test('listDirPage 支持 offset/limit 并报告是否还有更多', async (t) => {
  const root = fixture(t)
  for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${String(i).padStart(2, '0')}.txt`), 'x')
  mkdirSync(join(root, 'sub'))
  const first = await listDirPage(root, 0, 10)
  assert.equal(first.entries.length, 10)
  assert.equal(first.more, true)
  const last = await listDirPage(root, 25, 10)
  assert.equal(last.entries.length, 6)
  assert.equal(last.more, false)
  assert.ok(last.entries.some((e) => e.dir))
})

test('listDirPage 有时间预算，超时立即报错', async (t) => {
  const root = fixture(t)
  for (let i = 0; i < 50; i++) writeFileSync(join(root, `g${i}.txt`), 'x')
  // 预算给负数，保证 deadline 一定在过去（0 在同一毫秒内可能还没超时）
  await assert.rejects(listDirPage(root, 0, 10, -1), /超时/)
})

test('file.read/file.list 工具走分页与截断，不阻塞主进程', async (t) => {
  const root = fixture(t)
  const big = join(root, 'huge.txt')
  writeFileSync(big, 'b'.repeat(2 * 1024 * 1024))
  const read = await tools['file.read'].run({ path: big, maxChars: 200 })
  assert.equal(read.ok, true)
  assert.equal(read.data.text.length, 200)
  assert.equal(read.data.truncated, true)
  assert.equal(read.data.nextOffsetBytes, 200)
  assert.match(read.summary, /nextOffsetBytes/)

  for (let i = 0; i < 260; i++) writeFileSync(join(root, `n${i}.txt`), 'x')
  const listed = await tools['file.list'].run({ dir: root, limit: 50, offset: 10 })
  assert.equal(listed.ok, true)
  assert.equal(listed.data.entries.length, 50)
  assert.equal(listed.data.more, true)
  assert.match(listed.summary, /还有更多/)

  const defaulted = await tools['file.list'].run({ dir: root })
  assert.equal(defaulted.data.entries.length, 200)

  await assert.rejects(tools['file.list'].run({ dir: join(root, 'missing') }))
})

test('file pages sent to the model reconstruct UTF-8 without skipping escaped or multibyte content', async (t) => {
  const path = join(fixture(t), 'pages.txt')
  const original = '\uFEFF' + '你好😀"\\\r\n\0\uFFFD'.repeat(4200) + '尾页'
  writeFileSync(path, original)
  const pages = []
  let offsetBytes = 0
  do {
    const result = await tools['file.read'].run({ path, offsetBytes })
    const envelope = JSON.parse(serializeToolResult(result))
    assert.equal(envelope.truncated, undefined)
    assert.equal(envelope.data.offsetBytes, offsetBytes)
    assert.ok(envelope.data.nextOffsetBytes === null || envelope.data.nextOffsetBytes > offsetBytes)
    pages.push(envelope.data.text)
    offsetBytes = envelope.data.nextOffsetBytes
  } while (offsetBytes !== null)
  assert.ok(pages.length > 4)
  assert.equal(pages.join(''), original)
  await assert.rejects(tools['file.read'].run({ path, offsetBytes: 4 }), /UTF-8/)
})

test('file.write replaces only a unique exact match and saves the original backup', async (t) => {
  const path = join(fixture(t), 'edit.txt')
  const original = '第一行\r\n保留😀\r\n第三行\r\n'
  writeFileSync(path, original)
  const replace = (oldText, content) => tools['file.write'].run({ path, mode: 'replace', oldText, content })
  assert.equal((await replace('\r\n', 'x')).ok, false)
  assert.equal((await replace('缺失', 'x')).ok, false)
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.equal((await replace('保留😀', '新内容')).ok, true)
  assert.equal(readFileSync(path, 'utf8'), original.replace('保留😀', '新内容'))
  assert.equal(readFileSync(path + '.bak', 'utf8'), original)
})
