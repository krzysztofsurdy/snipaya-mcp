import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJson, smitheryManifest } from './metadata.mjs'

const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2'
const STAGE = 'build/mcpb'
const SMITHERY_STAGE = 'build/smithery'
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const output = `snipaya-mcp-${version}.mcpb`
const smitheryOutput = `snipaya-mcp-${version}-smithery.mcpb`

const run = (command, args, cwd = '.') => execFileSync(command, args, { cwd, stdio: 'inherit' })

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
for (const file of [
  'manifest.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'catalog.json',
  'dist',
  'assets/snipaya-icon.png'
]) {
  cpSync(file, join(STAGE, file), { recursive: true })
}
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], STAGE)
run('npx', ['-y', MCPB_CLI, 'pack', STAGE, output])

rmSync(SMITHERY_STAGE, { recursive: true, force: true })
mkdirSync(SMITHERY_STAGE, { recursive: true })
const manifest = smitheryManifest(readJson('manifest.json'), readJson('catalog.json'))
writeFileSync(join(SMITHERY_STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(output, smitheryOutput)
run('zip', ['-q', '-X', resolve(smitheryOutput), 'manifest.json'], SMITHERY_STAGE)
