import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { BUILTIN_SKINS, DEFAULT_SKIN } from '../../shared/art'
import type { PublicSettings, SecretPath, Settings, SettingsPatch } from '../../shared/types'
import { log } from '../logger'

const SECRET_PATHS: SecretPath[] = [
  'llm.apiKey',
  'tts.accessToken',
  'tts.apiKey',
  'tts.breeze.apiKey',
  'asr.accessToken',
  'asr.apiKey',
  'search.tavilyApiKey',
  'search.deepseekApiKey'
]

type McpHeadersPath = `mcp.${string}.headers`
const mcpHeadersPath = (id: string): McpHeadersPath => `mcp.${id}.headers`

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
  private get legacySecretsFile(): string {
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
    let embeddedSecrets: Record<string, unknown> | undefined
    try {
      if (existsSync(this.settingsFile)) {
        const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, any>
        if (isPlainObject(raw) && Object.hasOwn(raw, 'encryptedSecrets')) {
          embeddedSecrets = isPlainObject(raw.encryptedSecrets) ? raw.encryptedSecrets : {}
          delete raw.encryptedSecrets
        }
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
        if (isPlainObject(raw?.ball) && raw.ball.positioned === undefined) {
          const { x, y } = raw.ball
          raw.ball.positioned = Number.isFinite(x) && Number.isFinite(y) && !(x === -1 && y === -1)
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
      const map = embeddedSecrets ?? (existsSync(this.legacySecretsFile)
        ? JSON.parse(readFileSync(this.legacySecretsFile, 'utf8')) as Record<string, unknown>
        : {})
      for (const p of SECRET_PATHS) {
        const enc = map[p]
        if (typeof enc !== 'string' || !enc) continue
        const value = this.decryptSecret(enc)
        if (value) setPath(this.data as unknown as Record<string, unknown>, p, value)
      }
      for (const server of this.data.mcp.servers) {
        const enc = map[mcpHeadersPath(server.id)]
        if (typeof enc === 'string' && enc) server.headers = this.decryptSecret(enc)
      }
    } catch (e) {
      log('settings: 密钥读取失败', e)
      return
    }
    if (embeddedSecrets === undefined && this.data.mcp.servers.some((server) => server.headers)) {
      try {
        this.save()
      } catch (e) {
        log('settings: MCP 凭据迁移失败，保留原设置文件', e)
      }
    }
  }

  private normalize(s: Settings): Settings {
    s.ball.size = clamp(s.ball.size, 64, 152, 96)
    s.ball.opacity = clamp(s.ball.opacity, 20, 100, 84)
    s.ball.positioned = s.ball.positioned === true && Number.isFinite(s.ball.x) && Number.isFinite(s.ball.y)
    s.ball.x = Number.isFinite(s.ball.x) ? Math.round(s.ball.x) : -1
    s.ball.y = Number.isFinite(s.ball.y) ? Math.round(s.ball.y) : -1
    // 旧的内置皮肤已被新皮肤替换：认不出的 builtin id 一律回落到默认皮肤
    if (s.ball.image?.startsWith('builtin:') && !BUILTIN_SKINS.some((k) => k.id === s.ball.image)) {
      s.ball.image = DEFAULT_SKIN
    }
    s.llm.temperature = clamp(s.llm.temperature, 0, 2, 0.8)
    // 上下文管理：旧的 historyTurns / summary 字段直接丢弃（v1.0.14 起改为预算制）
    const ctx = s.context ?? DEFAULT_SETTINGS.context
    const manualWindow = Math.floor(Number(ctx.modelWindow) || 0)
    s.context = {
      level: ctx.level === 'low' || ctx.level === 'high' ? ctx.level : 'mid',
      // 0 = 自动识别；小于 8k 的值当没填（否则预算会被压到不可用）
      modelWindow: manualWindow >= 8000 ? Math.min(manualWindow, 2000000) : 0,
      timeAwareness:
        ctx.timeAwareness === 'off' || ctx.timeAwareness === 'full' ? ctx.timeAwareness : 'current',
      keepRecentTurns: clamp(Number(ctx.keepRecentTurns) || 4, 1, 12, 4)
    }
    // 老配置里的两个字段没有用了：清掉，避免继续落盘
    delete (s.llm as unknown as Record<string, unknown>).historyTurns
    delete (s.llm as unknown as Record<string, unknown>).summary
    s.tts.speed = clamp(s.tts.speed, -50, 100, 0)
    s.tts.loudness = clamp(s.tts.loudness, -50, 100, 0)
    s.tts.volume = clamp(s.tts.volume, 0, 1, 0.9)
    if (s.tts.provider !== 'breeze' && s.tts.provider !== 'gpt-sovits') s.tts.provider = 'volc'
    s.dsh = {
      enabled: s.dsh?.enabled === true,
      sessionId: typeof s.dsh?.sessionId === 'string' ? s.dsh.sessionId.trim().slice(0, 256) : ''
    }
    const sovits = s.tts.gptSovits
    const sovitsDefaults = DEFAULT_SETTINGS.tts.gptSovits
    s.tts.gptSovits = {
      baseUrl: typeof sovits?.baseUrl === 'string' ? sovits.baseUrl : sovitsDefaults.baseUrl,
      refAudioPath: typeof sovits?.refAudioPath === 'string' ? sovits.refAudioPath : '',
      promptText: typeof sovits?.promptText === 'string' ? sovits.promptText : '',
      promptLang: typeof sovits?.promptLang === 'string' ? sovits.promptLang : sovitsDefaults.promptLang,
      textLang: typeof sovits?.textLang === 'string' ? sovits.textLang : sovitsDefaults.textLang
    }
    s.tts.breeze.modelId = (s.tts.breeze.modelId || '').trim() || 'breeze-tts-2'
    s.tts.breeze.voiceId = (s.tts.breeze.voiceId || '').trim()
    const lang = (s.tts.breeze.language || '').trim()
    s.tts.breeze.language = /^[A-Za-z]{2}$/.test(lang) ? lang.toLowerCase() : ''
    s.bubble.holdMs = clamp(s.bubble.holdMs, 0, 60000, 6000)
    s.voice.minHoldMs = clamp(s.voice.minHoldMs, 100, 3000, 250)
    if (!s.llm.systemPrompt?.trim()) s.llm.systemPrompt = DEFAULT_SETTINGS.llm.systemPrompt
    // 思考模式（老配置没有这个字段）
    const think = s.llm.thinking ?? DEFAULT_SETTINGS.llm.thinking
    s.llm.thinking = {
      enabled: Boolean(think.enabled),
      effort: think.effort === 'low' || think.effort === 'high' ? think.effort : 'medium'
    }
    // 联网搜索
    if (s.search.provider !== 'deepseek') s.search.provider = 'tavily'
    s.search.maxResults = clamp(s.search.maxResults, 1, 10, 5)
    s.search.tavilyBaseUrl = (s.search.tavilyBaseUrl || '').trim() || 'https://api.tavily.com'
    s.search.deepseekBaseUrl = (s.search.deepseekBaseUrl || '').trim() || 'https://api.deepseek.com'
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
    // 老配置没有这个字段：按默认值视为开启
    s.ui.autoLaunch = s.ui.autoLaunch === undefined ? true : Boolean(s.ui.autoLaunch)
    // 提示词兜底（老配置没有这些字段）
    const prompts = s.prompts ?? DEFAULT_SETTINGS.prompts
    s.prompts = {
      agent: (prompts.agent ?? '')
        .replace(/(?:最多|至多|不超过)\s*\{\{max_steps\}\}\s*(?:步|次|轮)/g, '按任务需要调用工具')
        .replaceAll('{{max_steps}}', '不限')
        .trim() || DEFAULT_SETTINGS.prompts.agent,
      closing: (prompts.closing ?? '').trim() || DEFAULT_SETTINGS.prompts.closing,
      summary: (prompts.summary ?? '').trim() || DEFAULT_SETTINGS.prompts.summary,
      visionNote: (prompts.visionNote ?? '').trim() || DEFAULT_SETTINGS.prompts.visionNote
    }

    // Agent 配置兜底（老配置没有这个字段时用默认值）
    const agent = s.agent ?? DEFAULT_SETTINGS.agent
    s.agent = {
      enabled: Boolean(agent.enabled),
      shellEnabled: Boolean(agent.shellEnabled),
      stepTimeoutMs: clamp(Number(agent.stepTimeoutMs) || 20000, 5000, 120000, 20000),
      audit: agent.audit !== false,
      auditDetail: agent.auditDetail === true,
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

  mcpServers(): Settings['mcp']['servers'] {
    this.init()
    return clone(this.data.mcp.servers)
  }

  publicMcpServers(): Settings['mcp']['servers'] {
    return this.mcpServers().map((server) => ({
      ...server,
      headersConfigured: Boolean(server.headers),
      headers: ''
    }))
  }

  public(): PublicSettings {
    const s = clone(this.data)
    const secretSet = {} as Record<SecretPath, boolean>
    for (const p of SECRET_PATHS) {
      secretSet[p] = Boolean(getPath(s, p))
      setPath(s as unknown as Record<string, unknown>, p, '')
    }
    for (const server of s.mcp.servers) {
      server.headersConfigured = Boolean(server.headers)
      server.headers = ''
    }
    return { ...s, secretSet }
  }

  /** 设置页"显示"按钮用：按需取回明文（仅本机 IPC，不外传） */
  reveal(path: SecretPath): string {
    this.init()
    if (path.startsWith('mcp.')) {
      const match = /^mcp\.([\w.-]+)\.headers$/.exec(path)
      return match ? this.data.mcp.servers.find((server) => server.id === match[1])?.headers ?? '' : ''
    }
    if (!SECRET_PATHS.includes(path)) return ''
    return getPath(this.data, path) || ''
  }

  update(patch: SettingsPatch): PublicSettings {
    this.init()
    const { clearSecrets, ...rest } = patch as SettingsPatch & { clearSecrets?: SecretPath[] }
    const cur = clone(this.data)
    const merged = deepMerge(cur, rest) as Settings
    for (const server of merged.mcp.servers) {
      const previous = cur.mcp.servers.find((item) => item.id === server.id)
      if (server.headers === '' && previous?.headers) server.headers = previous.headers
    }

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
        else if (p.startsWith('mcp.')) {
          const match = /^mcp\.([\w.-]+)\.headers$/.exec(p)
          const server = match && merged.mcp.servers.find((item) => item.id === match[1])
          if (server) server.headers = ''
        }
      }
    }

    // 改名时同步替换提示词里的旧名字，保证 AI 知道自己叫什么
    const oldName = (this.data.ui.assistantName || '').trim()
    const newName = (merged.ui.assistantName || '').trim()
    if (oldName && newName && oldName !== newName && merged.llm.systemPrompt.includes(oldName)) {
      merged.llm.systemPrompt = merged.llm.systemPrompt.split(oldName).join(newName)
    }

    this.data = this.normalize(merged)
    try {
      this.save()
    } catch (e) {
      this.data = cur
      throw e
    }
    return this.public()
  }

  reset(): PublicSettings {
    this.init()
    const secrets = SECRET_PATHS.map((p) => ({ p, v: getPath(this.data, p) }))
    const previous = this.data
    this.data = clone(DEFAULT_SETTINGS)
    for (const { p, v } of secrets) setPath(this.data as unknown as Record<string, unknown>, p, v)
    try {
      this.save()
    } catch (e) {
      this.data = previous
      throw e
    }
    return this.public()
  }

  save(): void {
    if (!this.initialized && this.dir) {
      this.writeSettings()
      return
    }
    this.init()
    this.writeSettings()
  }

  private writeSettings(): void {
    const onDisk = clone(this.data)
    for (const p of SECRET_PATHS) setPath(onDisk as unknown as Record<string, unknown>, p, '')
    for (const server of onDisk.mcp.servers) {
      server.headersConfigured = Boolean(server.headers)
      server.headers = ''
    }
    // 同一次原子替换发布脱敏设置与 DPAPI 密文，重启也只能读到同一代的地址和凭据。
    const payload = JSON.stringify({ ...onDisk, encryptedSecrets: this.encryptSecrets() }, null, 2)
    mkdirSync(dirname(this.settingsFile), { recursive: true })
    const tmp = `${this.settingsFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, payload, { encoding: 'utf8', flag: 'wx', flush: true })
      renameSync(tmp, this.settingsFile)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* 保留原始保存错误 */ }
      throw error
    }
    // 提交后才清理旧副本。即使删除失败，加载也优先使用新文件的密文（包括空对象）。
    try { unlinkSync(this.legacySecretsFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('settings: 清理旧密钥文件失败', error)
    }
  }

  private encryptSecret(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统加密不可用，拒绝以可逆 Base64 明文保存凭据')
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  private decryptSecret(value: string): string {
    if (value.startsWith('plain:')) {
      log('settings: 检测到旧版未加密凭据，保留在内存中并在下次成功保存时迁移')
      return Buffer.from(value.slice(6), 'base64').toString('utf8')
    }
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private encryptSecrets(): Record<string, string> {
    const map: Record<string, string> = {}
    for (const p of SECRET_PATHS) {
      const v = getPath(this.data, p)
      if (v) map[p] = this.encryptSecret(v)
    }
    for (const server of this.data.mcp.servers) {
      if (server.headers) map[mcpHeadersPath(server.id)] = this.encryptSecret(server.headers)
    }
    return map
  }

  dataDir(): string {
    this.init()
    return this.dir
  }
}

export const settingsStore = new SettingsStore()
