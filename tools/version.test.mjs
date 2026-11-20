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

test('供应商上报的上下文长度优先于内置表', async () => {
  const { resolveModelWindow } = await import('../src/shared/model-window.ts')
  // 手动 > 供应商 > 内置表 > 兜底
  assert.equal(resolveModelWindow('deepseek-chat', 0, 1000000).source, 'provider')
  assert.equal(resolveModelWindow('deepseek-chat', 0, 1000000).window, 1000000)
  assert.equal(resolveModelWindow('deepseek-chat', 0, 0).source, 'table')
  assert.equal(resolveModelWindow('deepseek-chat', 0, 0).window, 128000)
  assert.equal(resolveModelWindow('some-unknown-model', 0, 0).source, 'fallback')
  assert.equal(resolveModelWindow('deepseek-chat', 256000, 1000000).source, 'manual')
  assert.equal(resolveModelWindow('deepseek-chat', 256000, 1000000).window, 256000)
  // 供应商给的值小于 8k 视为无效，不让它把预算压死
  assert.equal(resolveModelWindow('deepseek-chat', 0, 4096).source, 'table')
})

test('各家供应商的上下文字段都能认出来', async () => {
  const { pickProviderWindow } = await import('../src/shared/model-window.ts')
  assert.equal(pickProviderWindow({ id: 'a', context_length: 1000000 }), 1000000)
  assert.equal(pickProviderWindow({ id: 'a', context_window: 200000 }), 200000)
  assert.equal(pickProviderWindow({ id: 'a', max_input_tokens: 128000 }), 128000)
  assert.equal(pickProviderWindow({ id: 'a', context: 256000 }), 256000)
  // 嵌套在 meta / limits 里
  assert.equal(pickProviderWindow({ id: 'a', meta: { context_length: 32000 } }), 32000)
  assert.equal(pickProviderWindow({ id: 'a', limits: { max_context_length: 64000 } }), 64000)
  // 只有 id 或给的是输出上限时返回 0（交给内置表）
  assert.equal(pickProviderWindow({ id: 'a' }), 0)
  assert.equal(pickProviderWindow({ id: 'a', max_tokens: 4096 }), 0)
  assert.equal(pickProviderWindow({ id: 'a', context_length: 'abc' }), 0)
})
