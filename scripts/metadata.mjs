import { readFileSync } from 'node:fs'

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export const npmPackageOf = (server, name) =>
  server.packages?.find((entry) => entry.registryType === 'npm' && entry.identifier === name)

export const smitheryManifest = (manifest, catalog) => ({
  ...manifest,
  tools: manifest.tools.map((tool) => {
    const entry = catalog.tools.find((candidate) => candidate.name === tool.name)
    if (!entry) throw new Error(`catalog.json has no tool ${tool.name}`)
    return { ...tool, inputSchema: entry.inputSchema }
  })
})
