import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, type RunConfig } from '../src/config.js'
import {
  BUNDLE_ID,
  ensureSnipaya,
  openSnipaya,
  probeUrl,
  type LaunchDeps,
  type Reachability
} from '../src/launch.js'
import { startTestServer, unusedPort } from './fixtures/server.js'

const TOKEN = 'd'.repeat(64)

const config = (port: number, autoLaunch = true): RunConfig => ({
  kind: 'run',
  url: new URL(`http://127.0.0.1:${port}/mcp`),
  token: TOKEN,
  autoLaunch,
  savedServerOn: true
})

const fakeDeps = (answers: Reachability[], overrides: Partial<LaunchDeps> = {}) => {
  let time = 0
  const probed: string[] = []
  const logs: string[] = []
  const deps: LaunchDeps = {
    platform: 'darwin',
    probe: async (url) => {
      probed.push(url.toString())
      return answers.shift() ?? 'refused'
    },
    launch: vi.fn(async () => undefined),
    reload: async () => config(47321),
    licenseAccepted: vi.fn(async () => true),
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    log: (line) => logs.push(line),
    ...overrides
  }
  return { deps, probed, logs, elapsed: () => time }
}

describe('ensureSnipaya', () => {
  it('leaves Snipaya alone when auto-launch is off', async () => {
    const { deps, probed } = fakeDeps([])
    const off = config(47321, false)
    expect(await ensureSnipaya(off, deps)).toBe(off)
    expect(probed).toEqual([])
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it.each<NodeJS.Platform>(['linux', 'win32'])('never launches on %s', async (platform) => {
    const { deps, probed } = fakeDeps([], { platform })
    await ensureSnipaya(config(47321), deps)
    expect(probed).toEqual([])
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it.each<Reachability>(['answered', 'unreachable'])(
    'does not launch when the server is %s',
    async (first) => {
      const { deps, probed } = fakeDeps([first])
      const current = config(47321)
      expect(await ensureSnipaya(current, deps)).toBe(current)
      expect(probed).toHaveLength(1)
      expect(deps.launch).not.toHaveBeenCalled()
    }
  )

  it('opens Snipaya once and waits until its server answers', async () => {
    const { deps, probed, logs } = fakeDeps(['refused', 'refused', 'unreachable', 'answered'], {
      reload: async () => config(47400)
    })
    const ready = await ensureSnipaya(config(47321), deps)
    expect(deps.launch).toHaveBeenCalledTimes(1)
    expect(ready.url.toString()).toBe('http://127.0.0.1:47400/mcp')
    expect(probed).toHaveLength(4)
    expect(logs).toEqual(['Snipaya is not running. Opening it in the background.'])
  })

  it('gives up after about 10 s with a clear message', async () => {
    const { deps, elapsed } = fakeDeps([])
    const outcome = ensureSnipaya(config(47321), deps)
    await expect(outcome).rejects.toThrow(ConfigError)
    await expect(outcome).rejects.toThrow(
      /Opened Snipaya, but its MCP server did not answer within 10 s\. Check the status in Snipaya > Settings > AI Assistants\./
    )
    expect(deps.launch).toHaveBeenCalledTimes(1)
    expect(elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(elapsed()).toBeLessThan(11_000)
  })

  it('asks to accept the license agreement when Snipaya waits for it', async () => {
    const { deps } = fakeDeps([], { licenseAccepted: vi.fn(async () => false) })
    const outcome = ensureSnipaya(config(47321), deps)
    await expect(outcome).rejects.toThrow(ConfigError)
    await expect(outcome).rejects.toThrow(
      'Opened Snipaya, but its MCP server starts only after you accept the license agreement. Accept it in Snipaya, then restart the snipaya server in your MCP client. If Snipaya shows no agreement, check the status in Snipaya > Settings > AI Assistants.'
    )
    expect(deps.launch).toHaveBeenCalledTimes(1)
  })

  it('connects when the license agreement is accepted while it waits', async () => {
    const { deps } = fakeDeps(['refused', 'refused', 'answered'], {
      licenseAccepted: vi.fn(async () => false)
    })
    expect(await ensureSnipaya(config(47321), deps)).toEqual(config(47321))
    expect(deps.licenseAccepted).not.toHaveBeenCalled()
  })

  it.each<Reachability[]>([['answered'], ['unreachable'], ['refused', 'answered']])(
    'never checks the license agreement when the server is not refused for good (%s)',
    async (...answers) => {
      const { deps } = fakeDeps(answers)
      await ensureSnipaya(config(47321), deps)
      expect(deps.licenseAccepted).not.toHaveBeenCalled()
    }
  )

  it('explains when Snipaya cannot be opened', async () => {
    const { deps } = fakeDeps(['refused'], {
      launch: vi.fn(async () => {
        throw new Error('Unable to find application named dev.snipaya.app')
      })
    })
    await expect(ensureSnipaya(config(47321), deps)).rejects.toThrow(
      /Cannot open Snipaya \(dev\.snipaya\.app\)\. Install it from https:\/\/snipaya\.app or open it yourself\./
    )
  })

  it('stops waiting when the settings turn invalid', async () => {
    const { deps } = fakeDeps(['refused'], {
      reload: async () => {
        throw new ConfigError("Snipaya's MCP server is off.")
      }
    })
    await expect(ensureSnipaya(config(47321), deps)).rejects.toThrow(/MCP server is off/)
  })

  it('never logs the token', async () => {
    const { deps, logs } = fakeDeps(['refused', 'answered'])
    await ensureSnipaya(config(47321), deps)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})

describe('openSnipaya', () => {
  it('opens the app by bundle id in the background without a shell', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await openSnipaya(run)
    expect(BUNDLE_ID).toBe('dev.snipaya.app')
    expect(run).toHaveBeenCalledWith('open', ['-g', '-b', 'dev.snipaya.app'])
  })
})

describe('probeUrl', () => {
  const servers: Server[] = []
  const sockets: Socket[] = []

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.destroy())
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
  })

  const listen = async (onConnection: (socket: Socket) => void): Promise<number> => {
    const server = createServer((socket) => {
      sockets.push(socket)
      onConnection(socket)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }

  it('reports any HTTP answer, including 401, as answered', async () => {
    const server = await startTestServer(TOKEN)
    try {
      expect(await probeUrl(new URL(server.url))).toBe('answered')
      expect(server.authorizations).toEqual([undefined])
      expect(server.origins).toEqual([undefined])
    } finally {
      await server.close()
    }
  })

  it('reports a closed port as refused', async () => {
    const port = await unusedPort()
    expect(await probeUrl(new URL(`http://127.0.0.1:${port}/mcp`))).toBe('refused')
  })

  it('reports a closed port on localhost as refused', async () => {
    const port = await unusedPort()
    expect(await probeUrl(new URL(`http://localhost:${port}/mcp`))).toBe('refused')
  })

  it('reports a dropped connection as unreachable', async () => {
    const port = await listen((socket) => socket.destroy())
    expect(await probeUrl(new URL(`http://127.0.0.1:${port}/mcp`))).toBe('unreachable')
  })

  it('reports a server that never answers as unreachable', async () => {
    const port = await listen(() => undefined)
    expect(await probeUrl(new URL(`http://127.0.0.1:${port}/mcp`), 200)).toBe('unreachable')
  })
})
