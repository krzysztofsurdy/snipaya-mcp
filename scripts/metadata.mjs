import { readFileSync } from 'node:fs'

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export const npmPackageOf = (server, name) =>
  server.packages?.find((entry) => entry.registryType === 'npm' && entry.identifier === name)
