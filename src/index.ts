#!/usr/bin/env node
import { startBridge } from './bridge.js'
import { ConfigError, resolveConfig, USAGE } from './config.js'

const write = (line: string): void => {
  process.stderr.write(`snipaya-mcp: ${line}\n`)
}

const main = async (): Promise<void> => {
  const config = resolveConfig(process.argv.slice(2), process.env)
  if (config.kind === 'help') {
    process.stderr.write(`${USAGE}\n`)
    return
  }
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
