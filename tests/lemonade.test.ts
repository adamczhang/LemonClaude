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

/** A fake Lemonade, an in-memory environment, and a model that records which model each request named. */
function world(on: On, initialEnv: Record<string, string>, reachable = true) {
  const env = new Map(Object.entries(initialEnv))
  const asked: string[] = []
  mock.store(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('env.get', ($, e) => ({ value: env.get(e.name) }))
  on('env.set', ($, e) => {
    if (e.value === undefined) env.delete(e.name)
    else env.set(e.name, e.value)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    if (!reachable) return { deny: 'connection refused' }
    const body = e.url.endsWith('/api/v1/models') ? MODELS : e.url.endsWith('/api/v1/health') ? HEALTH : undefined
    return body
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('turn.step', async function* ($, e) {
    asked.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { env, asked }
}

async function lemonade($: Engine, args: string) {
  return $.command.run({ command: 'lemonade', args })
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
  return stream
}

describe('/lemonade', () => {
  test('switches the session to a Lemonade model and back', async ($, on) => {
    const { env, asked } = world(on, { ANTHROPIC_BASE_URL: 'https://gateway.example' })

    const on1 = await lemonade($, 'qwen')
    expect(on1.text).toContain('Now on Qwen3.5-4B-GGUF')
    expect(env.get('ANTHROPIC_BASE_URL')).toBe('http://127.0.0.1:13305')
    expect(env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')).toBe('Qwen3.5-4B-GGUF')
    expect(env.get('CLAUDE_CODE_SUBAGENT_MODEL')).toBe('Qwen3.5-4B-GGUF')

    await step($)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF'])

    const off = await lemonade($, 'off')
    expect(off.text).toContain('Back on Claude')
    expect(env.get('ANTHROPIC_BASE_URL')).toBe('https://gateway.example')
    expect(env.has('ANTHROPIC_DEFAULT_HAIKU_MODEL')).toBe(false)
    expect(env.has('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(false)

    await step($)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF', 'claude-opus-5-5'])
  })

  test('a second switch still restores the original environment', async ($, on) => {
    const { env } = world(on, {})
    await lemonade($, 'Qwen3.5-4B-GGUF')
    await lemonade($, 'gemma')
    expect(env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')).toBe('Gemma-Chat-GGUF')
    await lemonade($, 'off')
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
    expect(env.has('ANTHROPIC_DEFAULT_SONNET_MODEL')).toBe(false)
  })

  test('warns about a model without tool calling', async ($, on) => {
    world(on, {})
    expect((await lemonade($, 'gemma')).text).toContain('tool-calling')
  })

  test('refuses models that are not downloaded chat models', async ($, on) => {
    const { env, asked } = world(on, {})
    expect((await lemonade($, 'whisper')).text).toContain('No downloaded Lemonade chat model')
    expect((await lemonade($, 'Not-Pulled')).text).toContain('No downloaded Lemonade chat model')
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
    await step($)
    expect(asked).toEqual(['claude-opus-5-5'])
  })

  test('leaves Claude in place when Lemonade is unreachable', async ($, on) => {
    const { env } = world(on, {}, false)
    expect((await lemonade($, 'qwen')).text).toContain("isn't reachable")
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
  })

  test('list shows tool support and loaded state', async ($, on) => {
    world(on, {})
    const { text } = await lemonade($, 'list')
    expect(text).toContain('Qwen3.5-4B-GGUF (3.34 GB, tools, loaded)')
    expect(text).toContain('Gemma-Chat-GGUF (2.1 GB, no tools)')
    expect(text).not.toContain('Whisper')
  })

  test('ending the session hands the environment back', async ($, on) => {
    const { env } = world(on, {})
    await lemonade($, 'qwen')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { kind: 'none' } as never })
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
  })

  test('the picker switches on a pick', async ($, on) => {
    const { env } = world(on, {})
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
    await $.ui.select({ plugin: 'sidekick', key: 'model', value: 'Qwen3.5-4B-GGUF' })
    expect(env.get('ANTHROPIC_BASE_URL')).toBe('http://127.0.0.1:13305')
  })
})
