import { z } from 'zod'

export const MCP_TOOLS = {
  snipaya_look: {
    title: 'Look',
    description: 'Look at the canvas.',
    input: z.object({ tabId: z.string().optional().describe('Target tab id.') }),
    readOnly: true
  },
  snipaya_wipe: {
    title: 'Wipe',
    description: 'Wipe elements.',
    input: z
      .object({ ids: z.array(z.string()).min(1), mode: z.enum(['soft', 'hard']).default('soft') })
      .refine((args) => args.ids.length < 100, { message: 'Too many ids' }),
    readOnly: false
  }
} as const

export const MCP_INSTRUCTIONS = ['Look first.', 'Wipe with care.'].join('\n')
