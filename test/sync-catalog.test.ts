import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/sync-catalog.mjs', import.meta.url))
const APP = fileURLToPath(new URL('./fixtures/app', import.meta.url))

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
const stripsTypes = major > 22 || (major === 22 && minor >= 6)

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'snipaya-catalog-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ name: 'snipaya-mcp', version: '1.0.0', tools: [], tools_generated: true }, null, 2)}\n`
  )
  return dir
}

const sync = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8'
  })

const readJson = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'))

describe.runIf(stripsTypes)('sync-catalog', () => {
  it('writes the tools, prompts and instructions the app serves', () => {
    const dir = workspace()

    const result = sync(dir, APP)

    expect(result.status, result.stderr).toBe(0)
    const catalog = readJson(dir, 'catalog.json')
    expect(catalog.snipaya).toBe('9.8.7')
    expect(catalog.instructions).toBe('Look first.\nWipe with care.')
    expect(catalog.tools).toEqual([
      {
        name: 'snipaya_look',
        title: 'Look',
        description: 'Look at the canvas.',
        inputSchema: {
          type: 'object',
          properties: { tabId: { type: 'string', description: 'Target tab id.' } },
          $schema: 'http://json-schema.org/draft-07/schema#'
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        execution: { taskSupport: 'forbidden' }
      },
      {
        name: 'snipaya_wipe',
        title: 'Wipe',
        description: 'Wipe elements.',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
            mode: { type: 'string', enum: ['soft', 'hard'], default: 'soft' }
          },
          required: ['ids'],
          $schema: 'http://json-schema.org/draft-07/schema#'
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        execution: { taskSupport: 'forbidden' }
      }
    ])
    expect(catalog.prompts).toEqual([
      {
        name: 'tidy_up',
        title: 'Tidy up',
        description: 'Remove clutter from the canvas.',
        arguments: [{ name: 'focus', description: 'What to keep.', required: false }]
      }
    ])
  })

  it('writes spec-valid tools and prompts into manifest.json', () => {
    const dir = workspace()

    const result = sync(dir, APP)

    expect(result.status, result.stderr).toBe(0)
    const manifest = readJson(dir, 'manifest.json')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.tools).toEqual([
      { name: 'snipaya_look', description: 'Look at the canvas.' },
      { name: 'snipaya_wipe', description: 'Wipe elements.' }
    ])
    expect(manifest.tools_generated).toBe(true)
    expect(manifest.prompts).toEqual([
      { name: 'tidy_up', description: 'Remove clutter from the canvas.', arguments: ['focus'], text: 'Tidy up.' }
    ])
    expect(manifest.prompts_generated).toBe(true)
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
  })

  it('explains a checkout that is not the Snipaya app', () => {
    const dir = workspace()

    const result = sync(dir, dir)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`Cannot load the Snipaya MCP definitions from ${dir}`)
    expect(result.stderr).not.toMatch(/\n\s+at /)
  })
})
