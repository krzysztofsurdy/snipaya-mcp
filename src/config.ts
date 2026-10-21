import { parseArgs } from 'node:util'
import type { Settings } from './settings.js'

export const DEFAULT_URL = 'http://127.0.0.1:47321/mcp'

const SETTINGS = 'Snipaya > Settings > AI Assistants'

const TURN_ON = `turn on Allow AI assistants in ${SETTINGS}`

const OR_SET_TOKEN = 'Or set SNIPAYA_MCP_TOKEN to the access token shown there.'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

const UNFILLED_PLACEHOLDER = /^\$\{user_config\.[^}]*\}$/

export const USAGE = `Usage: snipaya-mcp [--url <url>] [--token <token>]

Bridges an MCP client that speaks stdio to the MCP server built into Snipaya.

  --url    Snipaya MCP URL (env SNIPAYA_MCP_URL, default: the port Snipaya saved, else ${DEFAULT_URL})
  --token  Snipaya MCP token (env SNIPAYA_MCP_TOKEN, default: the token Snipaya saved)

With no options the bridge reads the token and port from Snipaya, and opens Snipaya
in the background when it is not running. Set SNIPAYA_MCP_NO_LAUNCH=1 to never open it.

Turn the server on in ${SETTINGS}.`

export class ConfigError extends Error {}

export type RunConfig = { kind: 'run'; url: URL; token: string; autoLaunch: boolean; savedServerOn: boolean }

export type Config = RunConfig | { kind: 'help' }

const present = (...values: (string | undefined)[]): string | undefined =>
  values
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value !== '' && !UNFILLED_PLACEHOLDER.test(value))

const isOptOut = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
}

const parseFlags = (argv: string[]) => {
  try {
    return parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }).values
  } catch (error) {
    throw new ConfigError(`${(error as Error).message}. Run snipaya-mcp --help for usage.`)
  }
}

const parseUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`SNIPAYA_MCP_URL is not a valid URL. Copy it from ${SETTINGS}.`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(
      `Refusing ${url.host}: snipaya-mcp only connects to 127.0.0.1 or localhost. Copy the URL from ${SETTINGS}.`
    )
  }
  if (url.protocol !== 'http:') {
    throw new ConfigError(`Snipaya serves MCP over http://, not ${url.protocol}//. Copy the URL from ${SETTINGS}.`)
  }
  return url
}

const savedToken = (settings: Settings): string => {
  if (settings.kind === 'missing') {
    throw new ConfigError(
      `No token set, and Snipaya's settings were not found at ${settings.file}. Install Snipaya, open it, then ${TURN_ON}. ${OR_SET_TOKEN}`
    )
  }
  if (settings.kind === 'unreadable') {
    throw new ConfigError(
      `No token set, and Snipaya's settings at ${settings.file} cannot be read: ${settings.reason}. Open Snipaya, then ${TURN_ON}. ${OR_SET_TOKEN}`
    )
  }
  if (!settings.enabled) {
    throw new ConfigError(`Snipaya's MCP server is off. Turn on Allow AI assistants in ${SETTINGS}.`)
  }
  if (settings.token === undefined) {
    throw new ConfigError(
      `Snipaya's settings at ${settings.file} hold no valid token. Open Snipaya to create one. ${OR_SET_TOKEN}`
    )
  }
  return settings.token
}

const savedUrl = (settings: Settings): string =>
  settings.kind === 'found' && settings.port !== undefined
    ? `http://127.0.0.1:${settings.port}/mcp`
    : DEFAULT_URL

export const resolveConfig = (argv: string[], env: NodeJS.ProcessEnv, settings: Settings): Config => {
  const flags = parseFlags(argv)
  if (flags.help) return { kind: 'help' }
  const token = present(flags.token, env.SNIPAYA_MCP_TOKEN)?.replace(/^bearer\s+/i, '') ?? savedToken(settings)
  const savedServerOn = settings.kind === 'found' && settings.enabled
  return {
    kind: 'run',
    url: parseUrl(present(flags.url, env.SNIPAYA_MCP_URL) ?? savedUrl(settings)),
    token,
    autoLaunch: savedServerOn && !isOptOut(env.SNIPAYA_MCP_NO_LAUNCH),
    savedServerOn
  }
}
