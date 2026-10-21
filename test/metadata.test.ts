import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageJson {
  name: string
  version: string
  mcpName: string
  bin: Record<string, string>
}

interface ServerJson {
  name: string
  version: string
  description: string
  packages: {
    registryType: string
    identifier: string
    version: string
    environmentVariables: { name: string }[]
  }[]
}

interface Manifest {
  version: string
  server: { entry_point: string; mcp_config: { env: Record<string, string> } }
  user_config: Record<string, unknown>
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as T

const pkg = read<PackageJson>('package.json')
const server = read<ServerJson>('server.json')
const manifest = read<Manifest>('manifest.json')
const [npmPackage] = server.packages
const variable = (name: string) =>
  npmPackage?.environmentVariables.find((entry) => entry.name === name)

describe('directory metadata', () => {
  it('keeps one version everywhere', () => {
    expect(server.version).toBe(pkg.version)
    expect(npmPackage?.version).toBe(pkg.version)
    expect(manifest.version).toBe(pkg.version)
  })

  it('ties the npm package to the registry entry', () => {
    expect(server.name).toBe(pkg.mcpName)
    expect(npmPackage?.identifier).toBe(pkg.name)
    expect(npmPackage?.registryType).toBe('npm')
    expect(server.description.length).toBeLessThanOrEqual(100)
  })

  it('marks the token as an optional secret in both formats', () => {
    expect(variable('SNIPAYA_MCP_TOKEN')).toMatchObject({ isRequired: false, isSecret: true })
    expect(manifest.user_config.token).toMatchObject({ sensitive: true, required: false, default: '' })
    expect(manifest.server.mcp_config.env.SNIPAYA_MCP_TOKEN).toBe('${user_config.token}')
  })

  it('lists the switch that stops the bridge from opening Snipaya', () => {
    expect(variable('SNIPAYA_MCP_NO_LAUNCH')).toMatchObject({ isRequired: false, isSecret: false })
  })

  it('points the bundle at the built entry point', () => {
    expect(manifest.server.entry_point).toBe(pkg.bin['snipaya-mcp'])
  })
})
