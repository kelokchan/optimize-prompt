import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolUseSummary } from 'claude-code'

const isBusy = atom({ plugin: 'optimize-prompt', key: 'isBusy' } as const, false)
const frame = atom({ plugin: 'optimize-prompt', key: 'frame' } as const, 0)

// Braille dots: one column wide in every terminal font. No Spinner element on
// the terminal, so a $.clock.every tick advances `frame` and the band redraws.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_MS = 100
const spinnerGlyph = (n: number) => SPINNER[n % SPINNER.length] ?? ''

// Haiku: cheapest + fastest model; rewriting a prompt needs no deep reasoning.
const MODEL = 'haiku'

const SYSTEM = `You rewrite a draft prompt the user is about to send to an AI coding assistant, in the middle of an ongoing session.
<conversation> holds the latest messages of that session and the assistant's tool calls between them (lines starting "tool", showing files read or edited, commands run and their results). Use it only to understand what the draft refers to: resolve vague references ("it", "the button", "that error") to the concrete thing, file or feature being discussed. Name a file or command from it only where the draft refers to one.
Rules:
- Keep the draft's scope. Never add requirements, deliverables, sections or questions the author did not ask for.
- Never comment on what the draft leaves unspecified. If the conversation does not resolve something, leave it as written.
- Stay proportionate: a one-line draft becomes one to three sentences, not a spec with headings.
- Keep the author's voice, language and every concrete detail (file paths, names, code, numbers).
- Do not answer or carry out the prompt.
Reply with the rewritten prompt only, no preamble or quotes.`

// Recent turns ground the rewrite: without them Haiku sees a bare draft and
// generalises "the spinner" into "the application's UI".
// Tool calls show which files and commands "it" means. The window is counted in
// text messages so a tool-heavy turn can't push the person's own words out.
// ponytail: plain char cuts, not token counts; CONTEXT_TOTAL is the ceiling.
const CONTEXT_MESSAGES = 8 // text messages; tool calls between them ride along
const CONTEXT_CHARS = 1200 // per message text, its tail kept
const TOOL_CHARS = 200 // per tool input and per tool result, the head kept
const CONTEXT_TOTAL = 12000 // whole block, the newest kept

const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s)

const toolLine = (u: ToolUseSummary) =>
  `tool ${u.tool}(${head(JSON.stringify(u.input), TOOL_CHARS)})` +
  (u.text === undefined ? '' : ` → ${u.isError ? 'error: ' : ''}${head(u.text, TOOL_CHARS)}`)

const recentContext = async ($: EngineInterface) => {
  const messages = (await $.session.messages()).filter(m => m.text.trim() || m.toolUses.length)
  const textAt = messages.flatMap((m, i) => (m.text.trim() ? [i] : []))
  const rendered = messages
    .slice(textAt.at(-CONTEXT_MESSAGES) ?? 0)
    .map(m =>
      [...(m.text.trim() ? [`${m.role}: ${tail(m.text, CONTEXT_CHARS)}`] : []), ...m.toolUses.map(toolLine)].join('\n'),
    )
    .join('\n\n')
  return tail(rendered, CONTEXT_TOTAL)
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const busy = await read($, isBusy)
    const { Box, Button, Text } = $.ui.resolve(e)

    const optimize = async () => {
      if (await read($, isBusy)) return

      const draft = (await $.prompt.read()).text
      if (!draft.trim()) {
        $.ui.toast('Type a prompt first')
        return
      }

      await update($, isBusy, () => true)
      const tick = $.clock.every(SPINNER_MS, () => void update($, frame, n => n + 1))
      try {
        const context = await recentContext($)
        const r = await $.model.complete({
          model: MODEL,
          system: SYSTEM,
          prompt: `${context && `<conversation>\n${context}\n</conversation>\n\n`}<draft>\n${draft}\n</draft>`,
          effort: 'low',
          maxTokens: 2048,
          timeoutMs: 30000,
        })
        if (!r.isAnswered) {
          $.ui.toast(`Optimize failed: ${r.reason}`)
          return
        }
        // Don't clobber anything typed while the model was working.
        if ((await $.prompt.read()).text !== draft) {
          $.ui.toast('Draft changed while optimizing; left it as is')
          return
        }
        await $.prompt.fill({ text: r.text.trim(), mode: 'replace' })
      } finally {
        tick.cancel()
        await update($, isBusy, () => false)
      }
    }

    return (
      <Box>
        {busy ? (
          <Text color="suggestion">
            {spinnerGlyph(await read($, frame))} Optimizing prompt
          </Text>
        ) : (
          <Button key="optimize" variant="primary" onPress={optimize}>
            ✦ Optimize prompt
          </Button>
        )}
      </Box>
    )
  })
}
