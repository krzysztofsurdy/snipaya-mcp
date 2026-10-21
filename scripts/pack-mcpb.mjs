import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2'
const STAGE = 'build/mcpb'
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const output = `snipaya-mcp-${version}.mcpb`

const run = (command, args, cwd = '.') => execFileSync(command, args, { cwd, stdio: 'inherit' })

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
for (const file of ['manifest.json', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'dist']) {
  cpSync(file, join(STAGE, file), { recursive: true })
}
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], STAGE)
run('npx', ['-y', MCPB_CLI, 'pack', STAGE, output])
