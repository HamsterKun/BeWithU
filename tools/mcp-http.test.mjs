import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../logger') return { shortCircuit: true, url: 'data:text/javascript,export const log = () => {}' }
    if (specifier === '../services/sse' || specifier === './cancellation') return next(`${specifier}.ts`, context)
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

test('lists every cursor and preserves structured returns and supported images', async (t) => {
  t.after(disconnectAllMcp)
  const cursors = []
  const image = Buffer.from('fixture image').toString('base64')
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { id, method, params } = JSON.parse(request.body)
    if (method === 'initialize') return reply(id, {})
    if (method === 'tools/list') {
      cursors.push(params.cursor)
      return reply(id, params.cursor === undefined
        ? { tools, nextCursor: 'opaque page 2' }
        : { tools: [...tools, { ...tools[0], name: 'other/tool' }] })
    }
    return reply(id, {
      structuredContent: { status: 'ready', count: 42 },
      content: [{ type: 'text', text: 'fixture text' }, { type: 'image', mimeType: 'image/png', data: image }]
    })
  })
  assert.deepEqual((await mcpListTools(server)).map((tool) => tool.name), ['example', 'other/tool'])
  assert.deepEqual(cursors, [undefined, 'opaque page 2'])
  const result = await mcpCallTool(server, 'other/tool', {})
  assert.deepEqual(result.data.structuredContent, { status: 'ready', count: 42 })
  assert.deepEqual(result.images, [{ dataUrl: 'data:image/png;base64,' + image }])
  assert.ok(!JSON.stringify(result.data).includes(image))
})

test('aborts an active request and sends MCP cancellation without closing the shared session', async (t) => {
  t.after(disconnectAllMcp)
  const controller = new AbortController()
  const cancelled = Promise.withResolvers()
  const started = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { id, method, params } = JSON.parse(request.body)
    if (method === 'initialize') return reply(id, {}, { 'Mcp-Session-Id': 'test' })
    if (method === 'tools/call') {
      started.resolve(id)
      return new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
    if (method === 'tools/list') return reply(id, { tools })
    if (method === 'notifications/cancelled') cancelled.resolve(params.requestId)
    return new Response(null, { status: 202 })
  })
  const result = mcpCallTool(server, 'example', {}, controller.signal)
  const requestId = await started.promise
  controller.abort(new Error('stopped fixture'))
  await assert.rejects(result, /stopped fixture/)
  assert.equal(await cancelled.promise, requestId)
  assert.deepEqual(await mcpListTools(server), tools)
})

test('stdio sends the cancelled request ID and can still use the worker', { timeout: 8000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bwu-mcp-stdio-'))
  const file = join(root, 'server.mjs')
  writeFileSync(file, `
    import { createInterface } from 'node:readline';
    let pending;
    let cancelled;
    const send = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
    for await (const line of createInterface({input: process.stdin})) {
      const {id, method, params} = JSON.parse(line);
      if (method === 'initialize') send(id, {});
      if (method === 'tools/call' && params.name === 'hold') pending = id;
      if (method === 'notifications/cancelled') cancelled = params.requestId === pending;
      if (method === 'tools/list') send(id, {tools: [{name: cancelled ? 'cancelled' : 'not_cancelled'}]});
    }
  `)
  t.after(() => {
    disconnectAllMcp()
    rmSync(root, { recursive: true, force: true })
  })
  const stdio = { ...server, id: 'stdio', transport: 'stdio', command: process.execPath, args: `"${file}"` }
  await mcpListTools(stdio)
  const controller = new AbortController()
  const pending = mcpCallTool(stdio, 'hold', {}, controller.signal)
  await new Promise(setImmediate)
  controller.abort(new Error('stopped stdio'))
  await assert.rejects(pending, /stopped stdio/)
  assert.equal((await mcpListTools(stdio))[0].name, 'cancelled')
})
