import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ConfigError, type RunConfig } from './config.js'

export const BUNDLE_ID = 'dev.snipaya.app'

const SETTINGS = 'Snipaya > Settings > AI Assistants'

const LAUNCH_TIMEOUT_MS = 10_000

const POLL_INTERVAL_MS = 250

const PROBE_TIMEOUT_MS = 1000

export type Reachability = 'answered' | 'refused' | 'unreachable'

export interface LaunchDeps {
  platform: NodeJS.Platform
  probe: (url: URL) => Promise<Reachability>
  launch: () => Promise<void>
  reload: () => Promise<RunConfig>
  licenseAccepted: () => Promise<boolean>
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

type RunFile = (file: string, args: string[]) => Promise<unknown>

const isRefused = (error: unknown): boolean =>
  (error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED'

export const probeUrl = async (url: URL, timeoutMs = PROBE_TIMEOUT_MS): Promise<Reachability> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    await response.body?.cancel()
    return 'answered'
  } catch (error) {
    return isRefused(error) ? 'refused' : 'unreachable'
  }
}

export const openSnipaya = async (run: RunFile = promisify(execFile)): Promise<void> => {
  await run('open', ['-g', '-b', BUNDLE_ID])
}

export const ensureSnipaya = async (config: RunConfig, deps: LaunchDeps): Promise<RunConfig> => {
  if (!config.autoLaunch || deps.platform !== 'darwin') return config
  if ((await deps.probe(config.url)) !== 'refused') return config
  deps.log('Snipaya is not running. Opening it in the background.')
  try {
    await deps.launch()
  } catch {
    throw new ConfigError(`Cannot open Snipaya (${BUNDLE_ID}). Install it from https://snipaya.app or open it yourself.`)
  }
  const deadline = deps.now() + LAUNCH_TIMEOUT_MS
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS)
    const current = await deps.reload()
    if ((await deps.probe(current.url)) === 'answered') return current
  }
  if (!(await deps.licenseAccepted())) {
    throw new ConfigError(
      `Opened Snipaya, but its MCP server starts only after you accept the license agreement. Accept it in Snipaya, then restart the snipaya server in your MCP client. If Snipaya shows no agreement, check the status in ${SETTINGS}.`
    )
  }
  throw new ConfigError(
    `Opened Snipaya, but its MCP server did not answer within ${LAUNCH_TIMEOUT_MS / 1000} s. Check the status in ${SETTINGS}.`
  )
}
