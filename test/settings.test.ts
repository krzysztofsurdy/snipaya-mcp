import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSettings, settingsFile } from '../src/settings.js'

const TOKEN = 'c'.repeat(64)

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snipaya-settings-'))
  file = join(dir, 'mcp.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (content: unknown): void => {
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

describe('settingsFile', () => {
  it('points at the mcp.json in the Snipaya userData folder', () => {
    expect(settingsFile('/Users/someone')).toBe(
      '/Users/someone/Library/Application Support/Snipaya/mcp.json'
    )
  })
})

describe('readSettings', () => {
  it('reads the switch, token and port that Snipaya saved', async () => {
    write({ enabled: true, token: TOKEN, port: 47400 })
    expect(await readSettings(file)).toEqual({
      kind: 'found',
      file,
      enabled: true,
      token: TOKEN,
      port: 47400
    })
  })

  it('reports a missing file', async () => {
    expect(await readSettings(join(dir, 'absent', 'mcp.json'))).toEqual({
      kind: 'missing',
      file: join(dir, 'absent', 'mcp.json')
    })
  })

  it('treats anything but enabled true as off', async () => {
    write({ enabled: 'yes', token: TOKEN })
    expect(await readSettings(file)).toMatchObject({ kind: 'found', enabled: false })
  })

  it.each([
    ['short', 'abc'],
    ['uppercase', 'C'.repeat(64)],
    ['padded', ` ${TOKEN}`],
    ['not a string', 42]
  ])('drops a %s token', async (_name, token) => {
    write({ enabled: true, token })
    const settings = await readSettings(file)
    expect(settings).toMatchObject({ kind: 'found', enabled: true })
    expect(settings).not.toHaveProperty('token')
  })

  it.each([0, 65536, 1.5, '47321'])('drops the invalid port %s', async (port) => {
    write({ enabled: true, token: TOKEN, port })
    expect(await readSettings(file)).not.toHaveProperty('port')
  })

  it('reports invalid JSON without echoing the content', async () => {
    write(`{"enabled": true, "token": "${TOKEN}"`)
    const settings = await readSettings(file)
    expect(settings).toEqual({ kind: 'unreadable', file, reason: 'it is not valid JSON' })
    expect(JSON.stringify(settings)).not.toContain(TOKEN)
  })

  it.each([['null'], ['[]'], ['"text"']])('reports %s as unreadable', async (content) => {
    write(content)
    expect(await readSettings(file)).toEqual({
      kind: 'unreadable',
      file,
      reason: 'it is not a JSON object'
    })
  })

  it.skipIf(process.getuid?.() === 0)('reports a file it may not read', async () => {
    write({ enabled: true, token: TOKEN })
    chmodSync(file, 0o000)
    expect(await readSettings(file)).toEqual({ kind: 'unreadable', file, reason: 'EACCES' })
  })

  it('reports a directory in place of the file', async () => {
    mkdirSync(file)
    expect(await readSettings(file)).toEqual({ kind: 'unreadable', file, reason: 'EISDIR' })
  })
})
