import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveVoiceMode } from '../src/main/input/voice-mode.ts'

test('降级监听时强制切换模式，正常时按用户配置', () => {
  // REVIEW C7：降级实现只给一次按键事件，按住说话拿不到抬起时机
  assert.equal(effectiveVoiceMode('hold', true), 'toggle')
  assert.equal(effectiveVoiceMode('toggle', true), 'toggle')
  assert.equal(effectiveVoiceMode('hold', false), 'hold')
  assert.equal(effectiveVoiceMode('toggle', false), 'toggle')
})
