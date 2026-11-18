// 测试用的假 MCP 服务器（stdio，换行分隔 JSON-RPC）
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' }
      }
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '回显传入的文本',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text']
            }
          }
        ]
      }
    })
    return
  }
  if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `MCP echo: ${msg.params?.arguments?.text ?? ''}` }]
      }
    })
  }
})
