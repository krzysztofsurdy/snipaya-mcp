import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Catalog {
  snipaya: string
  instructions: string
  tools: { name: string; title: string; description: string; inputSchema: { type: string } }[]
  prompts: { name: string; title: string; description: string; arguments?: { name: string }[] }[]
}

interface Manifest {
  tools: { name: string; description: string }[]
  prompts: { name: string; description: string; arguments: string[]; text: string }[]
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as T

const catalog = read<Catalog>('catalog.json')
const manifest = read<Manifest>('manifest.json')

describe('catalog', () => {
  it('lists the 28 Snipaya tools, each with an object input schema', () => {
    expect(catalog.tools).toHaveLength(28)
    for (const tool of catalog.tools) {
      expect(tool.name).toMatch(/^snipaya_[a-z_]+$/)
      expect(tool.title).not.toBe('')
      expect(tool.description).not.toBe('')
      expect(tool.inputSchema.type).toBe('object')
    }
    expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(28)
  })

  it('lists the 6 Snipaya prompts', () => {
    expect(catalog.prompts.map((prompt) => prompt.name)).toEqual([
      'explain_bug',
      'redact_before_sharing',
      'finish_screenshot',
      'copy_text',
      'make_walkthrough',
      'compare_before_after'
    ])
  })

  it('carries the server instructions and the app version it was read from', () => {
    expect(catalog.instructions).toMatch(/^Call snipaya_get_canvas first/)
    expect(catalog.snipaya).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('matches the tools and prompts in manifest.json', () => {
    expect(manifest.tools).toEqual(catalog.tools.map(({ name, description }) => ({ name, description })))
    expect(manifest.prompts.map(({ name, description, arguments: args }) => ({ name, description, args }))).toEqual(
      catalog.prompts.map(({ name, description, arguments: args = [] }) => ({
        name,
        description,
        args: args.map((arg) => arg.name)
      }))
    )
    for (const prompt of manifest.prompts) expect(prompt.text).not.toBe('')
  })
})
