import { describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_URL, resolveConfig } from '../src/config.js'

const TOKEN = 'f'.repeat(64)

describe('resolveConfig', () => {
  it('defaults to the Snipaya port on 127.0.0.1', () => {
    expect(DEFAULT_URL).toBe('http://127.0.0.1:47321/mcp')
    const config = resolveConfig([], { SNIPAYA_MCP_TOKEN: TOKEN })
    expect(config).toEqual({ kind: 'run', url: new URL(DEFAULT_URL), token: TOKEN })
  })

  it('reads the url and token from the environment', () => {
    const config = resolveConfig([], {
      SNIPAYA_MCP_URL: 'http://localhost:5000/mcp',
      SNIPAYA_MCP_TOKEN: TOKEN
    })
    expect(config).toEqual({ kind: 'run', url: new URL('http://localhost:5000/mcp'), token: TOKEN })
  })

  it('prefers flags over the environment', () => {
    const config = resolveConfig(['--url', 'http://127.0.0.1:6000/mcp', '--token', 'flag'], {
      SNIPAYA_MCP_URL: 'http://localhost:5000/mcp',
      SNIPAYA_MCP_TOKEN: TOKEN
    })
    expect(config).toEqual({ kind: 'run', url: new URL('http://127.0.0.1:6000/mcp'), token: 'flag' })
  })

  it('treats empty values as unset', () => {
    const config = resolveConfig([], { SNIPAYA_MCP_URL: ' ', SNIPAYA_MCP_TOKEN: TOKEN })
    expect(config).toMatchObject({ url: new URL(DEFAULT_URL) })
  })

  it('accepts a token pasted with its Bearer prefix', () => {
    const config = resolveConfig([], { SNIPAYA_MCP_TOKEN: `Bearer ${TOKEN}` })
    expect(config).toMatchObject({ token: TOKEN })
  })

  it('requires a token', () => {
    expect(() => resolveConfig([], {})).toThrow(ConfigError)
    expect(() => resolveConfig([], { SNIPAYA_MCP_TOKEN: '' })).toThrow(/SNIPAYA_MCP_TOKEN/)
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
    expect(() => resolveConfig(['--url', url], { SNIPAYA_MCP_TOKEN: TOKEN })).toThrow(
      /only connects to 127\.0\.0\.1 or localhost/
    )
  })

  it.each(['https://127.0.0.1:47321/mcp', 'ws://localhost:47321/mcp', 'not a url'])(
    'refuses the url %s',
    (url) => {
      expect(() => resolveConfig(['--url', url], { SNIPAYA_MCP_TOKEN: TOKEN })).toThrow(ConfigError)
    }
  )

  it('rejects unknown flags with a ConfigError', () => {
    expect(() => resolveConfig(['--nope'], { SNIPAYA_MCP_TOKEN: TOKEN })).toThrow(ConfigError)
  })

  it('shows help', () => {
    expect(resolveConfig(['--help'], {})).toEqual({ kind: 'help' })
  })
})
