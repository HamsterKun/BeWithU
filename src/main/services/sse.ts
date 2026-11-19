/**
 * SSE 行切分：把带块边界的字节流切成"完整的一行"，并且**流结束时把残余缓冲也吐出来**。
 *
 * 原来的 llm/tts 解析都在循环里 `buffer.split('\n')`、`pop()` 留尾巴，循环结束就丢了最后一段；
 * 服务端如果最后一条 `data:` 之后没有换行，回答/音频的尾段会被吞掉（REVIEW C8）。
 * 这里单独抽出来，顺带处理 CRLF / 单独 CR（SSE 规范三种换行都合法）和被切在两块之间的 `\r`。
 */

/** 把一段缓冲切成完整行；返回没构成完整行的尾巴 */
export function splitSseLines(buffer: string): { lines: string[]; rest: string } {
  let rest = buffer
  let carry = ''
  // 结尾的 \r 可能是下一块开头 \n 的前半截，先留到下次
  if (rest.endsWith('\r')) {
    carry = '\r'
    rest = rest.slice(0, -1)
  }
  const parts = rest.split(/\r\n|\n|\r/)
  const last = parts.pop() ?? ''
  return { lines: parts, rest: last + carry }
}

/** 逐行读 SSE 文本流（包含流结束时没有换行符的最后一行） */
export async function* sseLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const { lines, rest } = splitSseLines(buffer)
    buffer = rest
    for (const line of lines) yield line
  }
  buffer += decoder.decode()
  if (buffer.length) {
    // 结束时仍有残余：不管有没有换行，都当成最后一行交出去
    const { lines } = splitSseLines(`${buffer}\n`)
    for (const line of lines) yield line
  }
}

/** 从 `data:` 行里取负载；不是数据行返回 null */
export function sseData(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return null
  if (!trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}
