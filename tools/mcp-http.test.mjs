import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../logger') return { shortCircuit: true, url: 'data:text/javascript,export const log = () => {}' }
    if (specifier === '../services/sse') return next(`${specifier}.ts`, context)
    return next(specifier, context)
  }
})

const { mcpCallTool, mcpListTools, disconnectAllMcp } = await import('../src/main/agent/mcp.ts')
const server = { id: 'fixture', transport: 'http', enabled: true, name: 'Fixture', url: 'https://fixture.invalid', headers: '' }
const tools = [{ name: 'example', description: 'Example', inputSchema: { type: 'object' } }]
const reply = (id, result, headers) => Response.json({ jsonrpc: '2.0', id, result }, { headers })

test('HTTP SSE handles multiline events and split CRLF, preserving JSON-RPC response matching', async (t) => {
  t.after(disconnectAllMcp)
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { id, method } = JSON.parse(request.body)
    const result = method === 'initialize' ? {} : { tools }
    const chunks = [': heartbeat\r', '\n\r\ndata: {"id":999,"result":null}\r\n\r\nevent: message\r',
      `\ndata: {"jsonrpc":"2.0","id":${id},\r\ndata: "result":${JSON.stringify(result)}}\r\n\r`, '\n']
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      }
    }), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  assert.deepEqual(await mcpListTools(server), tools)
})

test('HTTP initialization forwards the session and negotiated version to notifications and tool requests', async (t) => {
  t.after(disconnectAllMcp)
  const version = '2025-06-18'
  const methods = []
  let sessionCount = 0
  let expired = false
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { id, method } = JSON.parse(request.body)
    const headers = new Headers(request.headers)
    methods.push(method)
    if (method === 'initialize') {
      assert.equal(headers.get('Mcp-Session-Id'), null)
      sessionCount++
      return reply(id, { protocolVersion: version }, { 'Mcp-Session-Id': `fixture-${sessionCount}` })
    }
    assert.equal(headers.get('Mcp-Session-Id'), `fixture-${sessionCount}`)
    assert.equal(headers.get('MCP-Protocol-Version'), version)
    if (method === 'notifications/initialized') {
      assert.equal(id, undefined)
      return new Response(null, { status: 202 })
    }
    if (expired) return new Response(null, { status: 404 })
    return method === 'tools/list' ? reply(id, { tools }) : reply(id, { content: [{ text: 'fixture result' }] })
  })
  assert.deepEqual(await mcpListTools(server), tools)
  assert.deepEqual(await mcpCallTool(server, 'example', {}), { ok: true, summary: 'fixture result' })
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])

  expired = true
  await assert.rejects(mcpListTools(server), /HTTP 404/)
  expired = false
  assert.deepEqual(await mcpListTools(server), tools)
  assert.equal(sessionCount, 2)
})
