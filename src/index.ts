#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises'
import { startBridge } from './bridge.js'
import { ConfigError, resolveConfig, USAGE, type RunConfig } from './config.js'
import { ensureSnipaya, openSnipaya, probeUrl } from './launch.js'
import { readSettings, settingsFile } from './settings.js'

const write = (line: string): void => {
  process.stderr.write(`snipaya-mcp: ${line}\n`)
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const load = async () => resolveConfig(argv, process.env, await readSettings(settingsFile()))
  const initial = await load()
  if (initial.kind === 'help') {
    process.stderr.write(`${USAGE}\n`)
    return
  }
  const config = await ensureSnipaya(initial, {
    platform: process.platform,
    probe: probeUrl,
    launch: () => openSnipaya(),
    reload: () => load() as Promise<RunConfig>,
    now: Date.now,
    sleep: (ms) => sleep(ms),
    log: write
  })
  const log = (line: string): void => write(line.replaceAll(config.token, '[token]'))
  const bridge = await startBridge({ url: config.url, token: config.token, log })
  const shutdown = (): void => {
    bridge.close().finally(() => process.exit(0))
  }
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  process.stdout.once('error', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  write(error instanceof ConfigError ? error.message : `Failed to start: ${String(error)}`)
  process.exit(1)
})
