/** 运行形态判断：便携版每次运行都解压到临时目录，很多能力用不了 */

/** electron-builder 的 portable 目标会注入这两个环境变量 */
export function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE)
}
