/**
 * 自定义工具（第三方导入）
 *
 * 目录：<userData>/agent/tools/<id>/
 *   manifest.json  { id, name, description, risk, permissions, params }
 *   index.js       module.exports = { async run(args, api) {...} }
 *
 * 安全模型（务必理解）：
 * - 隔离靠"进程 + 显式信任"：工具代码在独立 utilityProcess 里跑，崩溃不影响主进程；
 * - api 只暴露 log / fs.read / fs.write / notify / net 五个能力，且按 manifest.permissions 校验；
 * - 但子进程本身是完整 Node，恶意代码理论上能绕过 api 自己 require('fs')。
 *   所以真正的闸门是「导入时的信任勾选」，UI 必须把这句话说给用户听。
 */
import { app, Notification } from 'electron'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { utilityProcess } from 'electron'
import { registerTool, unregisterTool, getTool } from './registry'
import { resolveAgentPath } from './tools/files'
import { settingsStore } from '../store/settings'
import { log } from '../logger'
import { extractZip } from './import-archive'
import type { ToolResult, ToolRisk, JsonSchema } from './types'

export interface CustomToolInfo {
  id: string
  name: string
  description: string
  risk: ToolRisk
  permissions: string[]
  params: JsonSchema
  entry: string
  dir: string
  trusted: boolean
  error?: string
}

const ALLOWED_PERMS = ['fs.read', 'fs.write', 'notify', 'net']
const registeredIds = new Set<string>()

export function toolsDir(): string {
  const dir = join(app.getPath('userData'), 'agent', 'tools')
  mkdirSync(dir, { recursive: true })
  return dir
}

function readManifest(dir: string): CustomToolInfo | null {
  const file = join(dir, 'manifest.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
    const id = String(raw.id ?? '').trim()
    if (!id) return null
    const perms = Array.isArray(raw.permissions)
      ? raw.permissions.map(String).filter((p) => ALLOWED_PERMS.includes(p))
      : []
    return {
      id,
      name: String(raw.name ?? id).trim() || id,
      description: String(raw.description ?? '').trim(),
      risk: raw.risk === 'low' ? 'low' : 'high',
      permissions: perms,
      params:
        raw.params && typeof raw.params === 'object'
          ? (raw.params as JsonSchema)
          : { type: 'object', properties: {}, additionalProperties: false },
      entry: String(raw.entry ?? 'index.js'),
      dir,
      trusted: false
    }
  } catch (e) {
    log('custom-tool: manifest 解析失败', dir, e instanceof Error ? e.message : e)
    return null
  }
}

