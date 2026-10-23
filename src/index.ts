#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises'
import { startBridge, unreachableMessage, type Connection } from './bridge.js'
import { loadCatalog, packageVersion } from './catalog.js'
import { ConfigError, resolveConfig, UnavailableError, USAGE, type Config, type RunConfig } from './config.js'
import { ensureSnipaya, openSnipaya, probeUrl, type LaunchDeps } from './launch.js'
import { licenseAccepted, licenseFile, readSettings, settingsFile } from './settings.js'

const NOT_MAC =
  'Snipaya is a macOS app. Install it on a Mac from https://snipaya.app, open it and turn on Allow AI assistants in Snipaya > Settings > AI Assistants.'

const write = (line: string): void => {
  process.stderr.write(`snipaya-mcp: ${line}\n`)
}

const savedLicenseAccepted = (): Promise<boolean> => licenseAccepted(licenseFile())

const unavailable = (error: unknown): string => {
  if (!(error instanceof UnavailableError)) throw error
  return process.platform === 'darwin' ? error.message : NOT_MAC
}

const connectionOf = ({ url, token }: RunConfig): Connection => ({ url, token })

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const tokens = new Set<string>()
  const log = (line: string): void =>
    write([...tokens].reduce((text, token) => text.replaceAll(token, '[token]'), line))
  const load = async (): Promise<Config> => resolveConfig(argv, process.env, await readSettings(settingsFile()))
  const loadRun = async (): Promise<RunConfig> => {
    const config = await load()
    if (config.kind !== 'run') throw new ConfigError('Expected a run configuration.')
    tokens.add(config.token)
    return config
  }

  let initial: Config | string
  try {
    initial = await load()
  } catch (error) {
    initial = unavailable(error)
  }
  if (typeof initial !== 'string' && initial.kind === 'help') {
    process.stderr.write(`${USAGE}\n`)
    return
  }

  const launchDeps: LaunchDeps = {
    platform: process.platform,
    probe: probeUrl,
    launch: () => openSnipaya(),
    reload: loadRun,
    licenseAccepted: savedLicenseAccepted,
    now: Date.now,
    sleep: (ms) => sleep(ms),
    log
  }

  let connection: Connection | string = typeof initial === 'string' ? initial : connectionOf(initial)
  if (typeof initial !== 'string') {
    tokens.add(initial.token)
    try {
      connection = connectionOf(await ensureSnipaya(initial, launchDeps))
    } catch (error) {
      connection = unavailable(error)
    }
  }

  const reconnect = async (): Promise<Connection | string> => {
    let config: RunConfig
    try {
      config = await ensureSnipaya(await loadRun(), launchDeps)
    } catch (error) {
      return unavailable(error)
    }
    if ((await probeUrl(config.url)) === 'answered') return connectionOf(config)
    return unreachableMessage(config.url, config.savedServerOn && !(await savedLicenseAccepted()))
  }

  const savedServerOn = typeof initial !== 'string' && initial.savedServerOn
  const bridge = await startBridge({
    connection,
    reconnect,
    catalog: loadCatalog(),
    version: packageVersion(),
    log,
    ...(savedServerOn ? { licenseAccepted: savedLicenseAccepted } : {})
  })
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
