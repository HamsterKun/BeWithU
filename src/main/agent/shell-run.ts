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

/**
 * 解码子进程输出。
 * Windows PowerShell 5.1 默认按控制台代码页（中文系统是 GBK）写 stdout，
 * 直接当 UTF-8 读就会变成一串"锟斤拷"。所以先试 UTF-8，出现替换字符再回退 GBK。
 */
function decode(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  const text = utf8.includes('\uFFFD')
    ? (() => {
        try {
          return new TextDecoder('gbk').decode(buf)
        } catch {
          return utf8
        }
      })()
    : utf8
  return cleanOutput(text)
}

/** 去掉 CLIXML 噪音、ANSI 颜色码、行尾多余空白 */
function cleanOutput(text: string): string {
  return text
    .replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function clip(s: string): string {
  const t = s.trim()
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…（输出过长已截断）` : t
}

/** 运行一段 PowerShell；超时或调用方取消时杀进程 */
export function runPowerShell(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    // 不往命令里塞编码前缀（否则 PowerShell 报错时会把整段前缀抄进错误文本），
    // 改成读取后先按 UTF-8 解码，失败再按 GBK 回退。
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let timedOut = false
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const stdout = decode(Buffer.concat(outChunks))
      const stderr = decode(Buffer.concat(errChunks))
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
      outChunks.push(d)
      if (outChunks.length > 2000) outChunks.splice(0, 1000)
    })
    child.stderr?.on('data', (d: Buffer) => {
      errChunks.push(d)
      if (errChunks.length > 1000) errChunks.splice(0, 500)
    })
    child.on('error', (e) => {
      errChunks.push(Buffer.from(String(e), 'utf8'))
      finish(-1)
    })
    child.on('close', (code) => {
      finish(code ?? -1)
      log('agent: shell 结束', `code=${code}`)
    })
  })
}
