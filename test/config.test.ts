import { describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_URL, resolveConfig } from '../src/config.js'
import type { Settings } from '../src/settings.js'

const TOKEN = 'f'.repeat(64)
const SAVED = 'e'.repeat(64)
const FILE = '/Users/someone/Library/Application Support/Snipaya/mcp.json'

const MISSING: Settings = { kind: 'missing', file: FILE }
const SAVED_ON: Settings = { kind: 'found', file: FILE, enabled: true, token: SAVED, port: 47400 }

describe('resolveConfig', () => {
  it('defaults to the Snipaya port on 127.0.0.1', () => {
    expect(DEFAULT_URL).toBe('http://127.0.0.1:47321/mcp')
    const config = resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN }, MISSING)
    expect(config).toEqual({
      kind: 'run',
      url: new URL(DEFAULT_URL),
      token: TOKEN,
      autoLaunch: false,
      savedServerOn: false
    })
  })

  it('reads the url and token from the environment', () => {
    const config = resolveConfig(
      [],
      { SNIPAYA_MCP_URL: 'http://localhost:5000/mcp', SNIPAYA_MCP_TOKEN: TOKEN },
      MISSING
    )
    expect(config).toMatchObject({ url: new URL('http://localhost:5000/mcp'), token: TOKEN })
  })

  it('prefers flags over the environment', () => {
    const config = resolveConfig(
      ['--url', 'http://127.0.0.1:6000/mcp', '--token', 'flag'],
      { SNIPAYA_MCP_URL: 'http://localhost:5000/mcp', SNIPAYA_MCP_TOKEN: TOKEN },
      SAVED_ON
    )
    expect(config).toMatchObject({ url: new URL('http://127.0.0.1:6000/mcp'), token: 'flag' })
  })

  it('treats empty values as unset', () => {
    const config = resolveConfig([], { SNIPAYA_MCP_URL: ' ', SNIPAYA_MCP_TOKEN: TOKEN }, MISSING)
    expect(config).toMatchObject({ url: new URL(DEFAULT_URL) })
  })

  it('treats placeholders an MCP Bundle host left unfilled as unset', () => {
    const config = resolveConfig(
      [],
      { SNIPAYA_MCP_URL: '${user_config.url}', SNIPAYA_MCP_TOKEN: '${user_config.token}' },
      SAVED_ON
    )
    expect(config).toMatchObject({ url: new URL('http://127.0.0.1:47400/mcp'), token: SAVED })
  })

  it('accepts a token pasted with its Bearer prefix', () => {
    const config = resolveConfig([], { SNIPAYA_MCP_TOKEN: `Bearer ${TOKEN}` }, MISSING)
    expect(config).toMatchObject({ token: TOKEN })
  })

  it.each([
    'http://192.168.1.20:47321/mcp',
    'http://10.0.0.1/mcp',
    'http://[::1]:47321/mcp',
    'http://0.0.0.0:47321/mcp',
    'http://localhost.example.com/mcp',
    'http://127.0.0.1.nip.io/mcp',
    'http://example.com/mcp'
  ])('refuses the non-loopback url %s', (url) => {
    expect(() => resolveConfig(['--url', url], { SNIPAYA_MCP_TOKEN: TOKEN }, MISSING)).toThrow(
      /only connects to 127\.0\.0\.1 or localhost/
    )
  })

  it.each(['https://127.0.0.1:47321/mcp', 'ws://localhost:47321/mcp', 'not a url'])(
    'refuses the url %s',
    (url) => {
      expect(() => resolveConfig(['--url', url], { SNIPAYA_MCP_TOKEN: TOKEN }, MISSING)).toThrow(
        ConfigError
      )
    }
  )

  it('rejects unknown flags with a ConfigError', () => {
    expect(() => resolveConfig(['--nope'], { SNIPAYA_MCP_TOKEN: TOKEN }, MISSING)).toThrow(ConfigError)
  })

  it('shows help', () => {
    expect(resolveConfig(['--help'], {}, MISSING)).toEqual({ kind: 'help' })
  })
})

