/* 数字显示：1000k 要写成 1M */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { formatTokens } = await import('../src/shared/format.ts')

test('百万级用 M，不再出现 1000k', () => {
  assert.equal(formatTokens(1000000), '1M')
  assert.equal(formatTokens(1234567), '1.2M')
  assert.equal(formatTokens(15000000), '15M')
})

test('万级用 k，十万以下保留一位小数', () => {
  assert.equal(formatTokens(77141), '77.1k')
  assert.equal(formatTokens(128000), '128k')
  assert.equal(formatTokens(987712), '988k')
})

test('小数字原样，非法值给 0', () => {
  assert.equal(formatTokens(149), '149')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens(Number.NaN), '0')
})
