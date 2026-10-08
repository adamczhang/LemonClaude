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
  { id: 'FLM-Chat', size: 1, downloaded: false, suggested: true, recipe: 'flm', labels: ['chat'] },
]
/** A model in Lemonade's memory, as /api/v1/health lists it. */
type Loaded = { model_name: string; type: string; pinned: boolean; recipe_options: { ctx_size: number }; pid?: number }
// What this machine can run, as /api/v1/system-info judges it: no NPU for FastFlowLM.
const SYSTEM = {
  'Physical Memory': '64.00 GB',
  // A roomy GPU, so the fixtures' models fit unless a test says otherwise.
  devices: { nvidia_gpu: [{ available: true, vram_gb: 24 }], amd_gpu: [{ available: true, integrated: true }] },
  recipes: {
    llamacpp: { default_backend: 'cuda', backends: { cuda: { state: 'installed' }, rocm: { state: 'unsupported' } } },
    'ryzenai-llm': { default_backend: 'npu', backends: { npu: { state: 'installable' } } },
    flm: { backends: { npu: { state: 'unsupported' } } },
  },
}

/** Lemonade's side of a world: its catalog, the download jobs /api/v1/downloads lists, and each pull body. */
type Lemonade = {
  models: Array<{ id: string; size: number; downloaded: boolean; suggested: boolean; recipe: string; labels: string[] }>
  jobs: Array<Record<string, unknown>>
  pulls: unknown[]
  /** Every path fetched, in order. */
  fetched: string[]
  /** Held until it resolves: a pull still on its way to Lemonade. */
  pullGate?: Promise<void>
  /** Lemonade refuses each pull with this error. */
  pullError?: string
  /** Lemonade fails each load with this error. */
  loadError?: string
  /** /api/v1/system-info, when a test gives other hardware. */
  system?: typeof SYSTEM
  /** What Windows' GPU counters say about each model's server process, as PowerShell prints it. */
  gpu?: string
  /** Each request that went out through curl, as `METHOD /path`. */
  curled: string[]
  /** What Lemonade has in memory: one chat slot, as max_loaded_models 1 gives. */
  loaded: Loaded[]
  /** Each /api/v1/load body. */
  loads: Array<{ model_name: string; ctx_size?: number; pinned?: boolean }>
  /** Each /internal/pin body. */
  pins: Array<{ model_name: string; pinned: boolean }>
}

