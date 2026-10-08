import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Lemonade's catalog, as /api/v1/models?show_all=true lists it.
const MODELS = [
  { id: 'Qwen3.5-4B-GGUF', size: 3.34, downloaded: true, suggested: true, recipe: 'llamacpp', labels: ['chat', 'vision', 'tool-calling'] },
  { id: 'Gemma-Chat-GGUF', size: 2.1, downloaded: true, suggested: true, recipe: 'llamacpp', labels: ['chat'] },
  { id: 'Whisper-Large-v3-Turbo', size: 1.62, downloaded: true, suggested: true, recipe: 'whispercpp', labels: ['transcription'] },
  { id: 'Not-Pulled-GGUF', size: 9, downloaded: false, suggested: true, recipe: 'llamacpp', labels: ['chat', 'tool-calling'] },
  { id: 'OLMo-1B-Hybrid', size: 0.65, downloaded: false, suggested: true, recipe: 'ryzenai-llm', labels: ['chat'] },
  { id: 'Unlisted-GGUF', size: 4, downloaded: false, suggested: false, recipe: 'llamacpp', labels: ['chat'] },
  { id: 'ACE-Step-Music', size: 10.5, downloaded: false, suggested: true, recipe: 'acestep', labels: ['audio-generation'] },
]
const HEALTH = { all_models_loaded: [{ model_name: 'Qwen3.5-4B-GGUF' }] }

/** Lemonade's side of a world: its catalog, the download jobs /api/v1/downloads lists, and each pull body. */
type Lemonade = { models: typeof MODELS; jobs: Array<Record<string, unknown>>; pulls: unknown[] }

type World = {
  env: Map<string, string>
  asked: string[]
  session: { model: string }
  toasts: string[]
  runs: string[][]
  stdin: string[]
  lemonade: Lemonade
}

/**
 * A fake Lemonade, an in-memory environment and store, a session model the test sets as the
 * model selector would, and a model that records which model and base URL each request used.
 * `installed` puts LemonadeServer.exe where the Windows installer does; running the start command
 * brings the fake Lemonade up unless `startFails`.
 */
