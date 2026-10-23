import { z } from 'zod'

export const MCP_PROMPTS = {
  tidy_up: {
    title: 'Tidy up',
    description: 'Remove clutter from the canvas.',
    args: { focus: z.string().max(500).optional().describe('What to keep.') },
    text: ({ focus }: { focus?: string }) => (focus ? `Tidy up, keep ${focus}.` : 'Tidy up.')
  }
} as const

export const promptText = (name: keyof typeof MCP_PROMPTS, args: Record<string, string | undefined>): string =>
  MCP_PROMPTS[name].text(args)
