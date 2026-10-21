import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestServer, unusedPort, type TestServer } from './fixtures/server.js'

const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const TOKEN = 'a'.repeat(64)

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

const saveSettings = (settings: Record<string, unknown>): void => {
  const dir = join(home, 'Library', 'Application Support', 'Snipaya')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(settings), { mode: 0o600 })
}

const serverPort = (): number => Number(new URL(server.url).port)

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

  it('explains that Snipaya is not reachable', async () => {
    const url = `http://127.0.0.1:${await unusedPort()}/mcp`
    await expect(
      connectBridged({ SNIPAYA_MCP_URL: url, SNIPAYA_MCP_TOKEN: TOKEN })
    ).rejects.toThrow(/Turn on the MCP server in Snipaya > Settings > AI Assistants/)
    expect(stderr).toMatch(/Cannot reach Snipaya/)
    expect(stderr).not.toMatch(/\n\s+at /)
    expect(stderr).not.toContain(TOKEN)
  })

  it.runIf(process.platform === 'darwin')(
    'tries to open Snipaya when its saved server is on but not running',
    async () => {
      saveSettings({ enabled: true, token: TOKEN, port: await unusedPort() })
      const result = run([], { SNIPAYA_MCP_NO_LAUNCH: '', PATH: home })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/Snipaya is not running\. Opening it in the background\./)
      expect(result.stderr).toMatch(/Cannot open Snipaya \(dev\.snipaya\.app\)/)
      expect(result.stderr).not.toContain(TOKEN)
    }
  )

  it('does not open Snipaya with SNIPAYA_MCP_NO_LAUNCH=1', async () => {
    saveSettings({ enabled: true, token: TOKEN, port: await unusedPort() })
    await expect(connectBridged({ SNIPAYA_MCP_NO_LAUNCH: '1', PATH: home })).rejects.toThrow(
      /Cannot reach Snipaya/
    )
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

  it('explains that Snipaya was never set up when no token is set', () => {
    const result = run([], {})
    expect(result.status).toBe(1)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr).toMatch(/settings were not found.*Allow AI assistants.*SNIPAYA_MCP_TOKEN/)
  })

  it('asks to turn the server on when Snipaya saved it as off', () => {
    saveSettings({ enabled: false, token: TOKEN, port: serverPort() })
    const result = run([], {})
    expect(result.status).toBe(1)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr).toMatch(/MCP server is off\. Turn on Allow AI assistants/)
    expect(result.stderr).not.toContain(TOKEN)
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
