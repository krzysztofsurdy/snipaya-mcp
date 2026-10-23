import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBridge, type Bridge, type BridgeOptions } from '../src/bridge.js'
import { loadCatalog, packageVersion } from '../src/catalog.js'
import { startTestServer, unusedPort, type TestServer } from './fixtures/server.js'

const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const TOKEN = 'a'.repeat(64)
const catalog = loadCatalog()

let server: TestServer
let stderr: string
let home: string
const clients: Client[] = []

beforeEach(async () => {
  server = await startTestServer(TOKEN)
  stderr = ''
  home = mkdtempSync(join(tmpdir(), 'snipaya-home-'))
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await server.close()
  rmSync(home, { recursive: true, force: true })
})

const isolated = (env: Record<string, string>): Record<string, string> => ({
  HOME: home,
  SNIPAYA_MCP_NO_LAUNCH: '1',
  ...env
})

const saveUserData = (file: string, content: Record<string, unknown>): void => {
  const dir = join(home, 'Library', 'Application Support', 'Snipaya')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(content), { mode: 0o600 })
}

const saveSettings = (settings: Record<string, unknown>): void => saveUserData('mcp.json', settings)

const serverPort = (): number => Number(new URL(server.url).port)

const textOf = (result: unknown): string =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((item) => item.text ?? '').join('\n')

const connectBridged = async (env?: Record<string, string>, args: string[] = []): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, ...args],
    env: isolated(env ?? { SNIPAYA_MCP_URL: server.url, SNIPAYA_MCP_TOKEN: TOKEN }),
    stderr: 'pipe'
  })
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const client = new Client(
    { name: 'bridge-test', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } }
  )
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: 'file:///tmp/snipaya', name: 'snipaya' }]
  }))
  clients.push(client)
  await client.connect(transport)
  return client
}

const connectDirect = async (): Promise<Client> => {
  const client = new Client({ name: 'direct-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    })
  )
  return client
}

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const run = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [BIN, ...args], {
    env: isolated({ PATH: process.env.PATH ?? '', ...env }),
    input: '',
    encoding: 'utf8',
    timeout: 10000
  })

describe('pass-through', () => {
  it('lists tools exactly as the server does', async () => {
    const direct = await connectDirect()
    const client = await connectBridged()
    expect(await client.listTools()).toEqual(await direct.listTools())
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'echo',
      'log',
      'roots',
      'announce',
      'boom'
    ])
  })

  it('calls tools and returns their results unchanged', async () => {
    const client = await connectBridged()
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi there' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi there' }] })
  })

  it('passes tool errors and protocol errors through unchanged', async () => {
    const direct = await connectDirect()
    const client = await connectBridged()
    expect(await client.callTool({ name: 'boom' })).toEqual(await direct.callTool({ name: 'boom' }))

    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ value }),
        (error: { code?: number; message?: string }) => ({ code: error.code, message: error.message })
      )
    const viaBridge = await outcome(client.callTool({ name: 'missing' }))
    const viaDirect = await outcome(direct.callTool({ name: 'missing' }))
    expect(viaBridge).toEqual(viaDirect)
  })

  it('forwards server notifications to the client', async () => {
    const client = await connectBridged()
    const logs: unknown[] = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      logs.push(notification.params.data)
    })
    await client.callTool({ name: 'log' })
    await until(() => logs.length === 1)
    expect(logs).toEqual(['hello from the server'])
  })

  it('forwards notifications from the standalone server stream', async () => {
    const client = await connectBridged()
    let changes = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changes += 1
    })
    await until(() => server.streams === 1)
    await client.callTool({ name: 'announce' })
    await until(() => changes === 1)
  })

  it('forwards client notifications to the server', async () => {
    const client = await connectBridged()
    await client.sendRootsListChanged()
    await until(() => server.rootsChanged === 1)
  })

  it('forwards server requests to the client and the answers back', async () => {
    const client = await connectBridged()
    const result = await client.callTool({ name: 'roots' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'file:///tmp/snipaya' }] })
  })

  it('reads the token and port that Snipaya saved', async () => {
    saveSettings({ enabled: true, token: TOKEN, port: serverPort() })
    const client = await connectBridged({})
    expect((await client.listTools()).tools).toHaveLength(5)
    expect(server.authorizations.every((value) => value === `Bearer ${TOKEN}`)).toBe(true)
    expect(stderr).not.toContain(TOKEN)
  })

  it('accepts the url and token as flags', async () => {
    const client = await connectBridged({}, ['--url', server.url, '--token', TOKEN])
    expect((await client.listTools()).tools).toHaveLength(5)
  })
})

