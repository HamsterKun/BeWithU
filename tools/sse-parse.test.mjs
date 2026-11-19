import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sseData, sseLines, splitSseLines } from '../src/main/services/sse.ts'

const collect = async (chunks) => {
  const out = []
  const stream = (async function* () {
    for (const c of chunks) yield Buffer.from(c, 'utf8')
  })()
  for await (const line of sseLines(stream)) out.push(line)
  return out
}

test('splitSseLines 处理 LF / CRLF / 单独 CR，并保留被切开的 CR', () => {
  assert.deepEqual(splitSseLines('a\nb\nc\n'), { lines: ['a', 'b', 'c'], rest: '' })
  assert.deepEqual(splitSseLines('a\r\nb\r\n'), { lines: ['a', 'b'], rest: '' })
  assert.deepEqual(splitSseLines('a\rb\r'), { lines: ['a'], rest: 'b\r' })
  // 结尾的 \r 可能是下一块 \n 的前半截，不能当行尾吃掉
  assert.deepEqual(splitSseLines('x\r'), { lines: [], rest: 'x\r' })
  assert.deepEqual(splitSseLines(''), { lines: [], rest: '' })
})

test('sseLines 在流结束时吐出没有换行符的最后一条事件', async () => {
  const lines = await collect(['data: {"a":1}\n\n', 'data: {"a":2}'])
  assert.deepEqual(lines, ['data: {"a":1}', '', 'data: {"a":2}'])
})

test('sseLines 处理 CRLF、跨块切分与 CR 被切开的情况', async () => {
  const lines = await collect(['data: 1\r', '\n\r\n', 'data: 2\r\n', '\r\ndata: 3'])
  assert.deepEqual(lines.filter((l) => l.startsWith('data:')), ['data: 1', 'data: 2', 'data: 3'])
})

test('sseLines 保留多字节字符跨块解码', async () => {
  const text = 'data: {"t":"尾句也在。"}'
  const bytes = Buffer.from(text, 'utf8')
  const cut = bytes.length - 3
  const lines = await collect([bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.deepEqual(lines, [text])
})

test('sseData 只认 data: 行，忽略注释 / event / 空行', () => {
  assert.equal(sseData('data: {"x":1}'), '{"x":1}')
  assert.equal(sseData('data:   {"x":1}  '), '{"x":1}')
  assert.equal(sseData(': keep-alive'), null)
  assert.equal(sseData('event: message'), null)
  assert.equal(sseData(''), null)
  assert.equal(sseData('{"x":1}'), null)
})
