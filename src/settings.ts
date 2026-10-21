import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Settings =
  | { kind: 'found'; file: string; enabled: boolean; token?: string; port?: number }
  | { kind: 'missing'; file: string }
  | { kind: 'unreadable'; file: string; reason: string }

const TOKEN = /^[0-9a-f]{64}$/

const userData = (home: string): string => join(home, 'Library', 'Application Support', 'Snipaya')

export const settingsFile = (home: string = homedir()): string => join(userData(home), 'mcp.json')

export const licenseFile = (home: string = homedir()): string => join(userData(home), 'eula.json')

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? 'unknown error'

export const readSettings = async (file: string): Promise<Settings> => {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' ? { kind: 'missing', file } : { kind: 'unreadable', file, reason: code }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', file, reason: 'it is not valid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'unreadable', file, reason: 'it is not a JSON object' }
  }
  const { enabled, token, port } = raw as Record<string, unknown>
  return {
    kind: 'found',
    file,
    enabled: enabled === true,
    ...(typeof token === 'string' && TOKEN.test(token) ? { token } : {}),
    ...(isPort(port) ? { port } : {})
  }
}

export const licenseAccepted = async (file: string): Promise<boolean> => {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return false
    const { version, acceptedAt } = raw as Record<string, unknown>
    return typeof version === 'string' && typeof acceptedAt === 'number'
  } catch {
    return false
  }
}
