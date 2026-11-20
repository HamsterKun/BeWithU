/* 日志尾部读取：只读最后一段、按关键字/问题级别过滤（不需要 Electron） */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { readLogTail, classify } = await import('../src/main/services/log-tail.ts')

function makeLog(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'bwu-log-'))
  const file = join(dir, 'app.log')
  writeFileSync(file, content, 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return file
}

const LINES = [
  '2026-11-20T06:00:00.000Z boot: 就绪',
  '2026-11-20T06:00:01.000Z llm: http error 401 鉴权失败',
  '2026-11-20T06:00:02.000Z vision: 已截屏 1280x800',
  '2026-11-20T06:00:03.000Z input: 工作进程已启动',
  '2026-11-20T06:00:04.000Z context: 压缩超时，已降级'
].join('\n')

test('级别是按关键字推断的', () => {
  assert.equal(classify('llm: http error 401 鉴权失败'), 'error')
  assert.equal(classify('context: 压缩超时，已降级'), 'warn')
  assert.equal(classify('boot: 就绪'), 'info')
  // 正常日志不能被染红
  assert.equal(classify('agent: 内置工具已注册'), 'info')
})

test('文件名不存在时返回空结构而不抛错', () => {
  const r = readLogTail(join(tmpdir(), 'nope-not-here.log'))
  assert.equal(r.lines.length, 0)
  assert.equal(r.sizeBytes, 0)
})

test('返回最新 N 行，并从行首解析时间戳', (t) => {
  const file = makeLog(t, LINES)
  const r = readLogTail(file, { lines: 2 })
  assert.equal(r.shown, 2)
  assert.deepEqual(
    r.lines.map((l) => l.text),
    ['input: 工作进程已启动', 'context: 压缩超时，已降级']
  )
  assert.equal(r.lines[0].at, '2026-11-20T06:00:03.000Z')
  assert.equal(r.lines[1].level, 'warn')
})

test('关键字过滤不区分大小写', (t) => {
  const file = makeLog(t, LINES.replace('http error', 'HTTP ERROR'))
  assert.equal(readLogTail(file, { keyword: 'http error' }).shown, 1)
  assert.equal(readLogTail(file, { keyword: '截屏' }).shown, 1)
  assert.equal(readLogTail(file, { keyword: '不存在的词' }).shown, 0)
})

test('只看问题会滤掉信息级', (t) => {
  const file = makeLog(t, LINES)
  const all = readLogTail(file, { lines: 50 })
  const problems = readLogTail(file, { lines: 50, onlyProblems: true })
  assert.equal(all.shown, 5)
  assert.equal(problems.shown, 2)
  assert.ok(problems.lines.every((l) => l.level !== 'info'))
})

test('超过上限时只读尾部，且不会返回半行', (t) => {
  const big = Array.from({ length: 4000 }, (_, i) => `2026-11-20T06:00:00.000Z 填充行 ${i} ${'x'.repeat(200)}`)
  const file = makeLog(t, big.join('\n'))
  const r = readLogTail(file, { lines: 3 })
  assert.equal(r.shown, 3)
  // 最后一行完整、不是半截
  assert.ok(r.lines[2].text.endsWith(`${'x'.repeat(200)}`))
  assert.ok(r.lines[2].text.includes('填充行 3999'))
  // 每一行都必须带着时间戳被正确解析（说明没有从中间截断出残句）
  assert.ok(r.lines.every((l) => l.at.startsWith('2026-11-20T')))
})
