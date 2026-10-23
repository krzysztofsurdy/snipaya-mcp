import { readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { join, resolve } from 'node:path'
import { argv, exit, stderr } from 'node:process'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readJson } from './metadata.mjs'

const resolveTypeScriptImports = `
export const resolve = async (specifier, context, next) => {
  try {
    return await next(specifier, context)
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../')
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !relative || /\\.[cm]?[jt]s$/.test(specifier)) throw error
    return next(\`\${specifier}.ts\`, context)
  }
}
`

register(`data:text/javascript,${encodeURIComponent(resolveTypeScriptImports)}`)

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const fail = (message) => {
  stderr.write(`${message}\n`)
  exit(1)
}

const namedSet = (source, name, file) => {
  const match = new RegExp(`const ${name}\\b[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)
  if (!match) throw new Error(`${file} has no ${name} set`)
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value))
}

const loadApp = async (app) => {
  const tools = await import(pathToFileURL(join(app, 'src/shared/mcpTools.ts')).href)
  const prompts = await import(pathToFileURL(join(app, 'src/main/mcp/prompts.ts')).href)
  const serverFile = join(app, 'src/main/mcp/server.ts')
  const server = readFileSync(serverFile, 'utf8')
  return {
    version: readJson(join(app, 'package.json')).version,
    tools: tools.MCP_TOOLS,
    instructions: tools.MCP_INSTRUCTIONS,
    prompts: prompts.MCP_PROMPTS,
    promptText: prompts.promptText,
    destructive: namedSet(server, 'DESTRUCTIVE', serverFile),
    openWorld: namedSet(server, 'OPEN_WORLD', serverFile)
  }
}

const serve = (app) => {
  const mcp = new McpServer({ name: 'snipaya', title: 'Snipaya', version: app.version }, { instructions: app.instructions })
  for (const [name, tool] of Object.entries(app.tools)) {
    mcp.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: app.destructive.has(name),
          openWorldHint: app.openWorld.has(name)
        }
      },
      () => ({ content: [] })
    )
  }
  for (const [name, prompt] of Object.entries(app.prompts)) {
    mcp.registerPrompt(name, { title: prompt.title, description: prompt.description, argsSchema: prompt.args }, (values) => ({
      messages: [{ role: 'user', content: { type: 'text', text: app.promptText(name, values) } }]
    }))
  }
  return mcp
}

const listCatalog = async (app) => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const mcp = serve(app)
  await mcp.connect(serverSide)
  const client = new Client({ name: 'sync-catalog', version: '1.0.0' })
  await client.connect(clientSide)
  try {
    const { tools } = await client.listTools()
    const { prompts } = await client.listPrompts()
    const texts = {}
    for (const { name } of prompts) {
      const { messages } = await client.getPrompt({ name, arguments: {} })
      texts[name] = messages.map((message) => message.content.text).join('\n')
    }
    return { instructions: client.getInstructions(), tools, prompts, texts }
  } finally {
    await client.close()
    await mcp.close()
  }
}

const appDir = resolve(argv[2] ?? '../snipaya')

let app
try {
  app = await loadApp(appDir)
} catch (error) {
  fail(`Cannot load the Snipaya MCP definitions from ${appDir}: ${error instanceof Error ? error.message : String(error)}`)
}

const { instructions, tools, prompts, texts } = await listCatalog(app)

writeJson('catalog.json', { snipaya: app.version, instructions, tools, prompts })

const manifest = readJson('manifest.json')
manifest.tools = tools.map(({ name, description }) => ({ name, description }))
manifest.tools_generated = true
manifest.prompts = prompts.map(({ name, description, arguments: args = [] }) => ({
  name,
  description,
  arguments: args.map((arg) => arg.name),
  text: texts[name]
}))
manifest.prompts_generated = true
writeJson('manifest.json', manifest)
