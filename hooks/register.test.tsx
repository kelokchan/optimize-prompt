import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const userMsg = (n: number) => ({ role: 'user' as const, text: `msg ${n}`, toolUses: [] })
const toolMsg = (file: string) => ({
  role: 'assistant' as const,
  text: '',
  toolUses: [
    { tool_use_id: 'a', tool: 'Edit', input: { file_path: file }, text: 'updated' },
    { tool_use_id: 'b', tool: 'Bash', input: { command: 'false' }, text: 'exit 1', isError: true as const },
  ],
})

// 9 text rows keep the last 8; tool calls inside that window ride along, the one
// before it (/old.tsx) does not; an empty row with no tool calls is skipped.
const noisyTranscript = (on: On) =>
  on('session.messages', () => ({
    value: [
      userMsg(0),
      toolMsg('/old.tsx'),
      ...[1, 2, 3, 4, 5, 6, 7].map(userMsg),
      toolMsg('/a/b.tsx'),
      userMsg(8),
      { role: 'assistant' as const, text: '', toolUses: [] },
    ],
  }))

// Answers prompt.read with each draft in turn, records model calls and fills.
const world = (on: On, drafts: string[]) => {
  const seen = { models: [] as string[], prompts: [] as string[], fills: [] as { text: string; mode: string }[] }
  let i = 0
  noisyTranscript(on)
  on('prompt.read', () => ({ value: { text: drafts[Math.min(i++, drafts.length - 1)] ?? '', cursor: 0 } }))
  on('model.complete', (_$, e) => {
    seen.models.push(e.model)
    seen.prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: '  Better prompt\n', usage: {} as never } }
  })
  on('prompt.fill', (_$, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  return seen
}

test('rewrites the draft with haiku, on every surface', async ($, on) => {
  const seen = world(on, ['fix the bug'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'optimize-prompt', surface, ...BAND })
    await ui.press({ key: 'optimize' })
    await ui.unmount()
  }
  expect(seen.models).toEqual(['haiku', 'haiku'])
  expect(seen.prompts[0]).toContain('<conversation>\nuser: msg 1\n\n')
  expect(seen.prompts[0]).not.toContain('msg 0')
  expect(seen.prompts[0]).not.toContain('/old.tsx')
  expect(seen.prompts[0]).toContain(
    'user: msg 7\n\ntool Edit({"file_path":"/a/b.tsx"}) → updated\ntool Bash({"command":"false"}) → error: exit 1\n\nuser: msg 8',
  )
  expect(seen.prompts[0]).toContain('user: msg 8\n</conversation>\n\n<draft>\nfix the bug\n</draft>')
  expect(seen.fills).toEqual([
    { text: 'Better prompt', mode: 'replace' },
    { text: 'Better prompt', mode: 'replace' },
  ])
})

test('empty draft never calls the model', async ($, on) => {
  const seen = world(on, ['   '])
  const ui = await $.ui.mount({ plugin: 'optimize-prompt', surface: 'terminal', ...BAND })
  await ui.press({ key: 'optimize' })
  await ui.unmount()
  expect(seen.models).toEqual([])
  expect(seen.fills).toEqual([])
})

test('keeps a draft edited while the model ran', async ($, on) => {
  const seen = world(on, ['fix the bug', 'fix the bug please'])
  const ui = await $.ui.mount({ plugin: 'optimize-prompt', surface: 'terminal', ...BAND })
  await ui.press({ key: 'optimize' })
  await ui.unmount()
  expect(seen.models).toEqual(['haiku'])
  expect(seen.fills).toEqual([])
})

test('spinner shows while the model runs, hides on success and failure', async ($, on) => {
  const SPIN = { type: 'Text', text: /Optimizing prompt/ } as const
  const shown: boolean[] = []
  let ui: Awaited<ReturnType<typeof $.ui.mount<'terminal', 'AbovePrompt'>>>
  let answered = true
  noisyTranscript(on)
  on('prompt.read', () => ({ value: { text: 'fix the bug', cursor: 0 } }))
  on('prompt.fill', (_$, e) => ({ isFilled: true, text: e.text, cursor: 0 }))
  on('model.complete', async () => {
    shown.push((await ui.find(SPIN)) !== undefined && (await ui.find({ key: 'optimize' })) === undefined)
    return {
      value: answered
        ? { isAnswered: true as const, text: 'Better', usage: {} as never }
        : { isAnswered: false as const, reason: 'empty-reply' as const, usage: {} as never },
    }
  })
  ui = await $.ui.mount({ plugin: 'optimize-prompt', surface: 'terminal', ...BAND })

  for (const ok of [true, false]) {
    answered = ok
    await ui.press({ key: 'optimize' })
    expect(await ui.find(SPIN)).toBeUndefined()
    expect(await ui.find({ key: 'optimize' })).toBeDefined()
  }
  expect(shown).toEqual([true, true])
  await ui.unmount()
})
