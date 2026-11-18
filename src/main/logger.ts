import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

let logFile: string | null = null
let enabled = true

function ensureFile(): string {
  if (logFile) return logFile
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'app.log')
  try {
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) {
      renameSync(logFile, join(dir, 'app.old.log'))
    }
  } catch {
    /* ignore */
  }
  return logFile
}

function sanitize(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
    .replace(/("(?:apiKey|accessToken|api_key|access_token|Authorization)"\s*:\s*")[^"]+/gi, '$1****')
    .replace(/(Bearer\s+)[\w.-]{8,}/g, '$1****')
    .replace(/(X-Api-[A-Za-z-]+:\s*)\S+/g, '$1****')
}

export function log(...args: unknown[]): void {
  if (!enabled) return
  const line = `${new Date().toISOString()} ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a)))
    .join(' ')}`
  const clean = sanitize(line)
  console.log(clean)
  try {
    appendFileSync(ensureFile(), clean + '\n')
  } catch {
    /* ignore */
  }
}

export function setLogEnabled(v: boolean): void {
  enabled = v
}

export function logPath(): string {
  return ensureFile()
}
