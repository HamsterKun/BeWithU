/** 语音触发方式与实际生效方式
 *
 * 评审 C7：按键监听降级后（uiohook 加载/启动失败），只能用 Electron `globalShortcut`
 * 注册键盘组合，并且每次只能给出一次按键事件——拿不到真实的按下/抬起时序。
 * 所以降级时"按住说话"没法工作，实际必须按"切换模式"处理。
 */

export type VoiceMode = 'hold' | 'toggle'

export function effectiveVoiceMode(configured: VoiceMode, fallback: boolean): VoiceMode {
  return fallback ? 'toggle' : configured
}
