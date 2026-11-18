/** 命令/操作的安全策略 */

/** 极高危命令特征：即使开了完全信任也一律拦截 */
const HARD_BLOCK: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\*|[A-Za-z]:\\)/i, why: '递归删除根目录/整盘' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区工具' },
  { re: /\bbcdedit\b/i, why: '修改启动配置' },
  { re: /\breg\s+delete\s+HK(LM|CR|U)\b/i, why: '删除系统注册表项' },
  { re: /\bRemove-Item\b[^\n]*\b-C:\\(Windows|Program Files|ProgramData)/i, why: '删除系统目录' },
  { re: /\b(RD|RMDIR)\s+\/s\s+\/q\s+[A-Za-z]:\\?\s*$/i, why: '删除整盘' },
  { re: /\bshutdown\b.*(-s|-r|-t\s+0)/i, why: '关机/重启' },
  { re: /\bStop-Computer\b|\bRestart-Computer\b/i, why: '关机/重启' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork 炸弹' }
]

export interface CommandCheck {
  ok: boolean
  reason?: string
}

/** 检查一段将要执行的内容（shell 脚本 / 文件写入路径）是否触碰红线 */
export function checkDangerous(text: string): CommandCheck {
  const t = String(text ?? '')
  for (const rule of HARD_BLOCK) {
    if (rule.re.test(t)) return { ok: false, reason: `检测到极高危操作（${rule.why}），已拒绝执行` }
  }
  return { ok: true }
}
