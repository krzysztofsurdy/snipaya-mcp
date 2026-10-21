import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { exit, stderr } from 'node:process'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const { name, version } = readJson('package.json')
const server = readJson('server.json')
const manifest = readJson('manifest.json')

const npmPackage = server.packages?.find(
  (entry) => entry.registryType === 'npm' && entry.identifier === name
)
if (!npmPackage) {
  stderr.write(`server.json has no npm package ${name}\n`)
  exit(1)
}

server.version = version
npmPackage.version = version
manifest.version = version

writeJson('server.json', server)
writeJson('manifest.json', manifest)
execFileSync('git', ['add', 'server.json', 'manifest.json'], { stdio: 'inherit' })
