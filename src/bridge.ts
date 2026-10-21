import type { Readable, Writable } from 'node:stream'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId
} from '@modelcontextprotocol/sdk/types.js'

const SETTINGS = 'Snipaya > Settings > AI Assistants'

const CLOSE_TIMEOUT_MS = 1000

export interface BridgeOptions {
  url: URL
  token: string
  stdin?: Readable
  stdout?: Writable
  log: (line: string) => void
  licenseAccepted?: () => Promise<boolean>
}

export interface Bridge {
  close: () => Promise<void>
}

const isUnreachable = (error: unknown): boolean =>
  error instanceof TypeError && error.message === 'fetch failed'

export const describeError = (error: unknown, url: URL, licensePending = false): string => {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) {
      return `Snipaya rejected the token. Remove SNIPAYA_MCP_TOKEN to use the token Snipaya saved, or copy the current one from ${SETTINGS}.`
    }
    if (error.code === 404 && error.message.includes('Session not found')) {
      return 'Snipaya ended the session because the app restarted or the token changed. Restart the snipaya server in your MCP client.'
    }
    if (error.code === 404) return `Snipaya has no MCP endpoint at ${url}. Copy the URL from ${SETTINGS}.`
    if (error.code === 403) return `Snipaya refused the request. Use the URL shown in ${SETTINGS}.`
  }
  if (isUnreachable(error) && licensePending) {
    return `Cannot reach Snipaya at ${url}. Its MCP server starts only after you accept the license agreement: open Snipaya, accept it, then restart the snipaya server in your MCP client. If Snipaya shows no agreement, turn on the MCP server in ${SETTINGS}.`
  }
  if (isUnreachable(error)) {
    return `Cannot reach Snipaya at ${url}. Is Snipaya open? Turn on the MCP server in ${SETTINGS} and check the URL there.`
  }
  return `Snipaya MCP request failed: ${error instanceof Error ? error.message : String(error)}`
}

export const startBridge = async (options: BridgeOptions): Promise<Bridge> => {
  const { url, log } = options
  const stdio = new StdioServerTransport(options.stdin, options.stdout)
  const http = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } }
  })
  const initializeIds = new Set<RequestId>()

  const explain = async (error: unknown): Promise<string> => {
    const licensePending =
      isUnreachable(error) && options.licenseAccepted !== undefined && !(await options.licenseAccepted())
    return describeError(error, url, licensePending)
  }

  const forwardToClient = (message: JSONRPCMessage): void => {
    stdio.send(message).catch((error: unknown) => log(`Cannot write to the MCP client: ${String(error)}`))
  }

  stdio.onmessage = (message) => {
    if (isJSONRPCRequest(message) && message.method === 'initialize') initializeIds.add(message.id)
    http.send(message).catch(async (error: unknown) => {
      if (!isJSONRPCRequest(message)) return
      forwardToClient({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: await explain(error) }
      })
    })
  }

  http.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
      const version = message.result.protocolVersion
      if (typeof version === 'string') http.setProtocolVersion(version)
    }
    forwardToClient(message)
  }

  let closing: Promise<void> | undefined
  http.onerror = (error) => {
    void explain(error).then((line) => {
      if (!closing) log(line)
    })
  }
  stdio.onerror = (error) => log(`MCP client stream error: ${error.message}`)

  await http.start()
  await stdio.start()

  return {
    close: () => {
      closing ??= (async () => {
        const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())
        await Promise.race([http.terminateSession().catch(() => undefined), timeout])
        await http.close()
        await stdio.close()
      })()
      return closing
    }
  }
}
