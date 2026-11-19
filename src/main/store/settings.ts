import { app, safeStorage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { BUILTIN_SKINS, DEFAULT_SKIN } from '../../shared/art'
import type { PublicSettings, SecretPath, Settings, SettingsPatch } from '../../shared/types'
import { log } from '../logger'

const SECRET_PATHS: SecretPath[] = [
  'llm.apiKey',
  'llm.summary.apiKey',
  'tts.accessToken',
  'tts.apiKey',
  'tts.breeze.apiKey',
  'asr.accessToken',
  'asr.apiKey',
  'search.tavilyApiKey',
  'search.deepseekApiKey'
]

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base
  const out: Record<string, unknown> = isPlainObject(base) ? { ...(base as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const prev = out[k]
    out[k] = isPlainObject(v) && isPlainObject(prev) ? deepMerge(prev, v) : v
  }
  return out as T
}

function getPath(obj: unknown, path: string): string {
  return path.split('.').reduce<unknown>((acc, k) => (isPlainObject(acc) ? acc[k] : undefined), obj) as string
}

function setPath(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (!isPlainObject(cur[k])) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

const clamp = (v: number, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

class SettingsStore {
  private data: Settings = clone(DEFAULT_SETTINGS)
  private dir = ''
  private initialized = false

  private get settingsFile(): string {
    return join(this.dir, 'settings.json')
  }
  private get secretsFile(): string {
    return join(this.dir, 'secrets.bin')
  }

  init(): void {
    if (this.initialized) return
    this.dir = app.getPath('userData')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.load()
    this.initialized = true
  }

  private load(): void {
    try {
      if (existsSync(this.settingsFile)) {
        const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, any>
        // 老配置没有 authMode：如果已经填了 AppID，就沿用旧版控制台鉴权
        if (raw?.tts && raw.tts.authMode === undefined && raw.tts.appId) raw.tts.authMode = 'console'
        if (raw?.asr && raw.asr.authMode === undefined && raw.asr.appId) raw.asr.authMode = 'console'
        // 曾经默认给的是 1.0 的资源 ID，2.0 开通后要换成 seedasr（接口也不同）
        if (raw?.asr && raw.asr.resourceId === 'volc.bigasr.sauc.duration') {
          raw.asr.resourceId = 'volc.seedasr.sauc.duration'
        }
        // 一次性迁移：新版把语音合成默认改为关闭
        if (raw?.tts && !raw?.meta?.ttsDefaultOffApplied) {
          raw.tts.enabled = false
          raw.meta = { ...(raw.meta || {}), ttsDefaultOffApplied: true }
        }
        this.data = this.normalize(deepMerge(clone(DEFAULT_SETTINGS), raw))
      }
    } catch (e) {
      log('settings: 读取失败，使用默认值', e)
      try {
        copyFileSync(this.settingsFile, `${this.settingsFile}.broken-${Date.now()}`)
      } catch {
        /* ignore */
      }
      this.data = clone(DEFAULT_SETTINGS)
    }

    try {
      if (existsSync(this.secretsFile)) {
        const map = JSON.parse(readFileSync(this.secretsFile, 'utf8')) as Record<string, string>
        for (const p of SECRET_PATHS) {
          const enc = map[p]
          if (!enc) continue
          let value = ''
          if (enc.startsWith('plain:')) {
            value = Buffer.from(enc.slice(6), 'base64').toString('utf8')
          } else if (safeStorage.isEncryptionAvailable()) {
            value = safeStorage.decryptString(Buffer.from(enc, 'base64'))
          }
          if (value) setPath(this.data as unknown as Record<string, unknown>, p, value)
        }
      }
    } catch (e) {
      log('settings: 密钥读取失败', e)
    }
  }

  private normalize(s: Settings): Settings {
    s.ball.size = clamp(s.ball.size, 64, 152, 96)
    s.ball.opacity = clamp(s.ball.opacity, 20, 100, 84)
    s.ball.x = Number.isFinite(s.ball.x) ? Math.round(s.ball.x) : -1
    s.ball.y = Number.isFinite(s.ball.y) ? Math.round(s.ball.y) : -1
    // 旧的内置皮肤已被新皮肤替换：认不出的 builtin id 一律回落到默认皮肤
    if (s.ball.image?.startsWith('builtin:') && !BUILTIN_SKINS.some((k) => k.id === s.ball.image)) {
      s.ball.image = DEFAULT_SKIN
    }
    s.llm.temperature = clamp(s.llm.temperature, 0, 2, 0.8)
    s.llm.historyTurns = clamp(s.llm.historyTurns, 0, 50, 8)
    s.tts.speed = clamp(s.tts.speed, -50, 100, 0)
    s.tts.loudness = clamp(s.tts.loudness, -50, 100, 0)
    s.tts.volume = clamp(s.tts.volume, 0, 1, 0.9)
    if (s.tts.provider !== 'breeze') s.tts.provider = 'volc'
    s.tts.breeze.modelId = (s.tts.breeze.modelId || '').trim() || 'breeze-tts-2'
    s.tts.breeze.voiceId = (s.tts.breeze.voiceId || '').trim()
    const lang = (s.tts.breeze.language || '').trim()
    s.tts.breeze.language = /^[A-Za-z]{2}$/.test(lang) ? lang.toLowerCase() : ''
    s.bubble.holdMs = clamp(s.bubble.holdMs, 0, 60000, 6000)
    s.voice.minHoldMs = clamp(s.voice.minHoldMs, 100, 3000, 250)
    if (!s.llm.systemPrompt?.trim()) s.llm.systemPrompt = DEFAULT_SETTINGS.llm.systemPrompt
    // 联网搜索
    if (s.search.provider !== 'deepseek') s.search.provider = 'tavily'
    s.search.maxResults = clamp(s.search.maxResults, 1, 10, 5)
    s.search.tavilyBaseUrl = (s.search.tavilyBaseUrl || '').trim() || 'https://api.tavily.com'
    s.search.deepseekBaseUrl = (s.search.deepseekBaseUrl || '').trim() || 'https://api.deepseek.com'
    s.search.auto = s.search.auto !== false
    // MCP 服务器
    const rawServers = Array.isArray(s.mcp?.servers) ? s.mcp.servers : []
    s.mcp = {
      servers: rawServers
        .map((m, i) => ({
          id: String(m?.id ?? `mcp-${i + 1}`).replace(/[^\w.-]+/g, '-'),
          name: String(m?.name ?? '').trim() || `MCP ${i + 1}`,
          enabled: m?.enabled !== false,
          transport: m?.transport === 'http' ? ('http' as const) : ('stdio' as const),
          command: String(m?.command ?? '').trim(),
          args: String(m?.args ?? '').trim(),
          url: String(m?.url ?? '').trim(),
          headers: String(m?.headers ?? '').trim()
        }))
        .filter((m) => m.command || m.url)
        .slice(0, 20)
    }
    // 名字允许留空（气泡里会显示为 TA），不要在这里强行填回默认值，
    // 否则用户清空输入框时会被"变回小伴"，根本改不了名
    s.ui.assistantName = (s.ui.assistantName || '').trim()
    // Agent 配置兜底（老配置没有这个字段时用默认值）
    const agent = s.agent ?? DEFAULT_SETTINGS.agent
    s.agent = {
      enabled: Boolean(agent.enabled),
      shellEnabled: Boolean(agent.shellEnabled),
      maxSteps: clamp(Number(agent.maxSteps) || 30, 3, 200, 30),
      stepTimeoutMs: clamp(Number(agent.stepTimeoutMs) || 20000, 5000, 120000, 20000),
      audit: agent.audit !== false,
      files: {
        fullAccess: Boolean(agent.files?.fullAccess),
        dirs: Array.isArray(agent.files?.dirs)
          ? agent.files.dirs.map((d) => String(d).trim()).filter(Boolean).slice(0, 20)
          : []
      },
      disabledTools: Array.isArray(agent.disabledTools) ? agent.disabledTools.map(String).slice(0, 100) : [],
      trustedTools: Array.isArray(agent.trustedTools) ? agent.trustedTools.map(String).slice(0, 100) : [],
      skillsEnabled: agent.skillsEnabled !== false
    }
    return s
  }

  get(): Settings {
    this.init()
    return this.data
  }

  public(): PublicSettings {
    const s = clone(this.data)
    const secretSet = {} as Record<SecretPath, boolean>
    for (const p of SECRET_PATHS) {
      secretSet[p] = Boolean(getPath(s, p))
      setPath(s as unknown as Record<string, unknown>, p, '')
    }
    return { ...s, secretSet }
  }

  /** 设置页"显示"按钮用：按需取回明文（仅本机 IPC，不外传） */
  reveal(path: SecretPath): string {
    this.init()
    if (!SECRET_PATHS.includes(path)) return ''
    return getPath(this.data, path) || ''
  }

  update(patch: SettingsPatch): PublicSettings {
    this.init()
    const { clearSecrets, ...rest } = patch as SettingsPatch & { clearSecrets?: SecretPath[] }
    const cur = clone(this.data)
    const merged = deepMerge(cur, rest) as Settings

    // 空字符串代表"不修改已保存的密钥"
    for (const p of SECRET_PATHS) {
      const incoming = getPath(merged, p)
      if (incoming === '' || incoming === undefined) {
        setPath(merged as unknown as Record<string, unknown>, p, getPath(this.data, p) || '')
      }
    }
    if (Array.isArray(clearSecrets)) {
      for (const p of clearSecrets) {
        if (SECRET_PATHS.includes(p)) setPath(merged as unknown as Record<string, unknown>, p, '')
      }
    }

    // 改名时同步替换提示词里的旧名字，保证 AI 知道自己叫什么
    const oldName = (this.data.ui.assistantName || '').trim()
    const newName = (merged.ui.assistantName || '').trim()
    if (oldName && newName && oldName !== newName && merged.llm.systemPrompt.includes(oldName)) {
      merged.llm.systemPrompt = merged.llm.systemPrompt.split(oldName).join(newName)
    }

    this.data = this.normalize(merged)
    this.save()
    return this.public()
  }

  reset(): PublicSettings {
    this.init()
    const secrets = SECRET_PATHS.map((p) => ({ p, v: getPath(this.data, p) }))
    this.data = clone(DEFAULT_SETTINGS)
    for (const { p, v } of secrets) setPath(this.data as unknown as Record<string, unknown>, p, v)
    this.save()
    return this.public()
  }

  save(): void {
    this.init()
    try {
      const onDisk = clone(this.data)
      for (const p of SECRET_PATHS) setPath(onDisk as unknown as Record<string, unknown>, p, '')
      mkdirSync(dirname(this.settingsFile), { recursive: true })
      const tmp = `${this.settingsFile}.tmp`
      writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf8')
      renameSync(tmp, this.settingsFile)
      this.saveSecrets()
    } catch (e) {
      log('settings: 保存失败', e)
    }
  }

  private saveSecrets(): void {
    const map: Record<string, string> = {}
    for (const p of SECRET_PATHS) {
      const v = getPath(this.data, p)
      if (!v) continue
      map[p] = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(v).toString('base64')
        : `plain:${Buffer.from(v, 'utf8').toString('base64')}`
    }
    const tmp = `${this.secretsFile}.tmp`
    writeFileSync(tmp, JSON.stringify(map), 'utf8')
    renameSync(tmp, this.secretsFile)
  }

  dataDir(): string {
    this.init()
    return this.dir
  }
}

export const settingsStore = new SettingsStore()
