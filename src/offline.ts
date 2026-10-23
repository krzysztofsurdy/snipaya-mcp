import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type JSONRPCRequest
} from '@modelcontextprotocol/sdk/types.js'
import type { Catalog } from './catalog.js'

export interface Offline {
  catalog: Catalog
  version: string
  reason: string
}

const UNAVAILABLE = -32000
const INVALID_PARAMS = -32602
const METHOD_NOT_FOUND = -32601

const negotiate = (requested: unknown): string =>
  typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION

const has = (entries: { name: string }[], name: unknown): boolean => entries.some((entry) => entry.name === name)

export const answerOffline = (request: JSONRPCRequest, { catalog, version, reason }: Offline): JSONRPCMessage => {
  const { id, params } = request
  const result = (value: Record<string, unknown>): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: value })
  const error = (code: number, message: string): JSONRPCMessage => ({ jsonrpc: '2.0', id, error: { code, message } })
  const name = params?.name
  switch (request.method) {
    case 'initialize':
      return result({
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
        serverInfo: { name: 'snipaya', title: 'Snipaya', version },
        instructions: catalog.instructions
      })
    case 'ping':
      return result({})
    case 'tools/list':
      return result({ tools: catalog.tools })
    case 'prompts/list':
      return result({ prompts: catalog.prompts })
    case 'tools/call':
      return has(catalog.tools, name)
        ? result({ content: [{ type: 'text', text: reason }], isError: true })
        : error(INVALID_PARAMS, `Tool ${String(name)} not found`)
    case 'prompts/get':
      return has(catalog.prompts, name)
        ? error(UNAVAILABLE, reason)
        : error(INVALID_PARAMS, `Prompt ${String(name)} not found`)
    default:
      return error(METHOD_NOT_FOUND, 'Method not found')
  }
}