export function scanCustomTools(): CustomToolInfo[] {
  const dir = toolsDir()
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  const trusted = settingsStore.get().agent.trustedTools
  return entries
    .map((name) => readManifest(join(dir, name)))
    .filter((t): t is CustomToolInfo => Boolean(t))
    .map((t) => ({ ...t, trusted: trusted.includes(t.id) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function validateToolEntry(dir: string, entry: string): string {
  if (!entry || isAbsolute(entry)) throw new Error('工具入口必须是工具目录内的相对路径')
  const root = realpathSync(dir)
  const candidate = resolve(root, entry)
  const rel = relative(root, candidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('工具入口必须位于工具目录内')
  }
  const stat = lstatSync(candidate)
  if (!stat.isFile() || stat.isSymbolicLink() || !/\.(c?js)$/i.test(candidate)) {
    throw new Error('工具入口必须是目录内的普通 .js / .cjs 文件（不接受链接）')
  }
  const realEntry = realpathSync(candidate)
  const realRel = relative(root, realEntry)
  if (realRel.startsWith(`..${sep}`) || realRel === '..' || isAbsolute(realRel)) {
    throw new Error('工具入口不能指向工具目录外')
  }
  return realEntry
}

/** 从任意目录导入（目录里要有 manifest.json + 入口文件） */
export function importCustomTool(srcDir: string): CustomToolInfo {
  const manifest = readManifest(srcDir)
  if (!manifest) throw new Error('这个目录里没有合法的 manifest.json（需要 id / name / description）')
  if (getTool(manifest.id)) throw new Error(`工具 id「${manifest.id}」和内置工具冲突，请换一个 id`)
  validateToolEntry(srcDir, manifest.entry)

  const safeId = manifest.id.replace(/[^\w.-]+/g, '-')
  if (safeId === '.' || safeId === '..' || safeId.endsWith('.') || safeId.startsWith('mcp.')) {
    throw new Error('工具 ID 不能用作安全的目录名，或使用了保留前缀')
  }
  const dest = join(toolsDir(), safeId)
  if (existsSync(dest)) throw new Error(`已经存在同名工具：${safeId}`)
  cpSync(srcDir, dest, { recursive: true, force: true })
  log('custom-tool: 已导入', safeId)
  const info = readManifest(dest)
  if (!info) throw new Error('导入后解析失败')
  validateToolEntry(dest, info.entry)
  return info
}

/** 从 zip 导入：解压后按目录导入，临时文件会自动清理 */
export async function importCustomToolArchive(zipPath: string): Promise<CustomToolInfo> {
  const { dir, cleanup } = await extractZip(zipPath)
  try {
    return importCustomTool(dir)
  } finally {
    cleanup()
  }
}

export function deleteCustomTool(id: string): void {
  const tool = scanCustomTools().find((item) => item.id === id)
  if (!tool || !lstatSync(tool.dir).isDirectory()) return
  unregisterCustomTool(id)
  setToolTrusted(id, false)
  rmSync(tool.dir, { recursive: true, force: true })
  log('custom-tool: 已删除', id)
}

export function setToolTrusted(id: string, trusted: boolean): void {
  const cfg = settingsStore.get().agent
  const next = trusted
    ? [...new Set([...cfg.trustedTools, id])]
    : cfg.trustedTools.filter((x) => x !== id)
  settingsStore.update({ agent: { trustedTools: next } })
}

function unregisterCustomTool(id: string): void {
  if (!registeredIds.has(id)) return
  unregisterTool(id)
  registeredIds.delete(id)
}

/** 把已信任的自定义工具注册进注册表（幂等） */
export function registerCustomTools(): void {
  const list = scanCustomTools()
  const allow = new Set(list.filter((t) => t.trusted).map((t) => t.id))
  for (const id of [...registeredIds]) {
    if (!allow.has(id) || !list.some((t) => t.id === id)) unregisterCustomTool(id)
  }
  for (const t of list) {
    if (!t.trusted || registeredIds.has(t.id) || getTool(t.id)) continue
    registerTool({
      id: t.id,
      name: t.name,
      description: t.description,
      risk: t.risk,
      params: t.params,
      run: (args) => runCustomTool(t, args)
    })
    registeredIds.add(t.id)
  }
  if (list.length) log('custom-tool: 已注册', [...registeredIds].join(', ') || '（无已信任工具）')
}

/* ------------------------------------------------------------ 执行（子进程） -- */

interface RunReply {
  type: 'result' | 'error'
  ok?: boolean
  summary?: string
  data?: unknown
  message?: string
}

function runCustomTool(tool: CustomToolInfo, args: Record<string, unknown>): Promise<ToolResult> {
  const entry = relative(realpathSync(tool.dir), validateToolEntry(tool.dir, tool.entry))
  return new Promise<ToolResult>((resolve) => {
    let settled = false
    const finish = (r: ToolResult): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(r)
    }

    let child: Electron.UtilityProcess
    try {
      child = utilityProcess.fork(join(__dirname, 'tool-worker.js'), [], {
        serviceName: `BeWithU Tool: ${tool.id}`
      })
    } catch (e) {
      resolve({ ok: false, summary: `工具进程启动失败：${e instanceof Error ? e.message : String(e)}` })
      return
    }

    const timer = setTimeout(() => finish({ ok: false, summary: '工具执行超时' }), 25000)

    child.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'api') {
        void handleApiCall(msg.method, msg.params, tool, child).then((res) => {
          try {
            child.postMessage({ type: 'api-result', reqId: msg.reqId, ...res })
          } catch {
            /* ignore */
          }
        })
        return
      }
      if (msg.type === 'result') {
        clearTimeout(timer)
        const r = msg as RunReply
        finish({
          ok: r.ok !== false,
          summary: String(r.summary ?? '（工具没有返回说明）'),
          data: r.data
        })
        return
      }
      if (msg.type === 'error') {
        clearTimeout(timer)
        finish({ ok: false, summary: String(msg.message ?? '工具执行失败') })
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      finish({ ok: false, summary: '工具进程意外退出（可能是代码报错，详见日志）' })
    })

    child.postMessage({
      type: 'run',
      toolDir: tool.dir,
      entry,
      args,
      permissions: tool.permissions
    })
  })
}

/** 子进程只能通过这个函数拿到能力；权限在这里校验 */
async function handleApiCall(
  method: string,
  params: Record<string, unknown>,
  tool: CustomToolInfo,
  child: Electron.UtilityProcess
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const deny = (perm: string): { ok: false; error: string } => ({
    ok: false,
    error: `工具没有声明 ${perm} 权限`
  })
  try {
    switch (method) {
      case 'log': {
        log(`custom[${tool.id}]`, String(params.message ?? ''))
        return { ok: true, value: null }
      }
      case 'fs.read': {
        if (!tool.permissions.includes('fs.read')) return deny('fs.read')
        const file = await resolveAgentPath(String(params.path ?? ''))
        return { ok: true, value: readFileSync(file, 'utf8').slice(0, 20000) }
      }
      case 'fs.write': {
        if (!tool.permissions.includes('fs.write')) return deny('fs.write')
        const file = await resolveAgentPath(String(params.path ?? ''), { allowMissing: true })
        const content = String(params.content ?? '')
        mkdirSync(join(file, '..'), { recursive: true })
        await resolveAgentPath(join(file, '..'))
        await resolveAgentPath(file, { allowMissing: true })
        writeFileSync(file, content, 'utf8')
        return { ok: true, value: file }
      }
      case 'notify': {
        if (!tool.permissions.includes('notify')) return deny('notify')
        if (Notification.isSupported()) {
          new Notification({ title: String(params.title ?? tool.name), body: String(params.body ?? '') }).show()
        }
        return { ok: true, value: null }
      }
      case 'net': {
        if (!tool.permissions.includes('net')) return deny('net')
        const url = String(params.url ?? '')
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只支持 http(s)' }
        const c = new AbortController()
        const t = setTimeout(() => c.abort(), 10000)
        try {
          const res = await fetch(url, { signal: c.signal })
          const text = (await res.text()).slice(0, 100000)
          return { ok: true, value: { status: res.status, text } }
        } finally {
          clearTimeout(t)
        }
      }
      default:
        return { ok: false, error: `未知能力：${method}` }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 给设置页用的示例：第一次打开工具目录时放一份模板，降低作者门槛 */
export function writeToolTemplate(): void {
  const dir = join(toolsDir(), '_example')
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id: 'example.hello',
        name: '示例工具',
        description: '把传入的名字拼成一句问候（演示自定义工具怎么写）',
        risk: 'low',
        permissions: ['notify'],
        params: {
          type: 'object',
          properties: { name: { type: 'string', description: '要问候的人' } },
          required: ['name'],
          additionalProperties: false
        }
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(dir, 'index.js'),
    [
      '// 自定义工具入口：导出 async run(args, api)',
      '// api 只有：log / fs.read / fs.write / notify / net，且需要在 manifest.permissions 里声明',
      'module.exports = {',
      '  async run(args, api) {',
      "    const name = String(args.name || '朋友')",
      "    api.log('hello tool: ' + name)",
      '    return { ok: true, summary: `你好，${name}！（来自示例工具）` }',
      '  }',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
}