describe('resolveConfig with the settings Snipaya saved', () => {
  it('reads the token and port when nothing is set', () => {
    expect(resolveConfig([], {}, SAVED_ON)).toEqual({
      kind: 'run',
      url: new URL('http://127.0.0.1:47400/mcp'),
      token: SAVED,
      autoLaunch: true,
      savedServerOn: true
    })
  })

  it('uses the default URL when Snipaya saved no port', () => {
    const settings: Settings = { kind: 'found', file: FILE, enabled: true, token: SAVED }
    expect(resolveConfig([], {}, settings)).toMatchObject({ url: new URL(DEFAULT_URL) })
  })

  it('prefers the token from the environment over the saved one', () => {
    expect(resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN }, SAVED_ON)).toMatchObject({
      token: TOKEN,
      url: new URL('http://127.0.0.1:47400/mcp')
    })
  })

  it('prefers the URL from the environment over the saved port', () => {
    expect(
      resolveConfig([], { SNIPAYA_MCP_URL: 'http://localhost:5000/mcp' }, SAVED_ON)
    ).toMatchObject({ token: SAVED, url: new URL('http://localhost:5000/mcp') })
  })

  it.each<[string, Settings]>([
    ['missing', MISSING],
    ['unreadable', { kind: 'unreadable', file: FILE, reason: 'EACCES' }],
    ['turned off', { kind: 'found', file: FILE, enabled: false, token: SAVED }],
    ['tokenless', { kind: 'found', file: FILE, enabled: true }]
  ])('ignores %s settings when a token is set', (_name, settings) => {
    expect(resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN }, settings)).toMatchObject({
      token: TOKEN,
      url: new URL(DEFAULT_URL)
    })
  })

  it('explains that Snipaya was never set up when the settings are missing', () => {
    expect(() => resolveConfig([], {}, MISSING)).toThrow(ConfigError)
    expect(() => resolveConfig([], { SNIPAYA_MCP_TOKEN: '' }, MISSING)).toThrow(
      /not found at .*Snipaya\/mcp\.json.*Install Snipaya, open it.*Allow AI assistants in Snipaya > Settings > AI Assistants.*SNIPAYA_MCP_TOKEN/
    )
  })

  it('explains settings it cannot read', () => {
    const settings: Settings = { kind: 'unreadable', file: FILE, reason: 'it is not valid JSON' }
    expect(() => resolveConfig([], {}, settings)).toThrow(
      /settings at .*Snipaya\/mcp\.json cannot be read: it is not valid JSON\..*Open Snipaya.*SNIPAYA_MCP_TOKEN/
    )
  })

  it('asks to turn the server on when Snipaya saved it as off', () => {
    const settings: Settings = { kind: 'found', file: FILE, enabled: false, token: SAVED }
    expect(() => resolveConfig([], {}, settings)).toThrow(
      /MCP server is off\. Turn on Allow AI assistants in Snipaya > Settings > AI Assistants\./
    )
  })

  it('explains a saved token that is not valid', () => {
    const settings: Settings = { kind: 'found', file: FILE, enabled: true }
    expect(() => resolveConfig([], {}, settings)).toThrow(/no valid token.*Open Snipaya.*SNIPAYA_MCP_TOKEN/)
  })

  it('shows help even when the settings are missing', () => {
    expect(resolveConfig(['-h'], {}, MISSING)).toEqual({ kind: 'help' })
  })
})

describe('autoLaunch', () => {
  it('is on only when Snipaya saved the server as on', () => {
    const off: Settings = { kind: 'found', file: FILE, enabled: false, token: SAVED }
    expect(resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN }, SAVED_ON)).toMatchObject({ autoLaunch: true })
    expect(resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN }, off)).toMatchObject({ autoLaunch: false })
    expect(resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN }, MISSING)).toMatchObject({ autoLaunch: false })
  })

  it.each(['1', 'true', 'TRUE', 'yes'])('is off with SNIPAYA_MCP_NO_LAUNCH=%s', (value) => {
    expect(resolveConfig([], { SNIPAYA_MCP_NO_LAUNCH: value }, SAVED_ON)).toMatchObject({
      autoLaunch: false
    })
  })

  it.each(['', ' ', '0', 'false'])('stays on with SNIPAYA_MCP_NO_LAUNCH=%j', (value) => {
    expect(resolveConfig([], { SNIPAYA_MCP_NO_LAUNCH: value }, SAVED_ON)).toMatchObject({
      autoLaunch: true
    })
  })
})

describe('savedServerOn', () => {
  it('is on only when Snipaya saved the server as on, even with SNIPAYA_MCP_NO_LAUNCH', () => {
    const off: Settings = { kind: 'found', file: FILE, enabled: false, token: SAVED }
    const env = { SNIPAYA_MCP_TOKEN: TOKEN, SNIPAYA_MCP_NO_LAUNCH: '1' }
    expect(resolveConfig([], env, SAVED_ON)).toMatchObject({ savedServerOn: true })
    expect(resolveConfig([], env, off)).toMatchObject({ savedServerOn: false })
    expect(resolveConfig([], env, MISSING)).toMatchObject({ savedServerOn: false })
  })
})
