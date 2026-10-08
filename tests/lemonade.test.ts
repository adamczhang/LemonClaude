import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MODELS = {
  data: [
    { id: 'Qwen3.5-4B-GGUF', size: 3.34, downloaded: true, labels: ['chat', 'vision', 'tool-calling'] },
    { id: 'Gemma-Chat-GGUF', size: 2.1, downloaded: true, labels: ['chat'] },
    { id: 'Whisper-Large-v3-Turbo', size: 1.62, downloaded: true, labels: ['transcription'] },
    { id: 'Not-Pulled-GGUF', size: 9, downloaded: false, labels: ['chat', 'tool-calling'] },
  ],
}
const HEALTH = { all_models_loaded: [{ model_name: 'Qwen3.5-4B-GGUF' }] }

type World = { env: Map<string, string>; asked: string[]; session: { model: string }; toasts: string[] }

/**
 * A fake Lemonade, an in-memory environment and store, a session model the test sets as the
 * model selector would, and a model that records which model and base URL each request used.
 */
function world(on: On, initialEnv: Record<string, string> = {}, opts: { reachable?: boolean; store?: Record<string, unknown>; failSteps?: boolean } = {}): World {
  const env = new Map(Object.entries(initialEnv))
  const asked: string[] = []
  const session = { model: 'claude-opus-5-5' }
  const toasts: string[] = []
  mock.store(on, opts.store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.model', () => ({ value: session.model }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }) as never)
  on('env.get', ($, e) => ({ value: env.get(e.name) }))
  on('env.set', ($, e) => {
    if (e.value === undefined) env.delete(e.name)
    else env.set(e.name, e.value)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    if (opts.reachable === false) return { deny: 'connection refused' }
    const body = e.url.endsWith('/api/v1/models') ? MODELS : e.url.endsWith('/api/v1/health') ? HEALTH : undefined
    return body
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('turn.step', async function* ($, e) {
    asked.push(`${e.model} @ ${env.get('ANTHROPIC_BASE_URL') ?? 'default'}`)
    if (opts.failSteps) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { env, asked, session, toasts }
}

async function start($: Engine) {
  await $.session.start({ cwd: 'D:/tmp', surface: 'terminal', isInteractive: true })
}

async function lemonade($: Engine, args: string) {
  return $.command.run({ command: 'lemonade', args })
}

async function step($: Engine, model = 'claude-opus-5-5', agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drain
  }
}

describe('model selector entry', () => {
  test('session start offers the first tool-calling model', async ($, on) => {
    const { env } = world(on)
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Qwen3.5-4B-GGUF')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_NAME')).toBe('🍋 Qwen3.5-4B-GGUF')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toContain('Local via Lemonade')
  })

  test('session start offers the model chosen last time', async ($, on) => {
    const { env } = world(on, {}, { store: { lastOffer: { id: 'Gemma-Chat-GGUF', size: 2.1, labels: ['chat'], hasTools: false, isLoaded: false } } })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
  })

  test("leaves the person's own custom entry alone", async ($, on) => {
    const { env } = world(on, { ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-gateway-model' })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('my-gateway-model')
    expect(env.has('ANTHROPIC_CUSTOM_MODEL_OPTION_NAME')).toBe(false)
  })

  test('offers the model from last time while Lemonade is down', async ($, on) => {
    const lastOffer = { id: 'Gemma-Chat-GGUF', size: 2.1, labels: ['chat'], hasTools: false, isLoaded: false }
    const { env } = world(on, {}, { reachable: false, store: { lastOffer } })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toBe('Local via Lemonade · 2.1 GB, Lemonade not running, start it first')
  })

  test('offers the default model while Lemonade is down and nothing is remembered', async ($, on) => {
    const { env } = world(on, {}, { reachable: false })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Qwen3.5-4B-GGUF')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toContain('Lemonade not running')
  })

  test('SIDEKICK_LEMONADE_MODEL names the model to offer while Lemonade is down', async ($, on) => {
    const { env } = world(on, { SIDEKICK_LEMONADE_MODEL: 'Qwen3-Coder-Next-GGUF' }, { reachable: false })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Qwen3-Coder-Next-GGUF')
  })

  test("leaves the person's own custom entry alone while Lemonade is down", async ($, on) => {
    const { env } = world(on, { ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-gateway-model' }, { reachable: false })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('my-gateway-model')
  })

  test('picking the remembered entry routes to Lemonade and says when it does not answer', async ($, on) => {
    const { asked, session, toasts } = world(on, {}, { reachable: false, failSteps: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF @ http://127.0.0.1:13305'])
    expect(toasts.some(t => t.includes("Lemonade didn't answer"))).toBe(true)
  })

  test('/lemonade <model> changes the entry', async ($, on) => {
    const { env } = world(on)
    await start($)
    const { text } = await lemonade($, 'gemma')
    expect(text).toContain('now offers 🍋 Gemma-Chat-GGUF')
    expect(text).toContain('tool-calling')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
  })

  test('/lemonade refuses models that are not downloaded chat models', async ($, on) => {
    const { env } = world(on)
    await start($)
    expect((await lemonade($, 'whisper')).text).toContain('No downloaded Lemonade chat model')
    expect((await lemonade($, 'Not-Pulled')).text).toContain('No downloaded Lemonade chat model')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Qwen3.5-4B-GGUF')
  })

  test('/lemonade list shows tool support and loaded state', async ($, on) => {
    world(on)
    await start($)
    const { text } = await lemonade($, 'list')
    expect(text).toContain('* Qwen3.5-4B-GGUF (3.34 GB, tools, loaded)')
    expect(text).toContain('Gemma-Chat-GGUF (2.1 GB, no tools)')
    expect(text).not.toContain('Whisper')
  })

  test('the picker pane changes the entry', async ($, on) => {
    const { env } = world(on)
    await start($)
    await lemonade($, '')
    const ui = await $.ui.mount({
      plugin: 'sidekick',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'lemonade-picker',
      props: { title: 'Lemonade model', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
      viewport: { columns: 80, rows: 20 },
    })
    expect((await ui.find({ key: 'model' }))?.type).toBe('Select')
    await $.ui.select({ plugin: 'sidekick', key: 'model', value: 'Gemma-Chat-GGUF' })
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
  })
})

describe('routing', () => {
  test('picking the entry sends requests to Lemonade; picking Claude sends them back', async ($, on) => {
    const { env, asked, session } = world(on, { ANTHROPIC_BASE_URL: 'https://gateway.example' })
    await start($)

    await step($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, 'Qwen3.5-4B-GGUF')
    // The aliases stay Claude's, so picking Opus afterwards still means Opus.
    expect(env.has('ANTHROPIC_DEFAULT_OPUS_MODEL')).toBe(false)
    // A subagent asking for a Claude model follows the session onto Lemonade.
    await step($, 'claude-haiku-4-5', 'agent-1')
    session.model = 'claude-opus-5-5'
    await step($)

    expect(asked).toEqual([
      'claude-opus-5-5 @ https://gateway.example',
      'Qwen3.5-4B-GGUF @ http://127.0.0.1:13305',
      'Qwen3.5-4B-GGUF @ http://127.0.0.1:13305',
      'claude-opus-5-5 @ https://gateway.example',
    ])
    expect(env.has('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(false)
  })

  test('changing the Lemonade model mid-session still restores Claude afterwards', async ($, on) => {
    const { env, asked, session } = world(on)
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    await lemonade($, 'gemma')
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    session.model = 'claude-opus-5-5'
    await step($)
    expect(asked).toEqual([
      'Qwen3.5-4B-GGUF @ http://127.0.0.1:13305',
      'Gemma-Chat-GGUF @ http://127.0.0.1:13305',
      'claude-opus-5-5 @ default',
    ])
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
  })

  test('ending the session hands the environment back', async ($, on) => {
    const { env, session } = world(on)
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { kind: 'none' } as never })
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
  })
})