describe('requests', () => {
  it('never sends an Origin header', async () => {
    const client = await connectBridged()
    await client.listTools()
    await client.callTool({ name: 'log' })
    expect(server.origins.length).toBeGreaterThan(2)
    expect(server.origins.every((origin) => origin === undefined)).toBe(true)
  })

  it('sends the token as a Bearer header', async () => {
    const client = await connectBridged()
    await client.listTools()
    expect(server.authorizations.every((value) => value === `Bearer ${TOKEN}`)).toBe(true)
  })
})

describe('errors', () => {
  it('explains a wrong token without a stack trace or the token', async () => {
    const wrong = 'b'.repeat(64)
    await expect(
      connectBridged({ SNIPAYA_MCP_URL: server.url, SNIPAYA_MCP_TOKEN: wrong })
    ).rejects.toThrow(
      /rejected the token\. Remove SNIPAYA_MCP_TOKEN to use the token Snipaya saved, or copy the current one from Snipaya > Settings > AI Assistants\./
    )
    expect(stderr).toMatch(/rejected the token/)
    expect(stderr).not.toMatch(/\n\s+at /)
    expect(stderr).not.toContain(wrong)
  })

  it('lists the catalog and explains tool calls when Snipaya is not reachable', async () => {
    const url = `http://127.0.0.1:${await unusedPort()}/mcp`
    const client = await connectBridged({ SNIPAYA_MCP_URL: url, SNIPAYA_MCP_TOKEN: TOKEN })
    expect((await client.listTools()).tools).toEqual(catalog.tools)
    const result = await client.callTool({ name: 'snipaya_get_canvas', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(
      /^Cannot reach Snipaya at .*\. Is Snipaya open\? Turn on the MCP server in Snipaya > Settings > AI Assistants/
    )
    expect(stderr).toMatch(/Cannot reach Snipaya/)
    expect(stderr).not.toMatch(/license agreement/)
    expect(stderr).not.toMatch(/\n\s+at /)
    expect(stderr).not.toContain(TOKEN)
  })

  it('asks to accept the license agreement when the saved server does not answer', async () => {
    saveSettings({ enabled: true, token: TOKEN, port: await unusedPort() })
    const pending =
      /Cannot reach Snipaya at http:\/\/127\.0\.0\.1:\d+\/mcp\. Its MCP server starts only after you accept the license agreement: open Snipaya and accept it, then call the tool again\. If Snipaya shows no agreement, turn on the MCP server in Snipaya > Settings > AI Assistants\./
    const client = await connectBridged({ PATH: home })
    expect(textOf(await client.callTool({ name: 'snipaya_render', arguments: {} }))).toMatch(pending)
    expect(stderr).toMatch(pending)
    expect(stderr).not.toMatch(/Is Snipaya open\?/)
    expect(stderr).not.toContain(TOKEN)
  })

  it('keeps the usual message when the license agreement was accepted', async () => {
    saveSettings({ enabled: true, token: TOKEN, port: await unusedPort() })
    saveUserData('eula.json', { version: '1.0', acceptedAt: 1_760_000_000_000 })
    const client = await connectBridged({ PATH: home })
    expect(textOf(await client.callTool({ name: 'snipaya_render', arguments: {} }))).toMatch(
      /Cannot reach Snipaya at .*\. Is Snipaya open\? Turn on the MCP server/
    )
    expect(stderr).not.toMatch(/license agreement/)
  })

  it.runIf(process.platform === 'darwin')(
    'tries to open Snipaya when its saved server is on but not running',
    async () => {
      saveSettings({ enabled: true, token: TOKEN, port: await unusedPort() })
      const client = await connectBridged({ SNIPAYA_MCP_NO_LAUNCH: '', PATH: home })
      const result = await client.callTool({ name: 'snipaya_render', arguments: {} })
      expect(textOf(result)).toMatch(/Cannot open Snipaya \(dev\.snipaya\.app\)\. Install it from https:\/\/snipaya\.app/)
      expect(stderr).toMatch(/Snipaya is not running\. Opening it in the background\./)
      expect(stderr).not.toContain(TOKEN)
    }
  )

  it('does not open Snipaya with SNIPAYA_MCP_NO_LAUNCH=1', async () => {
    saveSettings({ enabled: true, token: TOKEN, port: await unusedPort() })
    const client = await connectBridged({ SNIPAYA_MCP_NO_LAUNCH: '1', PATH: home })
    expect(textOf(await client.callTool({ name: 'snipaya_render', arguments: {} }))).toMatch(/Cannot reach Snipaya/)
    expect(stderr).not.toMatch(/Opening it/)
  })

  it('refuses a URL that is not on this machine', () => {
    for (const url of ['http://192.168.1.20:47321/mcp', 'http://localhost.example.com/mcp']) {
      const result = run(['--url', url], { SNIPAYA_MCP_TOKEN: TOKEN })
      expect(result.status).toBe(1)
      expect(result.stderr.trim().split('\n')).toHaveLength(1)
      expect(result.stderr).toMatch(/only connects to 127\.0\.0\.1 or localhost/)
      expect(result.stderr).not.toContain(TOKEN)
    }
  })

  it('explains that Snipaya was never set up when no token is set', async () => {
    const client = await connectBridged({})
    expect((await client.listTools()).tools).toHaveLength(28)
    const text = textOf(await client.callTool({ name: 'snipaya_render', arguments: {} }))
    if (process.platform === 'darwin') {
      expect(text).toMatch(/settings were not found.*Allow AI assistants.*SNIPAYA_MCP_TOKEN/)
    } else {
      expect(text).toBe(
        'Snipaya is a macOS app. Install it on a Mac from https://snipaya.app, open it and turn on Allow AI assistants in Snipaya > Settings > AI Assistants.'
      )
    }
    expect(stderr).toContain(text)
  })

  it('asks to turn the server on when Snipaya saved it as off', async () => {
    saveSettings({ enabled: false, token: TOKEN, port: serverPort() })
    const client = await connectBridged({})
    const text = textOf(await client.callTool({ name: 'snipaya_render', arguments: {} }))
    expect(text).toMatch(process.platform === 'darwin' ? /MCP server is off\. Turn on Allow AI assistants/ : /macOS app/)
    expect(stderr).not.toContain(TOKEN)
  })
})

describe('the binary without Snipaya', () => {
  it('serves the catalog prompts and instructions', async () => {
    const client = await connectBridged({})
    expect((await client.listPrompts()).prompts).toEqual(catalog.prompts)
    expect(client.getInstructions()).toBe(catalog.instructions)
    expect(client.getServerVersion()).toMatchObject({ name: 'snipaya', version: packageVersion() })
  })

  it('forwards once Snipaya is turned on', async () => {
    const client = await connectBridged({})
    expect((await client.callTool({ name: 'snipaya_render', arguments: {} })).isError).toBe(true)
    saveSettings({ enabled: true, token: TOKEN, port: serverPort() })
    const result = await client.callTool({ name: 'echo', arguments: { text: 'there you are' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'there you are' }] })
    expect(stderr).not.toContain(TOKEN)
  })
})

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: true } },
  clientInfo: { name: 'offline-test', version: '1.0.0' }
}