function world(
  on: On,
  initialEnv: Record<string, string> = {},
  opts: { reachable?: boolean; store?: Record<string, unknown>; failSteps?: boolean; installed?: boolean; startFails?: boolean } = {},
): World {
  const env = new Map(Object.entries(initialEnv))
  const asked: string[] = []
  const session = { model: 'claude-opus-5-5' }
  const toasts: string[] = []
  const runs: string[][] = []
  const stdin: string[] = []
  let isUp = opts.reachable !== false
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
  on('fs.exists', ($, e) => ({ value: !!opts.installed && e.path === `${env.get('LOCALAPPDATA')}\\lemonade_server\\bin\\LemonadeServer.exe` }))
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    stdin.push(e.init?.stdin ?? '')
    // Long enough for a second request to find the start under way.
    await new Promise(resolve => setTimeout(resolve, 20))
    if (!opts.startFails) isUp = true
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const lemonade: Lemonade = { models: JSON.parse(JSON.stringify(MODELS)), jobs: [], pulls: [] }
  on('http.fetch', ($, e) => {
    if (!isUp) return { deny: 'connection refused' }
    const path = e.url.replace(/^https?:\/\/[^/]+/, '')
    let body: unknown
    if (path === '/api/v1/models?show_all=true') body = { data: lemonade.models }
    else if (path === '/api/v1/health') body = HEALTH
    else if (path === '/api/v1/downloads') body = lemonade.jobs
    else if (path === '/api/v1/pull' && e.init?.method === 'POST') {
      const pull = JSON.parse(e.init.body ?? '{}') as { model_name: string }
      lemonade.pulls.push(pull)
      lemonade.jobs.push({ model_name: pull.model_name, status: 'downloading', running: true, percent: 0 })
      body = lemonade.jobs.at(-1)
    }
    return body
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('turn.step', async function* ($, e) {
    asked.push(`${e.model} @ ${env.get('ANTHROPIC_BASE_URL') ?? 'default'}`)
    if (opts.failSteps) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { env, asked, session, toasts, runs, stdin, lemonade }
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

  test('LEMONCLAUDE_LEMONADE_MODEL names the model to offer while Lemonade is down', async ($, on) => {
    const { env } = world(on, { LEMONCLAUDE_LEMONADE_MODEL: 'Qwen3-Coder-Next-GGUF' }, { reachable: false })
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

})

/** Mounts bare /lemonade's output row, where the model manager draws, on `surface`. */
async function manager($: Engine, surface: 'terminal' | 'desktop', args = '') {
  const { text } = await lemonade($, args)
  return $.ui.mount({
    plugin: 'lemonclaude',
    surface,
    component: 'CommandOutput',
    requestId: 'm1',
    props: { command: 'lemonade', args, text: text ?? '', isErrored: false },
    viewport: { columns: 100, rows: 40 },
  })
}

describe('model manager', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: lists Lemonade's chat models by recipe, as Lemonade does`, async ($, on) => {
      world(on)
      await start($)
      const ui = await manager($, surface)
      expect((await ui.find({ key: 'group-llamacpp' }))?.text).toContain('Llama.cpp GPU (3)')
      expect((await ui.find({ key: 'group-ryzenai-llm' }))?.text).toContain('Ryzen AI LLM (1)')
      // Speech, music and models Lemonade doesn't suggest stay out.
      expect(await ui.find({ key: 'group-whispercpp' })).toBeUndefined()
      expect(await ui.find({ key: 'group-acestep' })).toBeUndefined()
      expect(await ui.find({ text: /Unlisted-GGUF/ })).toBeUndefined()
      // The loaded model heads the list; groups open on a press.
      expect(await ui.find({ key: 'row-Qwen3.5-4B-GGUF' })).toBeDefined()
      expect(await ui.find({ key: 'row-Not-Pulled-GGUF' })).toBeUndefined()
      await ui.press({ key: 'group-llamacpp' })
      expect(await ui.find({ key: 'get-Not-Pulled-GGUF' })).toBeDefined()
      expect(await ui.find({ key: 'use-Gemma-Chat-GGUF' })).toBeDefined()
    })

    test(`${surface}: Use sends requests to that model, and Back to Claude returns`, async ($, on) => {
      const { asked, env, toasts } = world(on)
      await start($)
      const ui = await manager($, surface)
      await ui.press({ key: 'group-llamacpp' })
      await ui.press({ key: 'use-Gemma-Chat-GGUF' })
      expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
      expect(toasts.some(t => t.includes('Requests now go to 🍋 Gemma-Chat-GGUF'))).toBe(true)
      expect((await ui.find({ key: 'row-Gemma-Chat-GGUF' }))?.text).toContain('In use')
      await step($)
      await ui.press({ key: 'claude' })
      await step($)
      expect(asked).toEqual(['Gemma-Chat-GGUF @ http://127.0.0.1:13305', 'claude-opus-5-5 @ default'])
    })
  }

  test('Download starts a server-owned download, shows its progress, then offers Use', async ($, on) => {
    const clock = mock.clock(on)
    const { lemonade: server, toasts } = world(on)
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'group-llamacpp' })
    await ui.press({ key: 'get-Not-Pulled-GGUF' })
    expect(server.pulls).toEqual([{ model_name: 'Not-Pulled-GGUF', stream: true, subscribe: false }])

    server.jobs[0]!.percent = 40
    await clock.advance(1000)
    expect((await ui.find({ key: 'row-Not-Pulled-GGUF' }))?.text).toContain('Downloading 40%')

    server.jobs[0] = { model_name: 'Not-Pulled-GGUF', status: 'completed', running: false, percent: 100, complete: true }
    server.models.find(m => m.id === 'Not-Pulled-GGUF')!.downloaded = true
    await clock.advance(1000)
    expect(await ui.find({ key: 'use-Not-Pulled-GGUF' })).toBeDefined()
    expect(toasts.some(t => t.includes('Downloaded Not-Pulled-GGUF'))).toBe(true)
  })

  test('the search box filters and opens the groups it leaves', async ($, on) => {
    world(on)
    await start($)
    const ui = await manager($, 'desktop')
    await ui.input({ key: 'search', text: 'olmo', kind: 'change' })
    expect(await ui.find({ key: 'get-OLMo-1B-Hybrid' })).toBeDefined()
    expect(await ui.find({ key: 'group-llamacpp' })).toBeUndefined()
  })

  test('Downloaded only hides what is not downloaded', async ($, on) => {
    world(on)
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'downloaded-only' })
    expect(await ui.find({ key: 'use-Gemma-Chat-GGUF' })).toBeDefined()
    expect(await ui.find({ key: 'get-Not-Pulled-GGUF' })).toBeUndefined()
    expect(await ui.find({ key: 'group-ryzenai-llm' })).toBeUndefined()
  })

  test('says why the list is empty when Lemonade is down', async ($, on) => {
    world(on, {}, { reachable: false })
    await start($)
    const ui = await manager($, 'desktop')
    expect(await ui.find({ text: /isn't reachable/ })).toBeDefined()
  })

  test('/lemonade with arguments keeps its text row', async ($, on) => {
    world(on)
    // The engine's own drawing of the row, which the plugin hands it to.
    const drawn: string[] = []
    on('ui.render', { component: 'CommandOutput' }, ($, e) => {
      drawn.push(e.props.text)
      return { type: 'Text', props: {}, children: [e.props.text] } as never
    })
    await start($)
    await manager($, 'desktop', 'list')
    expect(drawn.length).toBe(1)
    expect(drawn[0]).toContain('Downloaded chat models')
  })
})

const WINDOWS = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
const EXE = 'C:\\Users\\me\\AppData\\Local\\lemonade_server\\bin\\LemonadeServer.exe'

describe('starting Lemonade', () => {
  test('the entry says picking it starts Lemonade', async ($, on) => {
    const { env } = world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toBe('Local via Lemonade · Lemonade not running, starts when picked')
  })

  test('picking the entry starts Lemonade Server, then sends the request', async ($, on) => {
    const { asked, session, toasts, runs, stdin } = world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(runs).toEqual([['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '-']])
    expect(stdin[0]).toContain(`Start-Process -FilePath '${EXE}' -ArgumentList '--silent'`)
    expect(stdin[0]).toContain("'http://127.0.0.1:13305/api/v1/health'")
    expect(asked).toEqual(['Qwen3.5-4B-GGUF @ http://127.0.0.1:13305'])
    expect(toasts.some(t => t.includes('Starting Lemonade Server'))).toBe(true)
    expect(toasts.some(t => t.includes("didn't answer"))).toBe(false)
  })

  test('requests that find Lemonade down together start it once', async ($, on) => {
    const { asked, session, runs } = world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await Promise.all([step($, session.model), step($, 'claude-haiku-4-5', 'agent-1')])
    expect(runs.length).toBe(1)
    expect(asked.length).toBe(2)
  })

  test('a running Lemonade is left alone', async ($, on) => {
    const { session, runs } = world(on, WINDOWS, { installed: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(runs).toEqual([])
  })

  test('says so when Lemonade Server does not come up', async ($, on) => {
    const { asked, session, toasts } = world(on, WINDOWS, { reachable: false, installed: true, startFails: true, failSteps: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF @ http://127.0.0.1:13305'])
    expect(toasts.filter(t => t.includes("didn't answer")).length).toBe(1)
    expect(toasts.some(t => t.includes('within 60 s of starting'))).toBe(true)
  })

  test('/lemonade starts Lemonade Server to list its models', async ($, on) => {
    const { env, runs } = world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    const { text } = await lemonade($, 'gemma')
    expect(runs.length).toBe(1)
    expect(text).toContain('now offers 🍋 Gemma-Chat-GGUF')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
  })

  test('/lemonade list does not start it', async ($, on) => {
    const { runs } = world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    await lemonade($, 'list')
    expect(runs).toEqual([])
  })

  test('never starts a server for a Lemonade on another machine', async ($, on) => {
    const { session, runs } = world(on, { ...WINDOWS, LEMONADE_BASE_URL: 'http://gpu-box:13305' }, { reachable: false, installed: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(runs).toEqual([])
  })

  test('LEMONCLAUDE_AUTOSTART=0 turns starting off', async ($, on) => {
    const { env, session, runs } = world(on, { ...WINDOWS, LEMONCLAUDE_AUTOSTART: '0' }, { reachable: false, installed: true })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toContain('start it first')
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(runs).toEqual([])
  })
})

describe('/lemonade on and off', () => {
  test('/lemonade on sends requests to the offered model whatever the selector shows', async ($, on) => {
    const { env, asked } = world(on, { ANTHROPIC_BASE_URL: 'https://gateway.example' })
    await start($)
    const { text } = await lemonade($, 'on')
    expect(text).toContain('Requests now go to 🍋 Qwen3.5-4B-GGUF')
    expect(env.get('ANTHROPIC_BASE_URL')).toBe('http://127.0.0.1:13305')
    // The desktop picker still says Opus; requests, subagents' included, go to Lemonade.
    await step($)
    await step($, 'claude-haiku-4-5', 'agent-1')
    expect((await lemonade($, 'off')).text).toContain('Claude answers')
    await step($)
    expect(asked).toEqual([
      'Qwen3.5-4B-GGUF @ http://127.0.0.1:13305',
      'Qwen3.5-4B-GGUF @ http://127.0.0.1:13305',
      'claude-opus-5-5 @ https://gateway.example',
    ])
    expect(env.has('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(false)
  })

  test('/lemonade on <model> offers that model and switches to it', async ($, on) => {
    const { env, asked } = world(on)
    await start($)
    const { text } = await lemonade($, 'on gemma')
    expect(text).toContain('Requests now go to 🍋 Gemma-Chat-GGUF')
    expect(text).toContain('tool-calling')
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Gemma-Chat-GGUF')
    await step($)
    expect(asked).toEqual(['Gemma-Chat-GGUF @ http://127.0.0.1:13305'])
  })

  test('/lemonade on refuses a model it cannot find and stays off', async ($, on) => {
    const { asked } = world(on)
    await start($)
    expect((await lemonade($, 'on whisper')).text).toContain('No downloaded Lemonade chat model')
    await step($)
    expect(asked).toEqual(['claude-opus-5-5 @ default'])
  })

  test("/lemonade on needs a model when the entry is the person's own", async ($, on) => {
    const { asked } = world(on, { ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-gateway-model' })
    await start($)
    expect((await lemonade($, 'on')).text).toContain('Name one: /lemonade on <model>')
    await step($)
    expect(asked).toEqual(['claude-opus-5-5 @ default'])
  })

  test('/lemonade <model> while on moves requests to the new model', async ($, on) => {
    const { asked } = world(on)
    await start($)
    await lemonade($, 'on')
    expect((await lemonade($, 'gemma')).text).toContain('Requests go to it now')
    await step($)
    expect(asked).toEqual(['Gemma-Chat-GGUF @ http://127.0.0.1:13305'])
  })

  test('/lemonade off leaves a session whose selector has 🍋 on Lemonade', async ($, on) => {
    const { session, asked } = world(on)
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await lemonade($, 'on')
    expect((await lemonade($, 'off')).text).toContain('still go to Lemonade')
    await step($, session.model)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF @ http://127.0.0.1:13305'])
  })

  test('/lemonade on starts Lemonade Server; /lemonade off does not', async ($, on) => {
    const { runs } = world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    await lemonade($, 'off')
    expect(runs).toEqual([])
    await lemonade($, 'on')
    expect(runs.length).toBe(1)
  })

  test('ending the session turns it off', async ($, on) => {
    const { env, asked } = world(on)
    await start($)
    await lemonade($, 'on')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { kind: 'none' } as never })
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false)
    await step($)
    expect(asked).toEqual(['claude-opus-5-5 @ default'])
  })

  test('/lemonade list says when it is on', async ($, on) => {
    world(on)
    await start($)
    await lemonade($, 'on')
    expect((await lemonade($, 'list')).text).toContain('Requests go to Qwen3.5-4B-GGUF via Lemonade (/lemonade on')
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