type World = {
  env: Map<string, string>
  asked: string[]
  session: { model: string }
  toasts: string[]
  runs: string[][]
  stdin: string[]
  lemonade: Lemonade
  /** The session's subagents, as $.agent.list answers. */
  agents: Array<{ id: string; type: string; description: string; status: string }>
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
  const lemonade: Lemonade = {
    models: JSON.parse(JSON.stringify(MODELS)),
    jobs: [],
    pulls: [],
    fetched: [],
    curled: [],
    // The loaded model starts unpinned, loaded by nobody in particular.
    loaded: [{ model_name: 'Qwen3.5-4B-GGUF', type: 'llm', pinned: false, recipe_options: { ctx_size: 262144 } }],
    loads: [],
    pins: [],
  }
  const agents: World['agents'] = []
  on('agent.list', () => ({ value: agents }) as never)

  /** The fake Lemonade answering one request, or null when it isn't up. */
  const serve = async (url: string, method = 'GET', sent?: string): Promise<{ status: number; text: string } | null> => {
    if (!isUp) return null
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    lemonade.fetched.push(path)
    if (path === '/api/v1/pull' && lemonade.pullError) return { status: 400, text: JSON.stringify({ error: lemonade.pullError }) }
    if (path === '/api/v1/pull') await lemonade.pullGate
    let body: unknown
    if (path === '/api/v1/models?show_all=true') body = { data: lemonade.models }
    else if (path === '/api/v1/health') body = { all_models_loaded: lemonade.loaded }
    else if (path === '/internal/pin' && method === 'POST') {
      const pin = JSON.parse(sent ?? '{}') as { model_name: string; pinned: boolean }
      lemonade.pins.push(pin)
      const here = lemonade.loaded.find(m => m.model_name === pin.model_name)
      if (!here) return { status: 404, text: JSON.stringify({ error: { message: `Model not loaded: ${pin.model_name}` } }) }
      here.pinned = pin.pinned
      body = { model_name: pin.model_name, pinned: pin.pinned, status: 'success' }
    } else if (path === '/api/v1/load' && method === 'POST') {
      const load = JSON.parse(sent ?? '{}') as { model_name: string; ctx_size?: number; pinned?: boolean }
      lemonade.loads.push(load)
      if (lemonade.loadError) return { status: 500, text: JSON.stringify({ error: { message: lemonade.loadError } }) }
      const known = lemonade.models.find(m => m.id === load.model_name)
      if (!known) return { status: 404, text: JSON.stringify({ error: { message: `model '${load.model_name}' not found` } }) }
      const loaded = {
        model_name: load.model_name,
        type: 'llm',
        pinned: load.pinned === true,
        recipe_options: { ctx_size: load.ctx_size ?? 262144 },
        pid: 4242,
      }
      const here = lemonade.loaded.findIndex(m => m.model_name === load.model_name)
      if (here >= 0) lemonade.loaded[here] = loaded
      else {
        // One chat slot, as max_loaded_models 1 gives: an unpinned chat model makes room, a pinned one
        // refuses. Speech and image models have slots of their own.
        const chats = lemonade.loaded.filter(m => m.type === 'llm')
        const evictable = lemonade.loaded.findIndex(m => m.type === 'llm' && !m.pinned)
        if (chats.length >= 1 && evictable < 0) {
          return {
            status: 409,
            text: JSON.stringify({
              error: {
                code: 'slots_pinned_error',
                message: 'All loaded models of type standard/llm are pinned. Unload a model first.',
                requested_model: load.model_name,
                type: 'slots_pinned_error',
              },
            }),
          }
        }
        if (chats.length >= 1) lemonade.loaded.splice(evictable, 1)
        lemonade.loaded.push(loaded)
      }
      body = { model_name: load.model_name, status: 'success' }
    }
    else if (path === '/api/v1/downloads') body = lemonade.jobs
    else if (path === '/api/v1/system-info') body = lemonade.system ?? SYSTEM
    else if (path === '/api/v1/pull' && method === 'POST') {
      const pull = JSON.parse(sent ?? '{}') as { model_name: string }
      lemonade.pulls.push(pull)
      lemonade.jobs.push({ model_name: pull.model_name, status: 'downloading', running: true, percent: 0 })
      body = lemonade.jobs.at(-1)
    }
    return body ? { status: 200, text: JSON.stringify(body) } : { status: 404, text: '' }
  }

  on('process.run', async ($, e) => {
    // Windows' GPU memory counters: the readings the test set, or none.
    if (e.argv[0] === 'powershell.exe' && (e.init?.stdin ?? '').includes('GPU Process Memory')) {
      const reading = lemonade.gpu
      return { value: { exitCode: reading ? 0 : 1, stdout: reading ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // curl: the way to Lemonade while Claude Code refuses a plugin's own requests.
    if (e.argv[0] === 'curl') {
      const url = e.argv.at(-1)!
      const method = e.argv[e.argv.indexOf('-X') + 1]
      lemonade.curled.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
      const answer = await serve(url, method, e.init?.stdin)
      const ran = answer
        ? { exitCode: 0, stdout: `${answer.text}\n${answer.status}`, stderr: '' }
        : { exitCode: 7, stdout: '', stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 13305' }
      return { value: { ...ran, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    runs.push([...e.argv])
    stdin.push(e.init?.stdin ?? '')
    // Long enough for a second request to find the start under way.
    await new Promise(resolve => setTimeout(resolve, 20))
    if (!opts.startFails) isUp = true
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async ($, e) => {
    // As Claude Code does: a plugin's own requests are refused while nonessential traffic is off.
    if (env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return { deny: 'refused: nonessential network traffic is disabled for this session' }
    const answer = await serve(e.url, e.init?.method, e.init?.body)
    if (!answer) return { deny: 'ECONNREFUSED: Unable to connect' }
    return { value: { status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: {}, text: answer.text } }
  })
  on('turn.step', async function* ($, e) {
    asked.push(`${e.model} @ ${env.get('ANTHROPIC_BASE_URL') ?? 'default'}`)
    if (opts.failSteps) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { env, asked, session, toasts, runs, stdin, lemonade, agents }
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
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toBe('Local via Lemonade · 2.10 GB, Lemonade not running, start it first')
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
    expect(text).toContain('Gemma-Chat-GGUF (2.10 GB, no tools)')
    expect(text).not.toContain('Whisper')
  })

})

/** Mounts bare /lemonade's output row, where the model manager draws, on `surface`. */
async function manager($: Engine, surface: 'terminal' | 'desktop', args = '', requestId = 'm1') {
  const { text } = await lemonade($, args)
  return $.ui.mount({
    plugin: 'lemonclaude',
    surface,
    component: 'CommandOutput',
    requestId,
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
      // Loaded and downloaded models come first, ready to use.
      expect((await ui.find({ type: 'Text', text: /^ACTIVE/ }))?.text).toBe('ACTIVE · 1 loaded')
      expect(await ui.find({ key: 'use-Qwen3.5-4B-GGUF' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^DOWNLOADED/ }))?.text).toBe('DOWNLOADED · 1 ready')
      expect(await ui.find({ key: 'use-Gemma-Chat-GGUF' })).toBeDefined()
      // Then the rest, grouped by recipe as Lemonade groups them, each model in one place only.
      expect((await ui.find({ type: 'Text', text: /^SUGGESTED/ }))?.text).toBe('SUGGESTED · 2 to download')
      // Each recipe says where it runs, and when its backend isn't installed yet.
      expect((await ui.find({ key: 'group-box-llamacpp' }))?.text).toContain('Llama.cpp GPU1 · 9.00 GB · NVIDIA GPU, 24 GB')
      expect((await ui.find({ key: 'group-box-ryzenai-llm' }))?.text).toContain('Ryzen AI LLM1 · 650 MB · NPU, 64 GB RAM · backend not installed yet')
      expect(await ui.findAll({ key: 'row-Qwen3.5-4B-GGUF' })).toHaveLength(1)
      // Speech, music, models Lemonade doesn't suggest, and recipes this machine can't run stay out.
      expect(await ui.find({ key: 'group-whispercpp' })).toBeUndefined()
      expect(await ui.find({ key: 'group-acestep' })).toBeUndefined()
      expect(await ui.find({ key: 'group-flm' })).toBeUndefined()
      expect(await ui.find({ text: /Unlisted-GGUF/ })).toBeUndefined()
      // Groups open on a press.
      expect(await ui.find({ key: 'row-Not-Pulled-GGUF' })).toBeUndefined()
      await ui.press({ key: 'group-llamacpp' })
      expect(await ui.find({ key: 'get-Not-Pulled-GGUF' })).toBeDefined()
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

  test('a download asked while another runs is not taken for finished before Lemonade lists it', async ($, on) => {
    const clock = mock.clock(on)
    const { lemonade: server, toasts } = world(on)
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'group-llamacpp' })
    await ui.press({ key: 'group-ryzenai-llm' })
    await ui.press({ key: 'get-Not-Pulled-GGUF' })

    let release = () => {}
    server.pullGate = new Promise(resolve => (release = resolve))
    const pressing = ui.press({ key: 'get-OLMo-1B-Hybrid' })
    // A poll while the second pull is on its way: Lemonade lists only the first.
    await clock.advance(1000)
    expect(toasts.some(t => t.includes('Downloaded OLMo'))).toBe(false)
    expect((await ui.find({ key: 'row-OLMo-1B-Hybrid' }))?.text).toContain('Starting download')
    release()
    await pressing
    await clock.advance(1000)
    expect((await ui.find({ key: 'row-OLMo-1B-Hybrid' }))?.text).toContain('Downloading 0%')
  })

  test('a refused download says why and offers to retry', async ($, on) => {
    const { lemonade: server } = world(on)
    server.pullError = 'Not enough disk space'
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'group-llamacpp' })
    await ui.press({ key: 'get-Not-Pulled-GGUF' })
    const row = (await ui.find({ key: 'row-Not-Pulled-GGUF' }))?.text
    expect(row).toContain('Download failed: Not enough disk space')
    expect(row).toContain('Retry download')
  })

  test('bare /lemonade fetches the catalog once and starts with an empty search', async ($, on) => {
    const { lemonade: server } = world(on)
    await start($)
    const first = await manager($, 'desktop')
    await first.input({ key: 'search', text: 'olmo', kind: 'change' })
    server.fetched.length = 0
    const ui = await manager($, 'desktop', '', 'm2')
    expect(server.fetched.filter(p => p.startsWith('/api/v1/models'))).toHaveLength(1)
    expect(await ui.find({ key: 'group-llamacpp' })).toBeDefined()
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
    expect(await ui.find({ text: "Lemonade isn't running at http://127.0.0.1:13305." })).toBeDefined()
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

/**
 * What Windows' GPU counters say about the model server process 4242, as PowerShell prints it, in
 * MB: what it holds on the RTX of its own and borrowed, and what it holds on the integrated Radeon,
 * then each GPU's own memory size from the registry (8 GB and 512 MB).
 */
function gpu(rtxDedicated: number, rtxShared: number, radeonDedicated = 0, radeonShared = 0, rtxCommitted = rtxDedicated + rtxShared): string {
  const mb = 1024 * 1024
  const b = String.fromCharCode(92)
  const line = (luid: string, kind: string, value: number) =>
    `process|${b}${b}host${b}gpu process memory(pid_4242_luid_0x00000000_0x${luid}_phys_0)${b}${kind} usage|${value * mb}`
  return [
    line('0001d6f4', 'dedicated', rtxDedicated),
    line('0001d6f4', 'shared', rtxShared),
    line('00014de1', 'dedicated', radeonDedicated),
    line('00014de1', 'shared', radeonShared),
    `committed|${b}${b}host${b}gpu adapter memory(luid_0x00000000_0x0001d6f4_phys_0)${b}total committed|${rtxCommitted * mb}`,
    `committed|${b}${b}host${b}gpu adapter memory(luid_0x00000000_0x00014de1_phys_0)${b}total committed|${(radeonDedicated + radeonShared) * mb}`,
    `adapter|luid_0x00000000_0x0001d6f4|${8192 * mb}`,
    `adapter|luid_0x00000000_0x00014de1|${512 * mb}`,
  ].join(String.fromCharCode(13, 10))
}

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

describe('what it says', () => {
  test('/lemonade list while Lemonade is down says so in a line, and how to start it', async ($, on) => {
    world(on, WINDOWS, { reachable: false, installed: true })
    await start($)
    const { text } = await lemonade($, 'list')
    expect(text).toContain("Lemonade isn't running at http://127.0.0.1:13305. /lemonade or /lemonade on starts it.")
    expect(text).not.toContain('Downloaded chat models:')
  })

  test('the selector entry leaves out load state, which would go stale', async ($, on) => {
    const { env } = world(on)
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION')).toBe('Local via Lemonade · 3.34 GB, tools')
  })

  test('a downloads answer that is not JSON is taken as no downloads', async ($, on) => {
    const { lemonade: server } = world(on)
    await start($)
    server.jobs = 'not json' as never
    const { text } = await lemonade($, '')
    expect(text).toContain('Downloaded chat models:')
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

  test('picking another model in a model picker ends /lemonade on', async ($, on) => {
    const { session, asked } = world(on)
    await start($)
    await lemonade($, 'on')
    await step($)
    session.model = 'claude-sonnet-5-5'
    await step($, session.model)
    session.model = 'claude-opus-5-5'
    await step($)
    expect(asked).toEqual([
      'Qwen3.5-4B-GGUF @ http://127.0.0.1:13305',
      'claude-sonnet-5-5 @ default',
      'claude-opus-5-5 @ default',
    ])
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

describe('model list nesting', () => {
  /** A suggested chat model, not downloaded, for the list to nest. */
  const suggest = (id: string, size = 1, recipe = 'llamacpp') => ({ id, size, downloaded: false, suggested: true, recipe, labels: ['chat'] })

  test('a recipe opens onto makers; a maker of one stays a row', async ($, on) => {
    const { lemonade: server } = world(on)
    server.models.push(suggest('Phi-4-mini-instruct-GGUF'), suggest('Phi-3-mini-GGUF'), suggest('Bonsai-1.7B-gguf', 0.25))
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'group-llamacpp' })
    expect((await ui.find({ key: 'group-box-llamacpp/phi' }))?.text).toContain('▸ Phi2 · 1.00 GB')
    expect(await ui.find({ key: 'row-Phi-3-mini-GGUF' })).toBeUndefined()
    // Alone of its maker: a row, no folder.
    expect(await ui.find({ key: 'get-Bonsai-1.7B-gguf' })).toBeDefined()
    expect(await ui.find({ key: 'group-llamacpp/bonsai' })).toBeUndefined()
    await ui.press({ key: 'group-llamacpp/phi' })
    expect(await ui.find({ key: 'get-Phi-3-mini-GGUF' })).toBeDefined()
  })

  test('a maker of more than eight opens onto family folders', async ($, on) => {
    const { lemonade: server } = world(on)
    const qwen = ['Qwen3-0.6B-GGUF', 'Qwen3-4B-GGUF', 'Qwen3-14B-GGUF', 'Qwen3.5-2B-GGUF', 'Qwen3.5-9B-GGUF', 'Qwen3.5-27B-GGUF', 'Qwen3-VL-4B-Instruct-GGUF', 'Qwen3-VL-8B-Instruct-GGUF', 'Qwen3-Coder-Next-GGUF']
    server.models.push(...qwen.map(id => suggest(id, 2)))
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'group-llamacpp' })
    await ui.press({ key: 'group-llamacpp/qwen' })
    expect((await ui.find({ key: 'group-box-llamacpp/qwen/Qwen3' }))?.text).toContain('▸ Qwen33 · 2.00 GB')
    expect(await ui.find({ key: 'group-llamacpp/qwen/Qwen3.5' })).toBeDefined()
    expect(await ui.find({ key: 'group-llamacpp/qwen/Qwen3-VL' })).toBeDefined()
    // A family of one stays a row.
    expect(await ui.find({ key: 'get-Qwen3-Coder-Next-GGUF' })).toBeDefined()
    await ui.press({ key: 'group-llamacpp/qwen/Qwen3.5' })
    // Sizes in the order people read them: 2B, 9B, 27B.
    // (Qwen3.5-4B-GGUF, loaded, sits under Active, not in the folder.)
    const rows = (await ui.findAll({ type: 'Box' })).map(b => b.key).filter(k => k?.startsWith('row-Qwen3.5') && k !== 'row-Qwen3.5-4B-GGUF')
    expect(rows).toEqual(['row-Qwen3.5-2B-GGUF', 'row-Qwen3.5-9B-GGUF', 'row-Qwen3.5-27B-GGUF'])
  })

  test('models too big for this machine are hidden until asked for, and say so', async ($, on) => {
    const { lemonade: server } = world(on)
    // An 8 GB GPU: a 9 GB model can't fit; the NPU's share of 64 GB holds a 16 GB one.
    server.system = { ...SYSTEM, devices: { nvidia_gpu: [{ available: true, vram_gb: 8 }], amd_gpu: [] } }
    server.models.push(suggest('Big-NPU-Model-Hybrid', 16, 'ryzenai-llm'), suggest('Small-1B-GGUF', 0.8))
    await start($)
    const ui = await manager($, 'desktop')
    expect((await ui.find({ type: 'Text', text: /^SUGGESTED/ }))?.text).toBe('SUGGESTED · 3 to download · 1 too big for this machine, hidden')
    expect((await ui.find({ key: 'group-box-llamacpp' }))?.text).toContain('Llama.cpp GPU1 · 800 MB · NVIDIA GPU, 8 GB')
    await ui.press({ key: 'group-llamacpp' })
    expect(await ui.find({ key: 'get-Not-Pulled-GGUF' })).toBeUndefined()
    expect(await ui.find({ key: 'get-Small-1B-GGUF' })).toBeDefined()
    await ui.press({ key: 'group-ryzenai-llm' })
    expect(await ui.find({ key: 'get-Big-NPU-Model-Hybrid' })).toBeDefined()
    // Asked for, they show, marked.
    await ui.press({ key: 'too-big' })
    expect((await ui.find({ key: 'row-Not-Pulled-GGUF' }))?.text).toContain('too big')
    // The next /lemonade hides them again.
    const again = await manager($, 'desktop', '', 'm2')
    expect((await again.find({ type: 'Text', text: /^SUGGESTED/ }))?.text).toContain('1 too big for this machine, hidden')
  })

  test('a downloaded model too big for this machine still shows, marked', async ($, on) => {
    const { lemonade: server } = world(on)
    server.system = { ...SYSTEM, devices: { nvidia_gpu: [{ available: true, vram_gb: 2 }], amd_gpu: [] } }
    await start($)
    const ui = await manager($, 'desktop')
    expect((await ui.find({ key: 'row-Gemma-Chat-GGUF' }))?.text).toContain('too big')
    expect(await ui.find({ key: 'use-Gemma-Chat-GGUF' })).toBeDefined()
  })

  test('without hardware facts, every model shows', async ($, on) => {
    const { lemonade: server } = world(on)
    server.system = { recipes: SYSTEM.recipes } as never
    await start($)
    const ui = await manager($, 'desktop')
    expect((await ui.find({ type: 'Text', text: /^SUGGESTED/ }))?.text).toBe('SUGGESTED · 2 to download')
  })

  test('every /lemonade starts with all folders closed', async ($, on) => {
    const { lemonade: server } = world(on)
    server.models.push(suggest('Phi-4-mini-instruct-GGUF'), suggest('Phi-3-mini-GGUF'))
    await start($)
    const first = await manager($, 'desktop')
    await first.press({ key: 'group-llamacpp' })
    await first.press({ key: 'group-llamacpp/phi' })
    expect(await first.find({ key: 'row-Phi-3-mini-GGUF' })).toBeDefined()
    const again = await manager($, 'desktop', '', 'm2')
    expect((await again.find({ key: 'group-llamacpp' }))?.text).toContain('▸')
    expect(await again.find({ key: 'group-llamacpp/phi' })).toBeUndefined()
  })

  test('a search opens every folder down to the models it finds', async ($, on) => {
    const { lemonade: server } = world(on)
    server.models.push(suggest('Phi-4-mini-instruct-GGUF'), suggest('Phi-3-mini-GGUF'))
    await start($)
    const ui = await manager($, 'desktop')
    await ui.input({ key: 'search', text: 'phi-3', kind: 'change' })
    expect(await ui.find({ key: 'get-Phi-3-mini-GGUF' })).toBeDefined()
    expect(await ui.find({ key: 'get-Phi-4-mini-instruct-GGUF' })).toBeUndefined()
  })
})

describe('nonessential traffic', () => {
  test('routing leaves the flag alone, so a second request finds Lemonade up and starts nothing', async ($, on) => {
    const { env, session, runs, toasts } = world(on, WINDOWS, { installed: true })
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    await step($, session.model)
    expect(env.has('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(false)
    expect(runs).toEqual([])
    expect(toasts.some(t => t.includes('Starting Lemonade Server'))).toBe(false)
  })

  test("with the person's flag set, LemonClaude reaches Lemonade through curl", async ($, on) => {
    const { env, session, asked, runs, lemonade: server } = world(on, { ...WINDOWS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, { installed: true })
    await start($)
    expect(env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')).toBe('Qwen3.5-4B-GGUF')
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF @ http://127.0.0.1:13305'])
    expect(runs).toEqual([])
    expect(server.curled).toContain('GET /api/v1/models?show_all=true')
    // Going back to Claude keeps the person's flag.
    session.model = 'claude-opus-5-5'
    await step($)
    expect(env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe('1')
  })

  test('a download goes out through curl too', async ($, on) => {
    const { lemonade: server } = world(on, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    await start($)
    const ui = await manager($, 'desktop')
    await ui.press({ key: 'group-llamacpp' })
    await ui.press({ key: 'get-Not-Pulled-GGUF' })
    expect(server.pulls).toEqual([{ model_name: 'Not-Pulled-GGUF', stream: true, subscribe: false }])
    expect(server.curled).toContain('POST /api/v1/pull')
  })
})

describe('which models count', () => {
  test('a downloaded model pulled without labels is one requests can go to', async ($, on) => {
    const { asked, lemonade: server } = world(on)
    server.models.push({ id: 'user.Phi-4-Mini-GGUF', size: 2.5, downloaded: true, suggested: false, recipe: 'llamacpp', labels: [] })
    await start($)
    expect((await lemonade($, 'phi')).text).toContain('now offers 🍋 user.Phi-4-Mini-GGUF')
    await lemonade($, 'on')
    await step($)
    expect(asked).toEqual(['user.Phi-4-Mini-GGUF @ http://127.0.0.1:13305'])
  })
})

describe('sharing Lemonade', () => {
  test('a model not loaded is loaded explicitly, with a bounded window, pinned', async ($, on) => {
    const { session, asked, toasts, lemonade: server } = world(on)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(server.loads).toEqual([{ model_name: 'Gemma-Chat-GGUF', ctx_size: 65536, pinned: true }])
    expect(server.loaded).toEqual([{ model_name: 'Gemma-Chat-GGUF', type: 'llm', pinned: true, recipe_options: { ctx_size: 65536 }, pid: 4242 }])
    expect(asked).toEqual(['Gemma-Chat-GGUF @ http://127.0.0.1:13305'])
    // Qwen was unpinned and nobody's LemonClaude knew: it made room, and the toast says so.
    expect(toasts.some(t => t.includes('Loaded Gemma-Chat-GGUF with a 64K window. Lemonade unloaded Qwen3.5-4B-GGUF to make room.'))).toBe(true)
  })

  test('LEMONCLAUDE_CTX_SIZE sets the window, never under 4096', async ($, on) => {
    const { session, lemonade: server } = world(on, { LEMONCLAUDE_CTX_SIZE: '1024' })
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(server.loads[0]?.ctx_size).toBe(4096)
  })

  test('a model loaded already is pinned, never loaded again', async ($, on) => {
    const { session, lemonade: server } = world(on)
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    await step($, session.model)
    expect(server.loads).toEqual([])
    expect(server.pins).toEqual([{ model_name: 'Qwen3.5-4B-GGUF', pinned: true }])
  })

  test('a model not downloaded is never loaded, which would download it', async ($, on) => {
    // Offered from memory while Lemonade was down, and since deleted from Lemonade's disk.
    const lastOffer = { id: 'Not-Pulled-GGUF', labels: ['chat'], recipe: 'llamacpp', isDownloaded: true, hasTools: true, isLoaded: false }
    const { session, toasts, lemonade: server } = world(on, WINDOWS, { reachable: false, installed: true, store: { lastOffer } })
    await start($)
    session.model = 'Not-Pulled-GGUF'
    await step($, session.model)
    expect(server.loads).toEqual([])
    expect(toasts.some(t => t.includes("Not-Pulled-GGUF isn't downloaded. Download it from /lemonade first."))).toBe(true)
  })

  test('the pin is given back on /lemonade off, and the model stays loaded', async ($, on) => {
    const { lemonade: server } = world(on)
    await start($)
    await lemonade($, 'on')
    expect(server.loaded[0]?.pinned).toBe(true)
    await lemonade($, 'off')
    expect(server.pins.at(-1)).toEqual({ model_name: 'Qwen3.5-4B-GGUF', pinned: false })
    expect(server.loaded.map(m => m.model_name)).toEqual(['Qwen3.5-4B-GGUF'])
  })

  test('the pin is given back when the session ends', async ($, on) => {
    const { lemonade: server } = world(on)
    await start($)
    await lemonade($, 'on')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { kind: 'none' } as never })
    expect(server.pins.at(-1)).toEqual({ model_name: 'Qwen3.5-4B-GGUF', pinned: false })
  })

  test('the pin is given back when a Claude model is picked in the selector', async ($, on) => {
    const { session, lemonade: server } = world(on)
    await start($)
    session.model = 'Qwen3.5-4B-GGUF'
    await step($, session.model)
    expect(server.loaded[0]?.pinned).toBe(true)
    session.model = 'claude-opus-5-5'
    await step($)
    expect(server.loaded[0]?.pinned).toBe(false)
  })

  test('switching Lemonade models moves the pin, through the one slot', async ($, on) => {
    const { session, asked, lemonade: server } = world(on)
    await start($)
    await lemonade($, 'on')
    await step($)
    await lemonade($, 'on gemma')
    await step($)
    expect(asked).toEqual(['Qwen3.5-4B-GGUF @ http://127.0.0.1:13305', 'Gemma-Chat-GGUF @ http://127.0.0.1:13305'])
    expect(server.loaded).toEqual([{ model_name: 'Gemma-Chat-GGUF', type: 'llm', pinned: true, recipe_options: { ctx_size: 65536 }, pid: 4242 }])
    expect(session.model).toBe('claude-opus-5-5')
  })

  test("another app's pin is never touched, and its conflict is named exactly, once", async ($, on) => {
    const { session, toasts, lemonade: server } = world(on, {}, { failSteps: true })
    server.loaded = [{ model_name: 'Their-Model-GGUF', type: 'llm', pinned: true, recipe_options: { ctx_size: 8192 } }]
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await Promise.all([step($, session.model), step($, 'claude-haiku-4-5', 'agent-1')])
    const said = toasts.filter(t => t.includes('Another app has pinned'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("Another app has pinned Lemonade's chat models (Their-Model-GGUF), so Gemma-Chat-GGUF can't load.")
    expect(toasts.some(t => t.includes("didn't answer"))).toBe(false)
    expect(server.loaded.map(m => [m.model_name, m.pinned])).toEqual([['Their-Model-GGUF', true]])
    expect(server.pins).toEqual([])
    // Going back to Claude leaves their pin alone too.
    session.model = 'claude-opus-5-5'
    await step($)
    expect(server.pins).toEqual([])
  })

  test('a model that fit says nothing more', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    server.gpu = gpu(2400, 150)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(toasts.some(t => t.includes('Loaded Gemma-Chat-GGUF with a 64K window.'))).toBe(true)
    expect(toasts.some(t => t.includes('system memory'))).toBe(false)
  })

  test('a model Windows paged partly into system memory says it will be slow', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    // As seen live with another server busy on the RTX: half the model's memory was borrowed.
    server.gpu = gpu(3008, 3150)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(
      toasts.some(t =>
        t.includes('About 3.1 GB of it is in system memory because the GPU is full, so it will be slow. Free GPU memory, lower LEMONCLAUDE_CTX_SIZE, or pick a smaller model.'),
      ),
    ).toBe(true)
  })

  test('a model llama.cpp fit partly into system RAM says so too', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    // Gemma is 2.1 GB, but its process holds only 600 MB on the GPU.
    server.gpu = gpu(600, 150)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(toasts.some(t => t.includes('About 1.5 GB of it is in system memory because the GPU is full'))).toBe(true)
  })

  test('a model that fits only because Windows paged an idle program out says the GPU is overcommitted', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    // As seen live: the new model got 6 GB of the RTX's own memory, but an idle server's 13.4 GB is
    // still committed to the card, which has 8.
    server.gpu = gpu(6002, 154, 0, 0, 6157 + 13400)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(
      toasts.some(t =>
        t.includes(
          'The GPU is overcommitted by about 11.1 GB: when the programs on it are busy at once, Windows swaps them through system memory, and this model will be slow.',
        ),
      ),
    ).toBe(true)
  })

  test('staging buffers a little over the card are not overcommitment', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    server.gpu = gpu(8000, 150, 0, 0, 8192 + 200)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(toasts.some(t => t.includes('overcommitted') || t.includes('system memory'))).toBe(false)
  })

  test('an integrated GPU, which borrows memory by design, says nothing', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    server.gpu = gpu(0, 0, 300, 3000)
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(toasts.some(t => t.includes('system memory'))).toBe(false)
  })

  test('counters it cannot read say nothing', async ($, on) => {
    const { toasts, session, lemonade: server } = world(on, WINDOWS)
    server.loaded = []
    await start($)
    session.model = 'Gemma-Chat-GGUF'
    await step($, session.model)
    expect(toasts.some(t => t.includes('system memory'))).toBe(false)
    expect(toasts.some(t => t.includes('Loaded Gemma-Chat-GGUF with a 64K window.'))).toBe(true)
  })

  test('a load that runs out of GPU memory says so, and how to make room', async ($, on) => {
    const { asked, lemonade: server } = world(on)
    server.loaded = []
    server.loadError = 'llama-server failed to start: CUDA error: out of memory'
    await start($)
    const { text } = await lemonade($, 'on gemma')
    expect(text).toBe(
      "Lemonade couldn't load Gemma-Chat-GGUF: llama-server failed to start: CUDA error: out of memory " +
        'Not enough GPU memory: another app may be using it. Free some, lower LEMONCLAUDE_CTX_SIZE (now 65536), or pick a smaller model.',
    )
    await step($)
    expect(asked).toEqual(['claude-opus-5-5 @ default'])
  })

  test('any other load failure is passed on as Lemonade says it', async ($, on) => {
    const { lemonade: server } = world(on)
    server.loaded = []
    server.loadError = 'backend llamacpp:cuda is not installed'
    await start($)
    expect((await lemonade($, 'on gemma')).text).toBe("Lemonade couldn't load Gemma-Chat-GGUF: backend llamacpp:cuda is not installed")
  })

  test("the conflict names only the pinned chat models, not another app's speech or image ones", async ($, on) => {
    const { lemonade: server } = world(on)
    // As seen live: Whisper, SD-Turbo and a chat model, all pinned by another app.
    server.loaded = [
      { model_name: 'Whisper-Large-v3-Turbo', type: 'transcription', pinned: true, recipe_options: { ctx_size: 4096 } },
      { model_name: 'SD-Turbo-GGUF', type: 'image', pinned: true, recipe_options: { ctx_size: 4096 } },
      { model_name: 'Their-Model-GGUF', type: 'llm', pinned: true, recipe_options: { ctx_size: 32768 } },
    ]
    await start($)
    const { text } = await lemonade($, 'on gemma')
    expect(text).toContain("Another app has pinned Lemonade's chat models (Their-Model-GGUF), so Gemma-Chat-GGUF can't load.")
    expect(server.loaded.map(m => [m.model_name, m.pinned])).toEqual([
      ['Whisper-Large-v3-Turbo', true],
      ['SD-Turbo-GGUF', true],
      ['Their-Model-GGUF', true],
    ])
  })

  test('/lemonade on says the conflict and stays off', async ($, on) => {
    const { asked, lemonade: server } = world(on)
    server.loaded = [{ model_name: 'Their-Model-GGUF', type: 'llm', pinned: true, recipe_options: { ctx_size: 8192 } }]
    await start($)
    const { text } = await lemonade($, 'on gemma')
    expect(text).toContain('Another app has pinned')
    await step($)
    expect(asked).toEqual(['claude-opus-5-5 @ default'])
  })

  test('the model manager marks a model another app pinned', async ($, on) => {
    const { lemonade: server } = world(on)
    server.loaded = [{ model_name: 'Gemma-Chat-GGUF', type: 'llm', pinned: true, recipe_options: { ctx_size: 8192 } }]
    await start($)
    const ui = await manager($, 'desktop')
    expect((await ui.find({ key: 'row-Gemma-Chat-GGUF' }))?.text).toContain('pinned by another app')
  })

  test("another plugin's agent steps pass untouched: no rename, no load, no routing", async ($, on) => {
    const { asked, agents, lemonade: server } = world(on)
    agents.push({ id: 'agent-9', type: 'other:worker', description: 'local worker', status: 'running' })
    await start($)
    await lemonade($, 'on gemma')
    server.loads.length = 0
    server.pins.length = 0
    await step($, 'claude-haiku-4-5', 'agent-9')
    expect(asked).toEqual(['claude-haiku-4-5 @ http://127.0.0.1:13305'])
    expect(server.loads).toEqual([])
    expect(server.pins).toEqual([])
  })

  test('a collection is loaded once, though /health lists only its components', async ($, on) => {
    const { session, lemonade: server } = world(on)
    server.models.push({ id: 'Omni-Collection', size: 9, downloaded: true, suggested: true, recipe: 'collection.omni', labels: ['chat'] })
    await start($)
    session.model = 'Omni-Collection'
    await step($, session.model)
    // As Lemonade does: the collection's components are what's loaded.
    server.loaded = [{ model_name: 'Omni-Part-GGUF', type: 'llm', pinned: false, recipe_options: { ctx_size: 65536 } }]
    await step($, session.model)
    await step($, session.model)
    expect(server.loads.filter(l => l.model_name === 'Omni-Collection')).toHaveLength(1)
  })

  test('a model downloaded since the catalog was read is loaded, not refused', async ($, on) => {
    const { session, toasts, lemonade: server } = world(on)
    await start($)
    await lemonade($, '')
    server.models.find(m => m.id === 'Not-Pulled-GGUF')!.downloaded = true
    server.loaded = []
    await lemonade($, 'on Not-Pulled')
    expect(server.loads.map(l => l.model_name)).toEqual(['Not-Pulled-GGUF'])
    expect(toasts.some(t => t.includes("isn't downloaded"))).toBe(false)
    expect(session.model).toBe('claude-opus-5-5')
  })

  test("a pin a crashed session left an hour ago is given back at the next start", async ($, on) => {
    const { lemonade: server } = world(on, {}, { store: { pinned: { 'Qwen3.5-4B-GGUF': Date.now() - 2 * 60 * 60 * 1000 } } })
    server.loaded[0]!.pinned = true
    await start($)
    expect(server.pins).toEqual([{ model_name: 'Qwen3.5-4B-GGUF', pinned: false }])
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
