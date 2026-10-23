import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { loadCatalog, packageVersion } from '../src/catalog.js'
import { answerOffline } from '../src/offline.js'

const catalog = loadCatalog()
const reason = 'Cannot reach Snipaya. Is Snipaya open?'
const offline = { catalog, version: '1.2.3', reason }

const request = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 7,
  method,
  ...(params ? { params } : {})
})

describe('loadCatalog', () => {
  it('reads the committed catalog', () => {
    expect(catalog.tools).toHaveLength(28)
    expect(catalog.prompts).toHaveLength(6)
    expect(catalog.instructions).not.toBe('')
  })

  it('reads the package version', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('answerOffline', () => {
  it('completes initialize with the catalog instructions', () => {
    const reply = answerOffline(
      request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }),
      offline
    )
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
        serverInfo: { name: 'snipaya', title: 'Snipaya', version: '1.2.3' },
        instructions: catalog.instructions
      }
    })
  })

  it('offers the latest protocol version when the client asks for an unknown one', () => {
    const reply = answerOffline(
      request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
      offline
    )
    expect(reply).toMatchObject({ result: { protocolVersion: LATEST_PROTOCOL_VERSION } })
  })

  it('lists the catalog tools and prompts', () => {
    expect(answerOffline(request('tools/list'), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { tools: catalog.tools }
    })
    expect(answerOffline(request('prompts/list'), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { prompts: catalog.prompts }
    })
  })

  it('answers ping', () => {
    expect(answerOffline(request('ping'), offline)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('answers a tool call with an error result that says what to do', () => {
    expect(answerOffline(request('tools/call', { name: 'snipaya_get_canvas', arguments: {} }), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: reason }], isError: true }
    })
  })

  it('answers a prompt request with an error that says what to do', () => {
    expect(answerOffline(request('prompts/get', { name: 'explain_bug' }), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32000, message: reason }
    })
  })

  it('rejects tools and prompts that are not in the catalog', () => {
    expect(answerOffline(request('tools/call', { name: 'nope' }), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32602, message: 'Tool nope not found' }
    })
    expect(answerOffline(request('prompts/get', { name: 'nope' }), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32602, message: 'Prompt nope not found' }
    })
  })

  it('rejects other methods as not found', () => {
    expect(answerOffline(request('resources/list'), offline)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not found' }
    })
  })
})
