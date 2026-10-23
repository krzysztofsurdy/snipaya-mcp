import { readFileSync } from 'node:fs'
import type { Prompt, Tool } from '@modelcontextprotocol/sdk/types.js'

export interface Catalog {
  snipaya: string
  instructions: string
  tools: Tool[]
  prompts: Prompt[]
}

const packageFile = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))

export const loadCatalog = (): Catalog => packageFile('catalog.json') as Catalog

export const packageVersion = (): string => (packageFile('package.json') as { version: string }).version
