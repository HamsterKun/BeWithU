/**
 * 本地敏感 JSON 的落盘封装（对话历史、长期记忆）。
 *
 * 评审 B4：历史与记忆原来明文写在 userData 里。现在优先用系统加密（Windows DPAPI / safeStorage），
 * 文件格式是一行 `BWU1:` + base64(密文)，旧明文文件仍能正常读（下次保存时自动变成密文）。
 * 系统加密不可用时退回明文并记日志，设置页会提示。
 */
import { readFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { log } from '../logger'

const PREFIX = 'BWU1:'

export function secureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 序列化成待写入文本：能加密就加密，不能就退回明文 */
export function encodeSecureJson(value: unknown): string {
  const json = JSON.stringify(value)
  if (secureStorageAvailable()) {
    try {
      return `${PREFIX}${safeStorage.encryptString(json).toString('base64')}`
    } catch (e) {
      log('secure-json: 加密失败，退回明文保存', e)
    }
  }
  return json
}

/** 读取：兼容加密与旧明文；文件不存在或解不开时返回 null（调用方按空数据） */
export function readSecureJson(file: string): unknown | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('secure-json: 读取失败', e)
    return null
  }
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith(PREFIX)) {
    if (!secureStorageAvailable()) {
      log('secure-json: 系统加密不可用，读不了加密数据')
      return null
    }
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(trimmed.slice(PREFIX.length), 'base64')))
    } catch (e) {
      log('secure-json: 解密失败（换机器或系统账户变了？）', e)
      return null
    }
  }
  try {
    return JSON.parse(trimmed)
  } catch (e) {
    log('secure-json: 解析失败', e)
    return null
  }
}
