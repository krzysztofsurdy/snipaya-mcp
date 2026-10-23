import type { Readable, Writable } from 'node:stream'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId
} from '@modelcontextprotocol/sdk/types.js'
import type { Catalog } from './catalog.js'
import { answerOffline } from './offline.js'

const SETTINGS = 'Snipaya > Settings > AI Assistants'

const CLOSE_TIMEOUT_MS = 1000

const RECONNECT_TIMEOUT_MS = 5000

const RECONNECT_ID = 'snipaya-mcp-reconnect'

const RECONNECT_METHODS = new Set(['tools/call', 'prompts/get'])

const FROM_CATALOG = "Listing Snipaya's tools from the built-in catalog until Snipaya answers."

export interface Connection {
  url: URL
  token: string
}

export interface BridgeOptions {
  connection: Connection | string
  reconnect?: () => Promise<Connection | string>
  catalog: Catalog
  version: string
  stdin?: Readable
  stdout?: Writable
  log: (line: string) => void
  licenseAccepted?: () => Promise<boolean>
}

export interface Bridge {
  close: () => Promise<void>
}

type Mode = 'connecting' | 'forwarding' | 'offline'

const isUnreachable = (error: unknown): boolean =>
  error instanceof TypeError && error.message === 'fetch failed'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const unreachableMessage = (url: URL, licensePending: boolean): string =>
  licensePending
    ? `Cannot reach Snipaya at ${url}. Its MCP server starts only after you accept the license agreement: open Snipaya, accept it, then restart the snipaya server in your MCP client. If Snipaya shows no agreement, turn on the MCP server in ${SETTINGS}.`
    : `Cannot reach Snipaya at ${url}. Is Snipaya open? Turn on the MCP server in ${SETTINGS} and check the URL there.`

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
  if (isUnreachable(error)) return unreachableMessage(url, licensePending)
  return `Snipaya MCP request failed: ${messageOf(error)}`
}

const createTransport = ({ url, token }: Connection): StreamableHTTPClientTransport =>
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })

