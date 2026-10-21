import { parseArgs } from 'node:util'

export const DEFAULT_URL = 'http://127.0.0.1:47321/mcp'

const SETTINGS = 'Snipaya > Settings > AI Assistants'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

export const USAGE = `Usage: snipaya-mcp [--url <url>] [--token <token>]

Bridges an MCP client that speaks stdio to the MCP server built into Snipaya.

  --url    Snipaya MCP URL (env SNIPAYA_MCP_URL, default ${DEFAULT_URL})
  --token  Snipaya MCP token (env SNIPAYA_MCP_TOKEN, required)

Turn the server on and copy both values in ${SETTINGS}.`

export class ConfigError extends Error {}

export type Config = { kind: 'run'; url: URL; token: string } | { kind: 'help' }

const present = (...values: (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value.trim() !== '')?.trim()

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

export const resolveConfig = (argv: string[], env: NodeJS.ProcessEnv): Config => {
  const flags = parseFlags(argv)
  if (flags.help) return { kind: 'help' }
  const token = present(flags.token, env.SNIPAYA_MCP_TOKEN)?.replace(/^bearer\s+/i, '')
  if (!token) {
    throw new ConfigError(
      `SNIPAYA_MCP_TOKEN is not set. Turn on the MCP server in ${SETTINGS} and copy the token.`
    )
  }
  return { kind: 'run', url: parseUrl(present(flags.url, env.SNIPAYA_MCP_URL) ?? DEFAULT_URL), token }
}
