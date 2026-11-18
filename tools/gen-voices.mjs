// 生成内置音色目录：抓取公开镜像的音色表，转成 src/shared/voices.ts
// 只在需要更新音色库时手动运行：node tools/gen-voices.mjs
import { writeFileSync } from 'node:fs'

const SOURCE =
  'https://raw.githubusercontent.com/franklu0819-lang/agent-skills/main/ark-skills/ark-tts/references/voices.md'

const text = await (await fetch(SOURCE)).text()
const lines = text.split('\n')

/** 火山官方音色的 Resource ID 推断（见音色表说明） */
function resourceOf(id) {
  if (id.startsWith('S_')) return 'seed-icl-2.0'
  if (id.includes('uranus')) return 'seed-tts-2.0'
  return 'volc.service_type.10029'
}

function tagOf(id) {
  if (id.startsWith('ICL') || id.startsWith('S_')) return 'ICL'
  if (id.includes('uranus')) return '2.0'
  if (id.startsWith('BV')) return 'BV'
  return '1.0'
}

const map = new Map()
for (const raw of lines) {
  const line = raw.trim()
  if (!line.startsWith('|')) continue
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
  if (cells.length < 3) continue
  const [group, name, id] = cells
  if (!id || id === 'voice_type' || /^-+$/.test(id)) continue
  if (!/^[A-Za-z0-9_]/.test(id)) continue
  if (map.has(id)) continue
  map.set(id, { id, name: name || id, group: group || '通用', tag: tagOf(id), resourceId: resourceOf(id) })
}

// BV 系走 v1 引擎，当前 App 不支持，直接排除
const list = [...map.values()].filter((v) => v.tag !== 'BV')

const header = `/* 由 tools/gen-voices.mjs 生成，请勿手改。
 * 来源：火山官方「大模型音色列表」的公开镜像整理（${new Date().toISOString().slice(0, 10)}）
 * 官方实时列表接口需要火山 OpenAPI 的 AK/SK 签名，AppID/Token 无法直接调用，
 * 因此这里内置一份常用音色目录，同时允许用户直接粘贴任意 voice id。 */

export interface VoiceEntry {
  id: string
  name: string
  group: string
  tag: '2.0' | '1.0' | 'ICL'
  /** 该音色对应的资源 ID，选中时自动填好 */
  resourceId: string
}

export const VOICE_CATALOG: VoiceEntry[] = `

writeFileSync('src/shared/voices.ts', header + JSON.stringify(list, null, 2) + '\n', 'utf8')

const counts = list.reduce((acc, v) => ((acc[v.tag] = (acc[v.tag] ?? 0) + 1), acc), {})
console.log('生成', list.length, '个音色', counts)