const within = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const startBridge = async (options: BridgeOptions): Promise<Bridge> => {
  const { log, catalog, version } = options
  const stdio = new StdioServerTransport(options.stdin, options.stdout)
  const initializeIds = new Set<RequestId>()
  let connection = typeof options.connection === 'string' ? undefined : options.connection
  let http = connection ? createTransport(connection) : undefined
  let reason = typeof options.connection === 'string' ? options.connection : ''
  let mode: Mode = http ? 'connecting' : 'offline'
  let initializeParams: JSONRPCRequest['params']
  let pending: Promise<void> = Promise.resolve()
  let queued = 0
  let closing: Promise<void> | undefined

  const explain = async (error: unknown, url: URL): Promise<string> => {
    const licensePending =
      isUnreachable(error) && options.licenseAccepted !== undefined && !(await options.licenseAccepted())
    return describeError(error, url, licensePending)
  }

  const forwardToClient = (message: JSONRPCMessage): void => {
    stdio.send(message).catch((error: unknown) => log(`Cannot write to the MCP client: ${String(error)}`))
  }

  const errorReply = (id: RequestId, message: string): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message }
  })

  const wire = (transport: StreamableHTTPClientTransport, url: URL): void => {
    transport.onmessage = (message) => {
      if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
        const negotiated = message.result.protocolVersion
        if (typeof negotiated === 'string') transport.setProtocolVersion(negotiated)
      }
      forwardToClient(message)
    }
    transport.onerror = (error) => {
      void explain(error, url).then((line) => {
        if (!closing) log(line)
      })
    }
  }

  const forward = (message: JSONRPCMessage): void => {
    if (!http || !connection) return
    const { url } = connection
    if (isJSONRPCRequest(message) && message.method === 'initialize') initializeIds.add(message.id)
    http.send(message).catch(async (error: unknown) => {
      if (!isJSONRPCRequest(message)) return
      forwardToClient(errorReply(message.id, await explain(error, url)))
    })
  }

  const answerFromCatalog = (request: JSONRPCRequest): void => {
    forwardToClient(answerOffline(request, { catalog, version, reason }))
  }

  const goOffline = async (): Promise<void> => {
    const transport = http
    http = undefined
    connection = undefined
    mode = 'offline'
    log(FROM_CATALOG)
    await transport?.close().catch(() => undefined)
  }

  const connectFirst = async (message: JSONRPCMessage): Promise<void> => {
    if (!http || !connection || !isJSONRPCRequest(message) || message.method !== 'initialize') {
      mode = 'forwarding'
      forward(message)
      return
    }
    initializeParams = message.params
    initializeIds.add(message.id)
    try {
      await http.send(message)
      mode = 'forwarding'
    } catch (error) {
      initializeIds.delete(message.id)
      if (!isUnreachable(error)) {
        mode = 'forwarding'
        forwardToClient(errorReply(message.id, await explain(error, connection.url)))
        return
      }
      reason = await explain(error, connection.url)
      await goOffline()
      answerFromCatalog(message)
    }
  }

  const initializeSnipaya = async (transport: StreamableHTTPClientTransport): Promise<void> => {
    const reply = new Promise<JSONRPCMessage>((resolve) => {
      transport.onmessage = (message) => {
        if ('id' in message && message.id === RECONNECT_ID) resolve(message)
      }
    })
    await transport.start()
    await transport.send({
      jsonrpc: '2.0',
      id: RECONNECT_ID,
      method: 'initialize',
      params: initializeParams ?? {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'snipaya-mcp', version }
      }
    })
    const response = await within(
      reply,
      RECONNECT_TIMEOUT_MS,
      `Snipaya did not answer within ${RECONNECT_TIMEOUT_MS / 1000} s.`
    )
    if (!isJSONRPCResultResponse(response)) {
      throw new Error('error' in response ? response.error.message : 'Snipaya sent an unexpected answer.')
    }
    const negotiated = response.result.protocolVersion
    if (typeof negotiated === 'string') transport.setProtocolVersion(negotiated)
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  const reconnect = async (): Promise<boolean> => {
    if (!options.reconnect) return false
    let found: Connection | string
    try {
      found = await options.reconnect()
    } catch (error) {
      reason = messageOf(error)
      return false
    }
    if (typeof found === 'string') {
      reason = found
      return false
    }
    const transport = createTransport(found)
    try {
      await initializeSnipaya(transport)
    } catch (error) {
      reason = await explain(error, found.url)
      log(reason)
      await transport.close().catch(() => undefined)
      return false
    }
    http = transport
    connection = found
    wire(transport, found.url)
    mode = 'forwarding'
    log('Snipaya answers now. Forwarding every message to it.')
    forwardToClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    forwardToClient({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })
    return true
  }

  const answer = async (message: JSONRPCMessage): Promise<void> => {
    if (!isJSONRPCRequest(message)) return
    if (message.method === 'initialize') initializeParams = message.params
    if (RECONNECT_METHODS.has(message.method) && (await reconnect())) {
      forward(message)
      return
    }
    answerFromCatalog(message)
  }

  const route = async (message: JSONRPCMessage): Promise<void> => {
    if (mode === 'forwarding') forward(message)
    else if (mode === 'connecting') await connectFirst(message)
    else await answer(message)
  }

  stdio.onmessage = (message) => {
    if (mode === 'forwarding' && queued === 0) {
      forward(message)
      return
    }
    queued += 1
    pending = pending
      .then(() => route(message))
      .catch((error: unknown) => log(`Cannot handle a message from the MCP client: ${messageOf(error)}`))
      .finally(() => {
        queued -= 1
      })
  }
  stdio.onerror = (error) => log(`MCP client stream error: ${error.message}`)

  if (http && connection) {
    wire(http, connection.url)
    await http.start()
  } else {
    log(reason)
    log(FROM_CATALOG)
  }
  await stdio.start()

  return {
    close: () => {
      closing ??= (async () => {
        const transport = http
        if (transport) {
          const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())
          await Promise.race([transport.terminateSession().catch(() => undefined), timeout])
          await transport.close()
        }
        await stdio.close()
      })()
      return closing
    }
  }
}
