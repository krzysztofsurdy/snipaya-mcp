import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  isInitializeRequest,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export interface TestServer {
  url: string
  origins: (string | undefined)[]
  authorizations: (string | undefined)[]
  rootsChanged: number
  streams: number
  deletes: number
  close: () => Promise<void>
}

const sendError = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const createMcp = (state: TestServer): McpServer => {
  const mcp = new McpServer(
    { name: 'fixture', version: '0.0.0' },
    { capabilities: { logging: {} } }
  )
  mcp.registerTool(
    'echo',
    { title: 'Echo', description: 'Echo text back', inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: 'text', text }] })
  )
  mcp.registerTool('log', { description: 'Send a log notification' }, async (extra) => {
    await extra.sendNotification({
      method: 'notifications/message',
      params: { level: 'info', data: 'hello from the server' }
    })
    return { content: [{ type: 'text', text: 'logged' }] }
  })
  mcp.registerTool('roots', { description: 'Ask the client for its roots' }, async (extra) => {
    const { roots } = await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema)
    return { content: [{ type: 'text', text: roots.map((root) => root.uri).join(',') }] }
  })
  mcp.registerTool('announce', { description: 'Announce a tool list change' }, () => {
    mcp.sendToolListChanged()
    return { content: [{ type: 'text', text: 'announced' }] }
  })
  mcp.registerTool('boom', { description: 'Always fails' }, () => {
    throw new Error('boom failed')
  })
  mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    state.rootsChanged += 1
  })
  return mcp
}

export const startTestServer = async (token: string): Promise<TestServer> => {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const state: TestServer = {
    url: '',
    origins: [],
    authorizations: [],
    rootsChanged: 0,
    streams: 0,
    deletes: 0,
    close: async () => undefined
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    state.origins.push(req.headers.origin)
    state.authorizations.push(req.headers.authorization)
    if (req.url !== '/mcp') return sendError(res, 404, 'Not found')
    if (req.headers.origin !== undefined) return sendError(res, 403, 'Forbidden origin')
    if (req.headers.authorization !== `Bearer ${token}`) return sendError(res, 401, 'Unauthorized')
    if (req.method === 'DELETE') state.deletes += 1
    if (req.method === 'GET') state.streams += 1

    const body = req.method === 'POST' ? await readBody(req) : undefined
    const sessionId = req.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const transport = sessions.get(sessionId)
      if (!transport) return sendError(res, 404, 'Session not found')
      return transport.handleRequest(req, res, body)
    }
    if (!isInitializeRequest(body)) return sendError(res, 400, 'No valid session')
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, transport)
      }
    })
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    await createMcp(state).connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal error')
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  state.url = `http://127.0.0.1:${port}/mcp`
  state.close = async () => {
    await Promise.all([...sessions.values()].map((transport) => transport.close()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
  return state
}

export const unusedPort = async (): Promise<number> => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
