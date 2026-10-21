import { argv, exit, stderr, stdout } from 'node:process'
import { npmPackageOf, readJson } from './metadata.mjs'

const tag = argv[2] ?? ''
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)
if (!match) {
  stderr.write(`Expected a tag like v1.2.3, got ${JSON.stringify(tag)}\n`)
  exit(1)
}
const wanted = match[1]

const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const server = readJson('server.json')
const manifest = readJson('manifest.json')
const npmPackage = npmPackageOf(server, pkg.name)

const found = {
  'package.json version': pkg.version,
  'package-lock.json version': lock.version,
  'package-lock.json packages[""].version': lock.packages?.['']?.version,
  'server.json version': server.version,
  'server.json packages[npm].version': npmPackage?.version,
  'manifest.json version': manifest.version
}

const mismatches = Object.entries(found).filter(([, version]) => version !== wanted)
if (mismatches.length > 0) {
  for (const [label, version] of mismatches) {
    stderr.write(`${label} is ${version}, tag ${tag} wants ${wanted}\n`)
  }
  exit(1)
}
stdout.write(`${wanted}\n`)
