/* 版本比较：只提示"更新"，不提示"降级" */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { compareVersions, isNewer } = await import('../src/shared/version.ts')

test('按数字段比较，不是字符串比较', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1)
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1)
  assert.equal(compareVersions('1.1.0', '1.0.99'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

test('段数不一致时缺的当 0', () => {
  assert.equal(compareVersions('1.1', '1.1.0'), 0)
  assert.equal(compareVersions('1.1.1', '1.1'), 1)
  assert.equal(compareVersions('2', '1.9.9'), 1)
})

test('v 前缀不影响', () => {
  assert.equal(compareVersions('v1.1.0', '1.1.0'), 0)
  assert.equal(compareVersions('V1.1.1', 'v1.1.0'), 1)
})

test('预发布版本比正式版旧', () => {
  assert.equal(compareVersions('1.1.0-beta', '1.1.0'), -1)
  assert.equal(compareVersions('1.1.0', '1.1.0-beta'), 1)
  assert.equal(compareVersions('1.1.0-beta.2', '1.1.0-beta.1'), 1)
})

test('isNewer 只在更高时为真', () => {
  assert.equal(isNewer('1.1.1', '1.1.0'), true)
  assert.equal(isNewer('1.1.0', '1.1.0'), false)
  // 远端比本地旧（比如给老版本发了 hotfix）不能提示更新
  assert.equal(isNewer('1.0.2', '1.1.0'), false)
  assert.equal(isNewer('', '1.1.0'), false)
})

test('奇怪的版本号不会抛错', () => {
  assert.equal(isNewer('abc', '1.1.0'), false)
  assert.equal(compareVersions('1.1.0', ''), 1)
})
