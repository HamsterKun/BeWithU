/**
 * Skill：一段「什么时候用 + 具体怎么做」的说明文档，渐进披露。
 *
 * 常驻上下文只放 name/description/whenToUse，模型需要时再调 skill.read 取全文。
 * 目录：<userData>/agent/skills/<id>/SKILL.md
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { log } from '../logger'
import { extractZip } from './import-archive'

export interface SkillInfo {
  id: string
  name: string
  description: string
  whenToUse: string
  path: string
  chars: number
}

export function skillsDir(): string {
  return join(app.getPath('userData'), 'agent', 'skills')
}

export function ensureSkillsDir(): string {
  const dir = skillsDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 只解析最简单的 frontmatter：`key: value` 一行一个，够用且不怕用户写坏 YAML */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/^\uFEFF/, '')
  if (!src.startsWith('---')) return { meta: {}, body: src }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: src }
  const head = src.slice(3, end)
  const body = src.slice(end + 4).replace(/^\r?\n/, '')
  const meta: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[m[1]] = value
  }
  return { meta, body }
}

function readSkillFile(id: string): SkillInfo | null {
  const file = join(skillsDir(), id, 'SKILL.md')
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8')
    const { meta, body } = parseFrontmatter(text)
    return {
      id,
      name: meta.name?.trim() || id,
      description: meta.description?.trim() || '',
      whenToUse: meta.whenToUse?.trim() || meta['when-to-use']?.trim() || '',
      path: file,
      chars: body.trim().length
    }
  } catch (e) {
    log('skill: 读取失败', id, e instanceof Error ? e.message : e)
    return null
  }
}

export function scanSkills(): SkillInfo[] {
  const dir = ensureSkillsDir()
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSkillFile(e.name))
      .filter((s): s is SkillInfo => Boolean(s))
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch (e) {
    log('skill: 扫描失败', e)
    return []
  }
}

export function findSkill(idOrName: string): SkillInfo | null {
  const key = idOrName.trim()
  if (!key) return null
  const all = scanSkills()
  return (
    all.find((s) => s.id === key) ??
    all.find((s) => s.name === key) ??
    all.find((s) => s.name.toLowerCase() === key.toLowerCase()) ??
    null
  )
}

export function readSkillBody(idOrName: string): { info: SkillInfo; body: string } | null {
  const info = findSkill(idOrName)
  if (!info) return null
  try {
    const text = readFileSync(info.path, 'utf8').replace(/^\uFEFF/, '')
    const { body } = parseFrontmatter(text)
    return { info, body: body.trim() }
  } catch {
    return null
  }
}

/** 从任意目录导入（要求该目录里有 SKILL.md） */
export function importSkill(srcDir: string): SkillInfo {
  const src = join(srcDir, 'SKILL.md')
  if (!existsSync(src)) throw new Error('这个目录里没有 SKILL.md')
  const text = readFileSync(src, 'utf8')
  const { meta } = parseFrontmatter(text)
  if (!meta.name) throw new Error('SKILL.md 的 frontmatter 缺少 name')
  const rawId = basename(srcDir).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
  let id = rawId
  let n = 2
  while (existsSync(join(skillsDir(), id))) {
    id = `${rawId}-${n++}`
  }
  const destDir = join(skillsDir(), id)
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, join(destDir, 'SKILL.md'))
  // 顺带把同目录下的附件（模板、示例）一起搬，方便 Skill 引用
  for (const entry of readdirSync(srcDir)) {
    const from = join(srcDir, entry)
    if (entry === 'SKILL.md') continue
    try {
      if (statSync(from).isFile()) copyFileSync(from, join(destDir, entry))
    } catch {
      /* ignore */
    }
  }
  const info = readSkillFile(id)
  if (!info) throw new Error('导入后解析失败')
  log('skill: 已导入', id)
  return info
}

/** 从 zip 导入 Skill */
export async function importSkillArchive(zipPath: string): Promise<SkillInfo> {
  const { dir, cleanup } = await extractZip(zipPath)
  try {
    return importSkill(dir)
  } finally {
    cleanup()
  }
}

export function deleteSkill(id: string): void {
  const dir = join(skillsDir(), id)
  if (!dir.startsWith(skillsDir())) return
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  log('skill: 已删除', id)
}

/** 注入系统提示词的摘要（只有 name / description / whenToUse） */
export function skillsPromptSection(): string {
  const all = scanSkills()
  if (!all.length) return ''
  const lines = all.map((s) => {
    const parts = [`- ${s.name}`]
    if (s.description) parts.push(`：${s.description}`)
    if (s.whenToUse) parts.push(`（适用于：${s.whenToUse}）`)
    return parts.join('')
  })
  return [
    '【可用技能】需要时用 skill.read 读取全文，再按里面的步骤执行：',
    ...lines
  ].join('\n')
}

/** 生成一份示例 Skill，便于用户在设置页“打开目录”后照着写 */
export function writeSkillTemplate(): string {
  const dir = ensureSkillsDir()
  const example = join(dir, '_example', 'SKILL.md')
  mkdirSync(join(dir, '_example'), { recursive: true })
  if (!existsSync(example)) {
    writeFileSync(
      example,
      [
        '---',
        'name: 示例技能',
        'description: 一句话说明这个技能能做什么',
        'whenToUse: 用户提到 XXX 时',
        '---',
        '',
        '# 步骤',
        '',
        '1. 先确认……',
        '2. 再调用……',
        '3. 最后汇报……',
        ''
      ].join('\n'),
      'utf8'
    )
  }
  return dir
}
