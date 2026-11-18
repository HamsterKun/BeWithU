/* 开发用演示：不依赖任何 API Key，模拟一整轮"说话→回答→播报"，
   用来检查气泡排版、文字流式、悬浮球状态与音频播放链路。
   用法：设置环境变量 BWU_DEMO=1 后启动。 */

import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { broadcastPhase, getBallWindow, sendBubble, showBubble } from './windows'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const QUESTION = '我现在在打永劫无间，队友一直送，怎么打？'
const ANSWER =
  '先别急着喷他。想赢就换个思路：让他去守点，你去开团。人少就别硬刚，拉扯一下等队友复活，千万别一个一个上。'

function tone(seconds: number, freq = 392): Int16Array {
  const rate = 24000
  const n = Math.floor(rate * seconds)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = Math.min(1, t * 8) * Math.max(0, 1 - t / seconds)
    const v = Math.sin(2 * Math.PI * freq * t) * 0.12 * env + Math.sin(2 * Math.PI * freq * 2 * t) * 0.05 * env
    out[i] = Math.round(v * 32767)
  }
  return out
}

async function playTone(totalSec: number): Promise<void> {
  const win = getBallWindow()
  if (!win) return
  const all = tone(totalSec)
  const chunk = 4800 // 200ms
  const seq = 0
  for (let i = 0; i < all.length; i += chunk) {
    const part = all.subarray(i, Math.min(all.length, i + chunk))
    const copy = new Int16Array(part)
    win.webContents.send(IPC.audioChunk, {
      seq,
      pcm: copy.buffer,
      sampleRate: 24000,
      last: false
    })
    await sleep(120)
  }
  win.webContents.send(IPC.audioChunk, { seq, pcm: new ArrayBuffer(0), sampleRate: 24000, last: true })
  win.webContents.send(IPC.audioEnd)
}

export async function runDemoLoop(): Promise<void> {
  ipcMain.on(IPC.audioDrained, () => {
    // 演示模式下播放结束即回到空闲
    broadcastPhase('idle')
  })
  for (;;) {
    try {
      await sleep(1500)
      showBubble()
      broadcastPhase('listening')
      sendBubble({ type: 'user', text: '', final: false })
      for (let i = 2; i <= QUESTION.length; i += 2) {
        sendBubble({ type: 'user', text: QUESTION.slice(0, i), final: false })
        await sleep(60)
      }
      sendBubble({ type: 'user', text: QUESTION, final: true })
      await sleep(600)
      broadcastPhase('thinking')
      await sleep(500)
      sendBubble({ type: 'assistant-reset' })
      for (const ch of ANSWER) {
        sendBubble({ type: 'assistant-delta', text: ch })
        await sleep(26)
      }
      sendBubble({ type: 'assistant-end' })
      broadcastPhase('speaking')
      await playTone(4)
      await sleep(800)
      broadcastPhase('idle')
      await sleep(2500)
    } catch {
      await sleep(1500)
    }
  }
}
