import { screen, utilityProcess, type Point, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { log } from '../logger'
import type { WindowsHotkey } from './windows-hotkey'

type PointerSample = { type: 'pointer'; visible: boolean | null; edge?: 'down' | 'up'; point?: Point }
type Sample = PointerSample | { type: 'hotkey'; generation: number; down?: boolean }

let worker: UtilityProcess | null = null
let cursorVisible: boolean | null = null
let generation = 0
let chord: WindowsHotkey | null = null
let onHotkey: ((down?: boolean | null) => void) | undefined
let onPointer: ((visible: boolean | null, edge?: 'down' | 'up', point?: Point) => void) | undefined
let retry: NodeJS.Timeout | undefined

export function windowsCursorVisible(): boolean | null {
  return cursorVisible
}

export function setWindowsPointerHandler(handler: typeof onPointer): void {
  onPointer = handler
}

function startWorker(canRetry: boolean): void {
  try {
    const input = utilityProcess.fork(join(__dirname, 'input-state-worker.js'), [], { serviceName: 'BeWithU Input State' })
    worker = input
    input.once('message', () => log('input-state: 工作进程已就绪'))
    input.on('message', (sample: Sample) => {
      if (worker !== input) return
      if (sample.type === 'hotkey') {
        if (sample.generation === generation) onHotkey?.(sample.down)
        return
      }
      cursorVisible = sample.visible
      const point = sample.point && screen.screenToDipPoint(sample.point)
      onPointer?.(cursorVisible, sample.edge, point)
    })
    input.on('exit', (code) => {
      if (worker !== input) return
      log('input-state: 工作进程退出', code)
      worker = null
      cursorVisible = null
      onPointer?.(null)
      onHotkey?.(null)
      if (canRetry) retry = setTimeout(() => {
        retry = undefined
        startWorker(false)
      }, 1000)
    })
    input.postMessage({ hotkey: chord, generation })
  } catch (error) {
    log('input-state: 工作进程启动失败', error)
    onHotkey?.(null)
  }
}

export function watchWindowsInput(hotkey: WindowsHotkey | null, handler: typeof onHotkey): void {
  if (process.platform !== 'win32') return
  chord = hotkey
  onHotkey = handler
  generation++
  if (worker) worker.postMessage({ hotkey, generation })
  else if (!retry) startWorker(true)
}

export function stopWatchingWindowsInput(): void {
  if (retry) clearTimeout(retry)
  retry = undefined
  const input = worker
  worker = null
  input?.kill()
  cursorVisible = null
}
