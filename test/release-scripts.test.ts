import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoFile = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url))
const script = (name: string) => repoFile(`scripts/${name}`)

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const writeJson = (dir: string, file: string, value: unknown) =>
  writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`)

const readJson = (dir: string, file: string) =>
  JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>

const project = (versions: { pkg: string; lock?: string; server?: string; npm?: string; manifest?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), 'snipaya-release-'))
  dirs.push(dir)
  const lock = versions.lock ?? versions.pkg
  writeJson(dir, 'package.json', { name: 'snipaya-mcp', version: versions.pkg })
  writeJson(dir, 'package-lock.json', {
    name: 'snipaya-mcp',
    version: lock,
    lockfileVersion: 3,
    packages: { '': { name: 'snipaya-mcp', version: lock } }
  })
  writeJson(dir, 'server.json', {
    name: 'io.github.krzysztofsurdy/snipaya-mcp',
    version: versions.server ?? versions.pkg,
    packages: [
      { registryType: 'npm', identifier: 'snipaya-mcp', version: versions.npm ?? versions.pkg }
    ]
  })
  writeJson(dir, 'manifest.json', { name: 'snipaya-mcp', version: versions.manifest ?? versions.pkg })
  return dir
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

const gitRepo = (dir: string) => {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'tag.gpgsign', 'false')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
}

const run = (name: string, dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [script(name), ...args], { cwd: dir, encoding: 'utf8' })

describe('sync-version', () => {
  it('copies the package.json version into server.json and manifest.json and stages them', () => {
    const dir = project({ pkg: '1.1.0' })
    gitRepo(dir)
    writeJson(dir, 'package.json', { name: 'snipaya-mcp', version: '1.2.0' })

    const result = run('sync-version.mjs', dir)

    expect(result.status, result.stderr).toBe(0)
    const server = readJson(dir, 'server.json') as { version: string; packages: { version: string }[] }
    expect(server.version).toBe('1.2.0')
    expect(server.packages[0]?.version).toBe('1.2.0')
    expect(readJson(dir, 'manifest.json').version).toBe('1.2.0')
    expect(git(dir, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([
      'manifest.json',
      'server.json'
    ])
  })

  it('keeps the two-space formatting with a trailing newline', () => {
    const dir = project({ pkg: '1.1.0' })
    gitRepo(dir)
    writeJson(dir, 'package.json', { name: 'snipaya-mcp', version: '2.0.0' })

    run('sync-version.mjs', dir)

    const text = readFileSync(join(dir, 'manifest.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify({ name: 'snipaya-mcp', version: '2.0.0' }, null, 2)}\n`)
  })

  it('fails when server.json has no npm package for this package', () => {
    const dir = project({ pkg: '1.1.0' })
    writeJson(dir, 'server.json', { name: 'x', version: '1.1.0', packages: [] })
    gitRepo(dir)

    const result = run('sync-version.mjs', dir)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('server.json has no npm package snipaya-mcp')
    expect(readJson(dir, 'manifest.json').version).toBe('1.1.0')
  })
})

describe('npm version', () => {
  it('bumps all four files in one commit tagged v<version>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snipaya-release-'))
    dirs.push(dir)
    for (const file of [
      '.npmrc',
      'package.json',
      'package-lock.json',
      'server.json',
      'manifest.json',
      'scripts/metadata.mjs',
      'scripts/sync-version.mjs'
    ]) {
      cpSync(repoFile(file), join(dir, file))
    }
    gitRepo(dir)
    const { version } = readJson(dir, 'package.json') as { version: string }
    const [major = 0, minor = 0] = version.split('.').map(Number)
    const next = `${major}.${minor + 1}.0`

    const result = spawnSync('npm', ['version', 'minor', '--ignore-scripts=false'], {
      cwd: dir,
      encoding: 'utf8'
    })

    expect(result.status, result.stderr).toBe(0)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(git(dir, 'tag', '--points-at', 'HEAD')).toBe(`v${next}`)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe(`chore: release v${next}`)
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'manifest.json',
      'package-lock.json',
      'package.json',
      'server.json'
    ])
    expect(readJson(dir, 'server.json').version).toBe(next)
    expect(readJson(dir, 'manifest.json').version).toBe(next)
  })
})

describe('verify-version', () => {
  it('prints the version when the tag matches all four files', () => {
    const dir = project({ pkg: '1.2.0' })

    const result = run('verify-version.mjs', dir, 'v1.2.0')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('1.2.0\n')
  })

  it('names every file whose version differs from the tag', () => {
    const dir = project({ pkg: '1.2.0', lock: '1.1.0', npm: '1.1.0', manifest: '1.1.0' })

    const result = run('verify-version.mjs', dir, 'v1.2.0')

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('package-lock.json')
    expect(result.stderr).toContain('server.json packages[npm]')
    expect(result.stderr).toContain('manifest.json')
    expect(result.stderr).not.toContain('package.json version')
  })

  it('fails when the tag is another version', () => {
    const dir = project({ pkg: '1.2.0' })

    const result = run('verify-version.mjs', dir, 'v1.2.1')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('package.json version is 1.2.0, tag v1.2.1 wants 1.2.1')
  })

  it.each([['1.2.0'], ['release-1.2.0'], ['']])('rejects the tag %j', (tag) => {
    const dir = project({ pkg: '1.2.0' })

    const result = run('verify-version.mjs', dir, tag)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Expected a tag like v1.2.3')
  })
})
