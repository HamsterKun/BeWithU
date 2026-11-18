/** 执行 PowerShell 脚本（Shell 能力开启后才会被工具调用） */
import { spawn } from 'node:child_process'
import { log } from '../logger'

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const MAX_OUTPUT = 6000

function clip(s: string): string {
  const t = s.trim()
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…（输出过长已截断）` : t
}

/** 运行一段 PowerShell；超时或调用方取消时杀进程 */
export function runPowerShell(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout: clip(stdout), stderr: clip(stderr), timedOut })
    }
    const kill = (): void => {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        /* ignore */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      setTimeout(() => finish(-1), 400)
    }, Math.max(1000, opts.timeoutMs))
    const onAbort = (): void => {
      kill()
      setTimeout(() => finish(-2), 300)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      if (stdout.length > MAX_OUTPUT * 4) stdout = stdout.slice(0, MAX_OUTPUT * 4)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      if (stderr.length > MAX_OUTPUT * 2) stderr = stderr.slice(0, MAX_OUTPUT * 2)
    })
    child.on('error', (e) => {
      stderr += String(e)
      finish(-1)
    })
    child.on('close', (code) => {
      log('agent: shell 结束', `code=${code} out=${stdout.length} err=${stderr.length}`)
      finish(code ?? -1)
    })
  })
}