type Reply = { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string } }

const bridges: Bridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

const session = async (options: Partial<BridgeOptions>) => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const messages: Reply[] = []
  let buffered = ''
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') messages.push(JSON.parse(line) as Reply)
  })
  const bridge = await startBridge({
    connection: 'Snipaya is not set up.',
    catalog,
    version: '9.9.9',
    stdin,
    stdout,
    log: () => undefined,
    ...options
  })
  bridges.push(bridge)
  let nextId = 0
  const request = async (method: string, params?: Record<string, unknown>): Promise<Reply> => {
    nextId += 1
    const id = nextId
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
    await until(() => messages.some((message) => message.id === id && message.method === undefined))
    return messages.find((message) => message.id === id && message.method === undefined) as Reply
  }
  const notify = (method: string): void => {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }
  const start = async (): Promise<Reply> => {
    const reply = await request('initialize', INITIALIZE_PARAMS)
    notify('notifications/initialized')
    return reply
  }
  return { request, start, messages }
}

const callText = (reply: Reply): string =>
  ((reply.result?.content as { text: string }[] | undefined) ?? []).map((item) => item.text).join('\n')

describe('without Snipaya', () => {
  it('answers initialize and the lists from the catalog when Snipaya does not answer', async () => {
    const url = new URL(`http://127.0.0.1:${await unusedPort()}/mcp`)
    const { request, start } = await session({ connection: { url, token: TOKEN } })
    const init = await start()
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'snipaya', version: '9.9.9' },
      instructions: catalog.instructions
    })
    expect((await request('tools/list')).result).toEqual({ tools: catalog.tools })
    expect((await request('prompts/list')).result).toEqual({ prompts: catalog.prompts })
  })

  it('answers tool calls with what to do when Snipaya does not answer', async () => {
    const url = new URL(`http://127.0.0.1:${await unusedPort()}/mcp`)
    const { request, start } = await session({ connection: { url, token: TOKEN } })
    await start()
    const reply = await request('tools/call', { name: 'snipaya_get_canvas', arguments: {} })
    expect(reply.result?.isError).toBe(true)
    expect(callText(reply)).toMatch(/^Cannot reach Snipaya at http:\/\/127\.0\.0\.1:\d+\/mcp\. Is Snipaya open\?/)
    const prompt = await request('prompts/get', { name: 'explain_bug' })
    expect(prompt.error?.message).toMatch(/^Cannot reach Snipaya/)
  })

  it('answers tool calls with the reason it was given when there is nothing to connect to', async () => {
    const { request, start } = await session({ connection: 'Install Snipaya first.' })
    await start()
    const reply = await request('tools/call', { name: 'snipaya_render', arguments: {} })
    expect(reply.result).toEqual({ content: [{ type: 'text', text: 'Install Snipaya first.' }], isError: true })
  })

  it('logs why it answers from the catalog', async () => {
    const lines: string[] = []
    const { start } = await session({ connection: 'Install Snipaya first.', log: (line) => lines.push(line) })
    await start()
    expect(lines.join('\n')).toMatch(/Listing Snipaya's tools from the built-in catalog until Snipaya answers\./)
  })

  it('keeps the latest reason while Snipaya stays away', async () => {
    const reconnect = vi.fn(async () => 'Snipaya is still closed.')
    const { request, start } = await session({ connection: 'Install Snipaya first.', reconnect })
    await start()
    const reply = await request('tools/call', { name: 'snipaya_render', arguments: {} })
    expect(callText(reply)).toBe('Snipaya is still closed.')
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('uses the error as the reason when checking for Snipaya fails', async () => {
    const reconnect = vi.fn(async () => Promise.reject(new Error('Settings broke.')))
    const { request, start } = await session({ connection: 'Install Snipaya first.', reconnect })
    await start()
    expect(callText(await request('tools/call', { name: 'snipaya_render', arguments: {} }))).toBe('Settings broke.')
  })

  it('does not look for Snipaya to answer the lists', async () => {
    const reconnect = vi.fn(async () => 'closed')
    const { request, start } = await session({ connection: 'Install Snipaya first.', reconnect })
    await start()
    await request('tools/list')
    await request('prompts/list')
    expect(reconnect).not.toHaveBeenCalled()
  })
})

describe('when Snipaya starts answering later', () => {
  it('forwards the call that found it and every message after it', async () => {
    const reconnect = vi.fn(async () => ({ url: new URL(server.url), token: TOKEN }))
    const { request, start, messages } = await session({ connection: 'Install Snipaya first.', reconnect })
    await start()
    const reply = await request('tools/call', { name: 'echo', arguments: { text: 'found you' } })
    expect(reply.result).toEqual({ content: [{ type: 'text', text: 'found you' }] })
    expect(((await request('tools/list')).result?.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      'echo',
      'log',
      'roots',
      'announce',
      'boom'
    ])
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(messages.map((message) => message.method).filter(Boolean)).toEqual([
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed'
    ])
  })

  it('passes the client capabilities on, so Snipaya can ask the client', async () => {
    const reconnect = async () => ({ url: new URL(server.url), token: TOKEN })
    const { request, start, messages } = await session({ connection: 'Install Snipaya first.', reconnect })
    await start()
    const call = request('tools/call', { name: 'roots' })
    await until(() => messages.some((message) => message.method === 'roots/list'))
    expect(server.authorizations.every((value) => value === `Bearer ${TOKEN}`)).toBe(true)
    void call
  })

  it('stays on the catalog when Snipaya rejects the token', async () => {
    const reconnect = async () => ({ url: new URL(server.url), token: 'b'.repeat(64) })
    const { request, start } = await session({ connection: 'Install Snipaya first.', reconnect })
    await start()
    const reply = await request('tools/call', { name: 'snipaya_render', arguments: {} })
    expect(reply.result?.isError).toBe(true)
    expect(callText(reply)).toMatch(/Snipaya rejected the token/)
    expect((await request('tools/list')).result).toEqual({ tools: catalog.tools })
  })
})

describe('license agreement', () => {
  it('is never read while Snipaya answers', async () => {
    const licenseAccepted = vi.fn(async () => false)
    const { start } = await session({ connection: { url: new URL(server.url), token: TOKEN }, licenseAccepted })
    expect((await start()).result).toMatchObject({ serverInfo: { name: 'fixture' } })
    expect(licenseAccepted).not.toHaveBeenCalled()
  })

  it('is read when Snipaya does not answer', async () => {
    const licenseAccepted = vi.fn(async () => false)
    const url = new URL(`http://127.0.0.1:${await unusedPort()}/mcp`)
    const { request, start } = await session({ connection: { url, token: TOKEN }, licenseAccepted })
    await start()
    const reply = await request('tools/call', { name: 'snipaya_render', arguments: {} })
    expect(callText(reply)).toMatch(/accept the license agreement/)
    expect(licenseAccepted).toHaveBeenCalled()
  })
})

describe('logging', () => {
  it('never writes the token to stderr', async () => {
    const client = await connectBridged({}, ['--url', server.url, '--token', TOKEN])
    await client.listTools()
    await client.callTool({ name: 'boom' })
    await server.close()
    await expect(client.listTools()).rejects.toThrow()
    expect(stderr).not.toContain(TOKEN)
  })
})

describe('shutdown', () => {
  it('ends the session and exits when stdin closes', async () => {
    const client = await connectBridged()
    await client.listTools()
    await client.close()
    await until(() => server.deletes === 1)
  })

  it('exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, [BIN], {
      env: isolated({ PATH: process.env.PATH ?? '', SNIPAYA_MCP_URL: server.url, SNIPAYA_MCP_TOKEN: TOKEN }),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let errors = ''
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8')
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    expect(await exit).toBe(0)
    expect(errors).toBe('')
  })
})
