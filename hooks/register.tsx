import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DownloadState, LemonadeModel, SavedEnv } from '../types'

const DEFAULT_BASE_URL = 'http://127.0.0.1:13305'
const DEFAULT_MODEL = 'Qwen3.5-4B-GGUF'
const START_TIMEOUT_S = 60
const DEFAULT_CTX_SIZE = 65536
const MIN_CTX_SIZE = 4096
// A pin LemonClaude holds that no request has used for this long belongs to a session that ended
// without saying so (a crash), and is given back.
const STALE_PIN_MS = 60 * 60 * 1000

const offered = atom({ plugin: 'lemonclaude', key: 'offered' } as const, null as string | null)
const routed = atom({ plugin: 'lemonclaude', key: 'routed' } as const, null as string | null)
const saved = atom({ plugin: 'lemonclaude', key: 'saved' } as const, null as SavedEnv | null)
const notice = atom({ plugin: 'lemonclaude', key: 'notice' } as const, '')
const heldOver = atom({ plugin: 'lemonclaude', key: 'heldOver' } as const, null as string | null)
const catalog = atom({ plugin: 'lemonclaude', key: 'catalog' } as const, [] as LemonadeModel[])
const downloads = atom({ plugin: 'lemonclaude', key: 'downloads' } as const, {} as Record<string, DownloadState>)
const search = atom({ plugin: 'lemonclaude', key: 'search' } as const, '')
const isDownloadedOnly = atom({ plugin: 'lemonclaude', key: 'isDownloadedOnly' } as const, false)
const expanded = atom({ plugin: 'lemonclaude', key: 'expanded' } as const, [] as string[])

type $ = EngineInterface

// Labels Lemonade gives models that are not chat LLMs, even alongside `chat`.
const NOT_CHAT = [
  'transcription',
  'realtime-transcription',
  'image',
  'tts',
  'embeddings',
  'reranking',
  'classification',
  'audio-generation',
  'voice-design',
  'upscaling',
  '3d',
]

// Lemonade's own names for its recipes, as its model manager groups them.
const RECIPES: Record<string, string> = {
  'collection.omni': 'Lemonade',
  flm: 'FastFlowLM NPU',
  llamacpp: 'Llama.cpp GPU',
  onnxruntime: 'ONNX Runtime',
  'ryzenai-llm': 'Ryzen AI LLM',
}

async function baseUrl($: $): Promise<string> {
  const fromEnv = await $.env.get('LEMONADE_BASE_URL')
  return (fromEnv ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
}

type Answer = { ok: boolean; status: number; text: string }

/**
 * A request to Lemonade. Some Claude Code versions (2.1.287) refuse a plugin's own requests while
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set (people set it for privacy, and `lemonade launch
 * claude` does), so a refused one goes out through curl instead: Lemonade is this mod's essential traffic.
 * Rejects when Lemonade can't be reached either way.
 */
async function askLemonade($: $, url: string, init: { method?: string; body?: string } = {}): Promise<Answer> {
  const headers = init.body ? { 'Content-Type': 'application/json' } : undefined
  try {
    return await $.http.fetch(url, { ...init, ...(headers ? { headers } : {}) })
  } catch (err) {
    if (!/nonessential/i.test(String(err))) throw err
  }
  const argv = ['curl', '-sS', '-m', '20', '-X', init.method ?? 'GET', '-w', '\n%{http_code}']
  if (init.body) argv.push('-H', 'Content-Type: application/json', '--data-binary', '@-')
  const ran = await $.process.run([...argv, url], { ...(init.body ? { stdin: init.body } : {}), timeoutMs: 25_000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `curl exited ${ran.exitCode}`)
  const cut = ran.stdout.lastIndexOf('\n')
  const status = Number(ran.stdout.slice(cut + 1))
  return { ok: status >= 200 && status < 300, status, text: ran.stdout.slice(0, cut) }
}

/** `text` parsed, or undefined when it isn't JSON: a side answer that can't be read is one not had. */
function parsed(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Why Lemonade couldn't be reached, in a line: the engine's wrapping and repeats cut away. */
function unreachable(base: string, err: unknown): string {
  const said = String(err instanceof Error ? err.message : err)
  if (/ECONNREFUSED|Couldn't connect|Failed to connect/i.test(said)) return `Lemonade isn't running at ${base}.`
  return `Lemonade isn't reachable at ${base}: ${said.replace(/^.*?failed: /, '')}`
}

/**
 * Lemonade's chat models, downloaded or suggested, by name; throws when the server is unreachable.
 * Speech, image and music models are no use to Claude Code. A suggested model counts when Lemonade
 * labels it `chat`; a downloaded one also when it has no label saying otherwise, as a model pulled
 * without labels gets its recipe's default, chat for an LLM recipe.
 */
export async function listCatalog($: $, base: string): Promise<LemonadeModel[]> {
  const listed = await askLemonade($, `${base}/api/v1/models?show_all=true`)
  if (!listed.ok) throw new Error(`Lemonade answered ${listed.status} at ${base}/api/v1/models`)
  const data = (JSON.parse(listed.text).data ?? []) as Array<{
    id: string
    size?: number
    labels?: string[]
    recipe?: string
    downloaded?: boolean
    suggested?: boolean
  }>

  const [now, system, held] = await Promise.all([
    loadedNow($, base),
    askLemonade($, `${base}/api/v1/system-info`).catch(() => undefined),
    ours($),
  ])
  const loaded = new Map((now ?? []).map(m => [m.model_name, m]))
  // Recipes this machine can't run on any backend, as Lemonade judges it: their models are no use here.
  let cannot = new Set<string>()
  const recipes = (system?.ok ? parsed(system.text)?.recipes : undefined) as
    | Record<string, { backends?: Record<string, { state?: string }> }>
    | undefined
  if (recipes) {
    cannot = new Set(
      Object.entries(recipes)
        .filter(([, r]) => {
          const states = Object.values(r.backends ?? {}).map(b => b.state)
          return states.length > 0 && states.every(state => state === 'unsupported')
        })
        .map(([name]) => name),
    )
  }

  return data
    .filter(m => !(m.labels ?? []).some(l => NOT_CHAT.includes(l)))
    .filter(m => m.downloaded !== false || !cannot.has(m.recipe ?? ''))
    .filter(m => (m.downloaded !== false ? true : m.suggested !== false && (m.labels ?? []).includes('chat')))
    .map(m => ({
      id: m.id,
      size: m.size,
      labels: m.labels ?? [],
      recipe: m.recipe ?? '',
      isDownloaded: m.downloaded !== false,
      hasTools: (m.labels ?? []).includes('tool-calling'),
      isLoaded: loaded.has(m.id),
      ...(loaded.get(m.id)?.pinned ? { pin: m.id in held ? ('mine' as const) : ('theirs' as const) } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }))
}

/** The catalog's downloaded models, the ones requests can go to, tool-calling ones first. */
function downloadedOf(all: readonly LemonadeModel[]): LemonadeModel[] {
  return all.filter(m => m.isDownloaded).sort((a, b) => Number(b.hasTools) - Number(a.hasTools) || a.id.localeCompare(b.id))
}

/** The downloaded models as last fetched. */
async function models($: $): Promise<LemonadeModel[]> {
  return downloadedOf(await read($, catalog))
}

/** Refreshes the catalog and resolves its downloaded models; on failure keeps the last ones and says why. */
async function refresh($: $): Promise<LemonadeModel[]> {
  const base = await baseUrl($)
  try {
    const all = await listCatalog($, base)
    await update($, catalog, () => all)
    await update($, notice, () => '')
    return downloadedOf(all)
  } catch (err) {
    await update($, notice, () => unreachable(base, err))
    return models($)
  }
}

/**
 * Reads Lemonade's server-owned downloads into `downloads` once, and refreshes the lists when one
 * finished; true while one still runs.
 */
async function pollDownloads($: $): Promise<boolean> {
  const base = await baseUrl($)
  const listed = await askLemonade($, `${base}/api/v1/downloads`).catch(() => undefined)
  const jobs = (listed?.ok ? parsed(listed.text) : undefined) as Array<{
    model_name: string
    status: string
    running?: boolean
    percent?: number
    complete?: boolean
    error?: string
  }> | undefined
  if (!Array.isArray(jobs)) return false
  let finished: string[] = []
  // Merged into what is there now, not a copy read earlier: a press of Download can land in between.
  const now = await update($, downloads, before => {
    finished = []
    const next: Record<string, DownloadState> = {}
    for (const job of jobs) {
      if (job.complete || job.status === 'completed') {
        if (before[job.model_name]) finished.push(job.model_name)
        continue
      }
      if (job.status === 'cancelled') continue
      next[job.model_name] = { percent: job.percent ?? 0, status: job.status, ...(job.error ? { error: job.error } : {}) }
    }
    for (const [id, d] of Object.entries(before)) {
      if (id in next || finished.includes(id)) continue
      // A pull on its way to Lemonade isn't listed yet, and a pull Lemonade refused never will be.
      if (d.status === 'starting' || d.status === 'error') next[id] = d
      // One Lemonade listed and dropped finished between two polls.
      else if (d.status === 'downloading') finished.push(id)
    }
    return next
  })
  if (finished.length > 0) {
    await refresh($)
    $.ui.toast(`Downloaded ${finished.join(', ')}. Press Use in /lemonade to switch to it.`)
  }
  return jobs.some(j => j.running) || Object.values(now).some(d => d.status === 'downloading' || d.status === 'starting')
}

// One poll at a time while Lemonade downloads; a module variable, so a reload starts it again.
let poller: { cancel: () => void } | null = null

/** Polls Lemonade's downloads each second until none runs. */
function watchDownloads($: $): void {
  if (poller) return
  poller = $.clock.every(1000, () =>
    void pollDownloads($)
      .catch(() => false)
      .then(isRunning => {
        if (isRunning) return
        poller?.cancel()
        poller = null
      }),
  )
}

function recipeName(recipe: string): string {
  return RECIPES[recipe] ?? (recipe || 'Other')
}

/** A size in GB as Lemonade's model manager shows it: MB under a gigabyte. */
function formatSize(gb?: number): string {
  if (gb === undefined) return ''
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb.toFixed(2)} GB`
}

function tags(m: LemonadeModel): string {
  const pin = m.pin === 'theirs' ? 'pinned by another app' : m.pin === 'mine' ? 'pinned' : ''
  return [m.hasTools ? 'tools' : '', ...['vision', 'reasoning', 'coding'].filter(l => m.labels.includes(l)), pin]
    .filter(Boolean)
    .join(' · ')
}

/** The message in a Lemonade error body (`{ error }`, `{ error: { message } }` or `{ message }`), if it has one. */
function errorOf(text: string): string | undefined {
  const body = parsed(text) as { error?: unknown; message?: unknown } | undefined
  const error = body?.error as { message?: unknown } | string | undefined
  const said = typeof error === 'object' && error !== null ? error.message : (error ?? body?.message)
  return typeof said === 'string' ? said : undefined
}

/** Starts a server-owned download of `id`, which Lemonade keeps going whatever happens to this session. */
async function download($: $, id: string): Promise<void> {
  const base = await baseUrl($)
  // `starting` until Lemonade has the job: a poll before then must not take its absence for a finish.
  await update($, downloads, d => ({ ...d, [id]: { percent: 0, status: 'starting' } }))
  const started = await askLemonade($, `${base}/api/v1/pull`, {
    method: 'POST',
    body: JSON.stringify({ model_name: id, stream: true, subscribe: false }),
  }).catch((err: unknown): Answer => ({ ok: false, status: 0, text: unreachable(base, err) }))
  if (!started.ok) {
    const error = errorOf(started.text) ?? (started.status ? `Lemonade answered ${started.status}` : started.text)
    await update($, downloads, d => ({ ...d, [id]: { percent: 0, status: 'error', error } }))
    return
  }
  await update($, downloads, d => (d[id]?.status === 'starting' ? { ...d, [id]: { percent: 0, status: 'downloading' } } : d))
  watchDownloads($)
}

/** A model Lemonade has in memory, as /api/v1/health lists it. */
type Loaded = { model_name: string; pinned?: boolean; type?: string; pid?: number }

/** What Lemonade has loaded now, or null when it doesn't answer. */
async function loadedNow($: $, base: string): Promise<Loaded[] | null> {
  const health = await askLemonade($, `${base}/api/v1/health`).catch(() => undefined)
  if (!health?.ok) return null
  const all = parsed(health.text)?.all_models_loaded
  return Array.isArray(all) ? (all as Loaded[]) : []
}

async function answers($: $, base: string): Promise<boolean> {
  return (await loadedNow($, base)) !== null
}

/** The context window LemonClaude loads models with: LEMONCLAUDE_CTX_SIZE (at least 4096), else 64K. */
async function ctxSize($: $): Promise<number> {
  const said = Number(await $.env.get('LEMONCLAUDE_CTX_SIZE'))
  return Number.isInteger(said) && said > 0 ? Math.max(MIN_CTX_SIZE, said) : DEFAULT_CTX_SIZE
}

function windowName(ctx: number): string {
  return ctx % 1024 === 0 ? `${ctx / 1024}K` : `${ctx}-token`
}

/**
 * The models LemonClaude pinned, with when a request last used each. Only these are ever unpinned:
 * a pin another app holds is that app's. In the store, so a restarted session still knows them.
 */
async function ours($: $): Promise<Record<string, number>> {
  const held = await $.store.get('pinned')
  return held && typeof held === 'object' ? { ...(held as Record<string, number>) } : {}
}

async function remember($: $, model: string, isPinned: boolean): Promise<void> {
  const held = await ours($)
  if (isPinned) held[model] = Date.now()
  else delete held[model]
  await $.store.set('pinned', held)
}

async function setPin($: $, base: string, model: string, pinned: boolean): Promise<boolean> {
  const answer = await askLemonade($, `${base}/internal/pin`, {
    method: 'POST',
    body: JSON.stringify({ model_name: model, pinned }),
  }).catch(() => undefined)
  return answer?.ok === true
}

/** Unpins `model` if LemonClaude pinned it. It stays loaded, warm for whoever wants it next. */
async function release($: $, model: string): Promise<void> {
  collections.delete(model)
  if (!(model in (await ours($)))) return
  await setPin($, await baseUrl($), model, false)
  await remember($, model, false)
}

const GB = 1024 ** 3
const MB = 1024 ** 2

/**
 * How much of the model a Lemonade backend process (`pid`) runs sits in system memory because its GPU
 * is full, in bytes, or 0. Windows never fails such a load: llama.cpp puts layers in system RAM, or
 * Windows pages the process's GPU memory there, and the model answers slowly. Windows' per-process
 * GPU counters say what this process holds on each GPU, its own memory and memory it borrows; whole-
 * GPU totals can't, since Windows pages an idle program out to let a busy one in. The process spilled
 * when it borrows over 512 MB (a backend's staging buffers take 100-350 MB), or when it holds under
 * 60% of the model's size on a GPU at all. A GPU with under 2 GB of its own, an integrated one that
 * borrows by design, says nothing. Null-free: anything unreadable (not Windows, counters under another
 * language's names) is 0.
 */
async function spilled($: $, pid: number, sizeGb: number | undefined): Promise<number> {
  if (!(await $.env.get('LOCALAPPDATA'))) return 0
  const script = String.raw`$owner = ${pid}
(Get-Counter '\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.Path -match "pid_$($owner)_" } | ForEach-Object { 'process|' + $_.Path + '|' + [int64]$_.CookedValue }
Get-ChildItem HKLM:\SOFTWARE\Microsoft\DirectX -ErrorAction SilentlyContinue | ForEach-Object { $a = Get-ItemProperty $_.PSPath; if ($a.AdapterLuid) { 'adapter|luid_0x{0:x8}_0x{1:x8}|{2}' -f ($a.AdapterLuid -shr 32), ($a.AdapterLuid -band 0xffffffff), [int64]$a.DedicatedVideoMemory } }`
  const ran = await $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '-'], { stdin: `${script}\n`, timeoutMs: 15_000 })
    .catch(() => undefined)
  if (!ran || ran.exitCode !== 0) return 0
  const held = new Map<string, { dedicated: number; shared: number }>()
  const own = new Map<string, number>()
  for (const line of ran.stdout.split(/\r?\n/)) {
    const usage = /pid_\d+_(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+\)\\(dedicated|shared) usage\|(\d+)/i.exec(line)
    if (usage) {
      const on = held.get(usage[1]!) ?? { dedicated: 0, shared: 0 }
      on[usage[2]!.toLowerCase() as 'dedicated' | 'shared'] += Number(usage[3])
      held.set(usage[1]!, on)
    }
    const adapter = /^adapter\|(luid_0x[0-9a-f]+_0x[0-9a-f]+)\|(\d+)/i.exec(line)
    if (adapter) own.set(adapter[1]!, Number(adapter[2]))
  }
  // The GPU this process uses most.
  let gpu: { adapter: string; dedicated: number; shared: number } | undefined
  for (const [adapter, on] of held) {
    if (!gpu || on.dedicated + on.shared > gpu.dedicated + gpu.shared) gpu = { adapter, ...on }
  }
  if (!gpu || gpu.dedicated + gpu.shared < 256 * MB || (own.get(gpu.adapter) ?? 0) < 2 * GB) return 0
  if (gpu.shared > 512 * MB) return gpu.shared
  const size = (sizeGb ?? 0) * GB
  return size > 0 && gpu.dedicated < 0.6 * size ? size - gpu.dedicated : 0
}

/** How loading a model for requests went: ready or not, and what to tell the person. */
type LoadOutcome = { ok: boolean; message?: string }

// One load per model at a time: a main step and its subagents' steps arrive together.
const loading = new Map<string, Promise<LoadOutcome>>()

// Collections LemonClaude loaded. /health lists a collection's components, never the collection, so
// without this every step would load it again. A failed request forgets it, so the next one reloads.
const collections = new Set<string>()

/**
 * Makes `model` ready for requests, the way an app sharing Lemonade should: loads it explicitly with
 * a bounded window and pinned, or pins it when it is already loaded, so other apps' loads can't evict
 * it. Lemonade's own auto-load would take the largest window and evict others without a word.
 */
function ensureLoaded($: $, model: string): Promise<LoadOutcome> {
  let pending = loading.get(model)
  if (!pending) {
    pending = loadModel($, model).finally(() => loading.delete(model))
    loading.set(model, pending)
  }
  return pending
}

function isSlotsPinned(answer: Answer): boolean {
  return answer.status === 409 && (parsed(answer.text)?.error as { code?: unknown } | undefined)?.code === 'slots_pinned_error'
}

async function loadModel($: $, model: string): Promise<LoadOutcome> {
  const base = await baseUrl($)
  const before = await loadedNow($, base)
  // Not answering: ensureServer has said why, or the request's failure will.
  if (before === null) return { ok: false }
  const mineBefore = await ours($)

  if (collections.has(model)) return { ok: true }
  const here = before.find(m => m.model_name === model)
  if (here) {
    // Loaded already: pin it, never load it again, which would reload it with another window.
    if (!here.pinned && (await setPin($, base, model, true))) await remember($, model, true)
    else if (model in mineBefore && Date.now() - mineBefore[model]! > 60_000) await remember($, model, true)
    return { ok: true }
  }

  // Loading a model Lemonade hasn't downloaded would download it, gigabytes: never do that unasked.
  // A catalog fetched earlier can miss a model downloaded since: look again before saying no.
  const listed = (await read($, catalog)).find(m => m.id === model)
  if (!listed?.isDownloaded) await refresh($)
  const known = (await read($, catalog)).find(m => m.id === model)
  if (!known) return { ok: false, message: `Lemonade lists no model named ${model}.` }
  if (!known.isDownloaded) return { ok: false, message: `${model} isn't downloaded. Download it from /lemonade first.` }

  const ctx = await ctxSize($)
  const load = () =>
    askLemonade($, `${base}/api/v1/load`, {
      method: 'POST',
      body: JSON.stringify({ model_name: model, ctx_size: ctx, pinned: true }),
    }).catch((err: unknown): Answer => ({ ok: false, status: 0, text: JSON.stringify({ error: unreachable(base, err) }) }))
  let answer = await load()
  if (isSlotsPinned(answer)) {
    // LemonClaude's own pin on the model it is leaving can hold the slot: give it back, and try again.
    const leaving = before.filter(m => m.pinned && m.model_name !== model && m.model_name in mineBefore)
    if (leaving.length > 0) {
      for (const m of leaving) await release($, m.model_name)
      answer = await load()
    }
  }
  if (isSlotsPinned(answer)) {
    const held = await ours($)
    const pinned = ((await loadedNow($, base)) ?? before).filter(m => m.pinned && !(m.model_name in held)).map(m => m.model_name)
    return {
      ok: false,
      message:
        `Another app has pinned Lemonade's chat models (${pinned.join(', ') || 'unnamed'}), so ${model} can't load. ` +
        `Unload them in that app, raise Lemonade's max_loaded_models, or pick a Claude model.`,
    }
  }
  if (!answer.ok) {
    const why = errorOf(answer.text) ?? `it answered ${answer.status}`
    // Another Lemonade server, or any other program, can hold the GPU memory this load needed: Lemonade
    // can't see it, so the load fails rather than getting a clean conflict.
    const isMemory = /out of memory|\boom\b|failed to allocate|cudaMalloc|insufficient memory|not enough memory|ErrorOutOfDeviceMemory/i.test(why)
    const hint = isMemory
      ? ` Not enough GPU memory: another app may be using it. Free some, lower LEMONCLAUDE_CTX_SIZE (now ${ctx}), or pick a smaller model.`
      : ''
    return { ok: false, message: `Lemonade couldn't load ${model}: ${why}${hint}` }
  }

  await remember($, model, true)
  if (known.recipe.startsWith('collection.')) collections.add(model)
  const after = (await loadedNow($, base)) ?? []
  // Another app's model that made room: unpinned, not LemonClaude's, and gone now.
  const gone = before
    .filter(m => !m.pinned && !(m.model_name in mineBefore) && !after.some(a => a.model_name === m.model_name))
    .map(m => m.model_name)
  await refresh($)
  const room = gone.length > 0 ? ` Lemonade unloaded ${gone.join(', ')} to make room.` : ''
  // Whether it fit: the process that runs it, on this machine, measured on Windows.
  const pid = after.find(m => m.model_name === model)?.pid
  const outside = pid && (await isLocal($)) ? await spilled($, pid, known.size) : 0
  const slow =
    outside > 0
      ? ` About ${(outside / GB).toFixed(1)} GB of it is in system memory because the GPU is full, so it will be slow. ` +
        `Free GPU memory, lower LEMONCLAUDE_CTX_SIZE, or pick a smaller model.`
      : ''
  return { ok: true, message: `Loaded ${model} with a ${windowName(ctx)} window.${room}${slow}` }
}

// The last toast and when: requests that arrive together (a step and its subagents') say a thing once.
let lastSaid = { text: '', at: 0 }

function say($: $, text: string): void {
  const now = Date.now()
  if (text === lastSaid.text && now - lastSaid.at < 10_000) return
  lastSaid = { text, at: now }
  $.ui.toast(text)
}

/**
 * True for a subagent of another plugin's agent type (`other:worker`): that plugin answers its steps
 * itself, perhaps from a local model of its own, so LemonClaude leaves them untouched.
 */
async function isOthersAgent($: $, agentId: string): Promise<boolean> {
  // A list that can't be read means no agent known to be another's: the step routes as any other.
  const agent = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)
  return agent !== undefined && agent.type.includes(':') && !agent.type.startsWith('lemonclaude:')
}

/**
 * LemonadeServer.exe where Lemonade's Windows installer puts it, or null when LemonClaude shouldn't
 * start a server: none installed there, a server that isn't on this machine, or LEMONCLAUDE_AUTOSTART=0.
 */
/** True when Lemonade is on this machine, by LEMONADE_BASE_URL. */
async function isLocal($: $): Promise<boolean> {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(await baseUrl($))
}

async function serverExe($: $): Promise<string | null> {
  if ((await $.env.get('LEMONCLAUDE_AUTOSTART')) === '0') return null
  if (!(await isLocal($))) return null
  const appData = await $.env.get('LOCALAPPDATA')
  if (!appData) return null
  const exe = `${appData}\\lemonade_server\\bin\\LemonadeServer.exe`
  return (await $.fs.exists(exe)) ? exe : null
}

// One start at a time: subagents' requests can find the server down together.
let starting: Promise<boolean> | null = null

/** Starts Lemonade Server and resolves true once it answers, false when it didn't within START_TIMEOUT_S. */
function startServer($: $, exe: string, base: string): Promise<boolean> {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
  // Start-Process detaches the server, so it outlives this session as if started from the Start menu.
  // The wait runs in PowerShell because a $ call costs the hook none of its budget and a sleep would.
  const script = [
    `Start-Process -FilePath ${quote(exe)} -ArgumentList '--silent' -WindowStyle Hidden`,
    `$deadline = (Get-Date).AddSeconds(${START_TIMEOUT_S})`,
    `while ((Get-Date) -lt $deadline) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ${quote(`${base}/api/v1/health`)} | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }`,
    '',
  ].join('\n')
  starting ??= $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdin: script,
      timeoutMs: (START_TIMEOUT_S + 15) * 1000,
    })
    .catch(() => undefined)
    .then(() => answers($, base))
    .finally(() => {
      starting = null
    })
  return starting
}

/**
 * Starts Lemonade Server when it isn't running and LemonClaude can start it. True when a start
 * failed, which it has said in a toast.
 */
async function ensureServer($: $): Promise<boolean> {
  const base = await baseUrl($)
  if (await answers($, base)) return false
  const exe = await serverExe($)
  if (!exe) return false
  $.ui.toast('Starting Lemonade Server…')
  if (!(await startServer($, exe, base))) {
    $.ui.toast(`Lemonade Server didn't answer at ${base} within ${START_TIMEOUT_S} s of starting. Start it yourself, or pick a Claude model.`)
    return true
  }
  await refresh($)
  return false
}

/** The one model `query` names: exact id first, then a unique case-insensitive substring. */
export function pick(list: LemonadeModel[], query: string): LemonadeModel | string {
  const q = query.toLowerCase()
  const exact = list.find(m => m.id.toLowerCase() === q)
  if (exact) return exact
  const hits = list.filter(m => m.id.toLowerCase().includes(q))
  if (hits.length === 1) return hits[0]!
  if (hits.length > 1) return `"${query}" matches ${hits.map(m => m.id).join(', ')}; name one.`
  return `No downloaded Lemonade chat model matches "${query}".`
}

/** A model's size and tool support, and whether it is loaded now unless `isLasting` (the selector keeps it). */
function describeModel(m: LemonadeModel, isLasting = false): string {
  return [formatSize(m.size), m.hasTools ? 'tools' : 'no tools', m.isLoaded && !isLasting ? 'loaded' : ''].filter(Boolean).join(', ')
}

/**
 * Puts `m` in Claude Code's model selector, as the one custom entry it has. `isUp` false marks an
 * entry offered from memory while Lemonade did not answer; `canStart` says picking it starts Lemonade.
 */
async function offer($: $, m: LemonadeModel, isUp = true, canStart = false): Promise<void> {
  const down = canStart ? 'Lemonade not running, starts when picked' : 'Lemonade not running, start it first'
  const detail = isUp ? describeModel(m, true) : [formatSize(m.size), down].filter(Boolean).join(', ')
  await $.env.set('ANTHROPIC_CUSTOM_MODEL_OPTION', m.id)
  await $.env.set('ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', `🍋 ${m.id}`)
  await $.env.set('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', `Local via Lemonade · ${detail}`)
  await update($, offered, () => m.id)
  if (isUp) await $.store.set('lastOffer', { ...m, isLoaded: false })
}

/**
 * What to offer while Lemonade is down: the model offered last time, else LEMONCLAUDE_LEMONADE_MODEL,
 * else the default. Picking it starts Lemonade where LemonClaude can, and fails otherwise, as the entry says.
 */
async function rememberedOffer($: $): Promise<LemonadeModel> {
  const last = (await $.store.get('lastOffer')) as LemonadeModel | undefined
  if (last?.id) return last
  const id = (await $.env.get('LEMONCLAUDE_LEMONADE_MODEL')) ?? DEFAULT_MODEL
  return { id, labels: [], recipe: '', isDownloaded: true, hasTools: true, isLoaded: false }
}

async function snapshot($: $): Promise<SavedEnv> {
  return {
    ANTHROPIC_BASE_URL: (await $.env.get('ANTHROPIC_BASE_URL')) ?? null,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) ?? null,
  }
}

// Claude Code reads ANTHROPIC_BASE_URL per request, so setting it on the running process reroutes the
// next one. Unlike `lemonade launch claude`, the model aliases (ANTHROPIC_DEFAULT_*_MODEL) stay Claude's:
// pointing them at Lemonade would make picking Opus in the selector resolve to the Lemonade model.
// turn.step renames the model on each request instead, subagents included. Nor is
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set: it turns off telemetry and updates, not routing, and
// Claude Code would refuse this mod's own requests to Lemonade under it. Restoring puts back both, as
// saved, so a session an earlier version routed gets its flag back too.
async function applyEnv($: $, env: SavedEnv): Promise<void> {
  await $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL ?? undefined)
  await $.env.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? undefined)
}

/** Sends requests to Lemonade's `model`, or back to Claude for null; a no-op when already so. */
export async function route($: $, model: string | null): Promise<void> {
  const was = await read($, routed)
  if (was === model) return
  if (model) {
    // Keep the environment from before the first switch, so switching between Lemonade models still restores Claude's.
    if ((await read($, saved)) === null) {
      const env = await snapshot($)
      await update($, saved, () => env)
    }
    await $.env.set('ANTHROPIC_BASE_URL', await baseUrl($))
  } else {
    const env = await read($, saved)
    if (env) await applyEnv($, env)
    await update($, saved, () => null as SavedEnv | null)
  }
  await update($, routed, () => model)
  $.ui.status(model ? `🍋 ${model} (Lemonade)` : undefined)
  // Requests left that model: give back its pin, if LemonClaude held it, so other apps can use the slot.
  if (was) await release($, was)
}

/**
 * The Lemonade model the session runs on, or null when it runs on Claude: the offered model while
 * `/lemonade on` holds, else the session's model when it is a Lemonade one. Picking another model in
 * a model picker ends `/lemonade on`, as picking a Claude model leaves 🍋 in the terminal's.
 */
async function lemonadeModelOf($: $, sessionModel: string): Promise<string | null> {
  const over = await read($, heldOver)
  if (over !== null) {
    if (sessionModel === over) return read($, offered)
    await update($, heldOver, () => null as string | null)
  }
  if (sessionModel === (await read($, offered))) return sessionModel
  return (await models($)).some(m => m.id === sessionModel) ? sessionModel : null
}

/** Offers the model `query` names; resolves that model, or why there is none. */
async function offerQuery($: $, query: string): Promise<LemonadeModel | string> {
  const list = await refresh($)
  const problem = await read($, notice)
  if (problem && list.length === 0) return `${problem} Start Lemonade Server and try again.`

  const found = pick(list, query)
  if (typeof found === 'string') return `${found} Downloaded: ${list.map(m => m.id).join(', ') || 'none'}.`

  await offer($, found)
  // A session already on Lemonade moves to the new model at once.
  if (await read($, routed)) await route($, found.id)
  return found
}

function caveats(m: LemonadeModel): string {
  return m.hasTools ? '' : ' Lemonade does not label it tool-calling, so Claude Code tools may fail.'
}

/** `/lemonade <model>`: makes the selector's Lemonade entry name that model. */
export async function choose($: $, query: string): Promise<string> {
  const found = await offerQuery($, query)
  if (typeof found === 'string') return found
  const how = (await read($, heldOver)) !== null
    ? 'Requests go to it now; /lemonade off goes back.'
    : `Pick it there (or /model ${found.id}, or /lemonade on); pick a Claude model to go back.`
  return `The model selector now offers 🍋 ${found.id}. ${how}${caveats(found)}`
}

/**
 * `/lemonade on [model]`: every request goes to the offered Lemonade model, whatever the session's
 * model, until `/lemonade off` or another pick in a model picker. For pickers that don't list the
 * entry, such as the desktop app's.
 */
async function switchOn($: $, query: string): Promise<string> {
  const named = query ? await offerQuery($, query) : undefined
  if (typeof named === 'string') return named
  const id = await read($, offered)
  if (!id) return 'The model selector offers no Lemonade model. Name one: /lemonade on <model>.'
  const loaded = await ensureLoaded($, id)
  if (!loaded.ok && loaded.message) return loaded.message
  const sessionModel = await $.session.model()
  await update($, heldOver, () => sessionModel as string | null)
  await route($, id)
  const m = named ?? (await models($)).find(x => x.id === id)
  const how = `Requests now go to 🍋 ${id} via Lemonade. /lemonade off, or picking another model, goes back.`
  return `${loaded.message ? `${loaded.message} ` : ''}${how}${m ? caveats(m) : ''}`
}

/** `/lemonade off`: requests follow the session's model again. */
async function switchOff($: $): Promise<string> {
  await update($, heldOver, () => null as string | null)
  const model = await lemonadeModelOf($, await $.session.model())
  await route($, model)
  return model
    ? `Requests follow the model selector again. It has 🍋 ${model} selected, so they still go to Lemonade.`
    : 'Requests follow the model selector again, so Claude answers.'
}

/** What `/lemonade` and `/lemonade list` print, from the downloaded models `refresh` just fetched. */
async function describe($: $, list: readonly LemonadeModel[]): Promise<string> {
  const problem = await read($, notice)
  const now = await read($, routed)
  const shown = await read($, offered)
  const held = (await read($, heldOver)) !== null ? ' (/lemonade on; /lemonade off goes back)' : ''
  const canStart = problem !== '' && (await serverExe($)) !== null
  return [
    now ? `Requests go to ${now} via Lemonade${held}.` : 'Claude answers; pick 🍋 in the model selector, or /lemonade on, to use Lemonade.',
    shown ? `The selector offers: 🍋 ${shown}` : 'The selector offers no Lemonade model yet.',
    problem ? `${problem}${canStart ? ' /lemonade or /lemonade on starts it.' : ''}` : '',
    list.length > 0 ? 'Downloaded chat models:' : problem ? '' : 'No chat models downloaded yet: /lemonade lists the ones Lemonade suggests.',
    ...list.map(m => `${m.id === shown ? '* ' : '  '}${m.id} (${describeModel(m)})`),
    '/lemonade <model> changes which one the selector offers.',
  ]
    .filter(Boolean)
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lemonade',
      description: 'Use a local Lemonade model: /lemonade opens the model list; /lemonade on, off, <model>, list',
    })

    // Pins a session left when it ended without a goodbye (a crash) would hold Lemonade's slots for good.
    for (const [model, at] of Object.entries(await ours($))) {
      if (Date.now() - at > STALE_PIN_MS && (await read($, routed)) !== model) await release($, model)
    }

    // A hot reload keeps $.state: the offer and the routing still stand.
    if ((await read($, offered)) === null) {
      const theirs = await $.env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')
      const list = await refresh($)
      const isUp = (await read($, notice)) === ''
      const remembered = await rememberedOffer($)
      if (!isUp) {
        // Lemonade is down: offer the remembered model anyway, unless the entry is the person's own.
        if (!theirs || theirs === remembered.id) await offer($, remembered, false, (await serverExe($)) !== null)
      } else {
        const preferred =
          list.find(m => m.id === theirs) ??
          (theirs ? undefined : list.find(m => m.id === remembered.id) ?? list.find(m => m.hasTools) ?? list[0])
        // An entry the person configured for something other than Lemonade is theirs to keep.
        if (preferred) await offer($, preferred)
      }
    }
    $.ui.status((await read($, routed)) ? `🍋 ${await read($, routed)} (Lemonade)` : undefined)
    return next(e)
  })

  // Hand the environment back when the conversation ends; the next step routes again from the session's model.
  on('session.end', async ($, e, next) => {
    await update($, heldOver, () => null as string | null)
    await route($, null)
    return next(e)
  })

  on('command.run', { command: 'lemonade' }, async ($, e) => {
    const arg = e.args.trim()
    const [word = '', ...rest] = arg.split(/\s+/)
    if (arg === 'list' || arg === 'status') return { text: await describe($, await refresh($)) }
    if (arg === 'off') return { text: await switchOff($) }
    await ensureServer($)
    if (word === 'on') return { text: await switchOn($, rest.join(' ')) }
    if (arg) return { text: await choose($, arg) }

    // Bare, the output row draws as the model manager (the CommandOutput hook); the text is what the model reads.
    // A new list starts unfiltered: its search box starts empty.
    await update($, search, () => '')
    const list = await refresh($)
    if (await pollDownloads($)) watchDownloads($)
    return { text: await describe($, list) }
  })

  // Every model request follows the session's model: main loop and subagents alike go to Lemonade while it is picked.
  on('turn.step', async function* ($, e, next) {
    // Another plugin's agent is that plugin's to answer: no rename, no load, no routing change.
    if (e.agentId && (await isOthersAgent($, e.agentId))) return yield* next(e)
    const model = await lemonadeModelOf($, await $.session.model())
    // A failed start or load has said exactly why already; the request goes on and fails as it would have.
    let hasSaidWhy = false
    if (model) {
      hasSaidWhy = await ensureServer($)
      if (!hasSaidWhy) {
        const loaded = await ensureLoaded($, model)
        if (loaded.message) say($, loaded.message)
        hasSaidWhy = !loaded.ok && loaded.message !== undefined
      }
    }
    await route($, model)
    const result = yield* next(model ? { ...e, model } : e)
    // A collection that didn't answer may have been unloaded: load it again next time.
    if (model && result.stopReason === null) collections.delete(model)
    // No response from Lemonade is most often a server that isn't running.
    if (model && !hasSaidWhy && result.stopReason === null && !next.signal.aborted) {
      say($, `Lemonade didn't answer at ${await baseUrl($)}. Start Lemonade Server, or pick a Claude model.`)
    }
    return result
  })

  // Bare /lemonade draws its output row as a model manager after Lemonade's own: a row the desktop app
  // shows, where it places no panes. Its other runs keep their text.
  on('ui.render', { component: 'CommandOutput', props: { command: 'lemonade' } }, async ($, e, next) => {
    if (e.props.args.trim() !== '' || e.props.isErrored) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const all = await read($, catalog)
    const query = (await read($, search)).trim().toLowerCase()
    const onlyDownloaded = await read($, isDownloadedOnly)
    const open = await read($, expanded)
    const jobs = await read($, downloads)
    const now = await read($, routed)
    const held = (await read($, heldOver)) !== null
    const problem = await read($, notice)

    // A handler that says how it went, or what went wrong, in a toast.
    const act = (work: () => Promise<string | void>) => () =>
      void work().then(
        text => {
          if (text) $.ui.toast(text)
        },
        (err: unknown) => $.ui.toast(`LemonClaude: ${err instanceof Error ? err.message : String(err)}`),
      )

    const action = (m: LemonadeModel) => {
      if (m.id === now) return <Text color="green">In use</Text>
      if (m.isDownloaded) return <Button key={`use-${m.id}`} label="Use" onPress={act(() => switchOn($, m.id))} />
      const job = jobs[m.id]
      if (job?.status === 'starting') return <Text dimColor>Starting download…</Text>
      if (job?.status === 'downloading' || job?.status === 'paused') {
        return <Text dimColor>{`${job.status === 'paused' ? 'Paused' : 'Downloading'} ${Math.round(job.percent)}%`}</Text>
      }
      const get = <Button key={`get-${m.id}`} label={job ? 'Retry download' : 'Download'} onPress={act(() => download($, m.id))} />
      if (!job) return get
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="red">{`Download failed${job.error ? `: ${job.error}` : ''}`}</Text>
          {get}
        </Box>
      )
    }

    const row = (m: LemonadeModel) => (
      <Box key={`row-${m.id}`} flexDirection="row" gap={1}>
        {m.isLoaded ? <Text color="green">●</Text> : <Text dimColor={!m.isDownloaded}>●</Text>}
        <Text bold={m.isDownloaded}>{m.id}</Text>
        <Text dimColor>{[formatSize(m.size), tags(m)].filter(Boolean).join(' · ')}</Text>
        {action(m)}
      </Box>
    )

    // Three sections, each model in one: loaded, downloaded and ready, and Lemonade's suggestions to
    // download, grouped by recipe as Lemonade's model manager groups them.
    const matches = query ? all.filter(m => m.id.toLowerCase().includes(query)) : all
    const loaded = matches.filter(m => m.isLoaded)
    const ready = matches.filter(m => m.isDownloaded && !m.isLoaded)
    const suggested = onlyDownloaded ? [] : matches.filter(m => !m.isDownloaded)
    const groups = new Map<string, LemonadeModel[]>()
    for (const m of suggested) groups.set(m.recipe, [...(groups.get(m.recipe) ?? []), m])
    const recipes = [...groups.keys()].sort((a, b) => recipeName(a).localeCompare(recipeName(b)))

    const group = (recipe: string) => {
      const list = groups.get(recipe)!
      // A search opens every group it leaves.
      const isOpen = open.includes(recipe) || query !== ''
      const toggle = () => void update($, expanded, xs => (xs.includes(recipe) ? xs.filter(x => x !== recipe) : [...xs, recipe]))
      return (
        <Box key={`group-box-${recipe}`} flexDirection="column">
          <Button key={`group-${recipe}`} plain label={`${isOpen ? '▾' : '▸'} ${recipeName(recipe)} (${list.length})`} onPress={toggle} />
          {isOpen ? <Box flexDirection="column" paddingLeft={2}>{list.map(row)}</Box> : null}
        </Box>
      )
    }

    const section = (title: string, list: readonly LemonadeModel[], empty: string) => (
      <Box flexDirection="column">
        <Text bold dimColor>{title}</Text>
        {list.length > 0 ? <Box flexDirection="column">{list.map(row)}</Box> : <Text dimColor>{empty}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>🍋 Lemonade models</Text>
          <Text dimColor>{now ? `· requests go to ${now}` : '· Claude answers'}</Text>
          {held ? <Button key="claude" label="Back to Claude" onPress={act(() => switchOff($))} /> : null}
        </Box>
        {problem ? <Text color="red">{problem}</Text> : null}
        <Box flexDirection="row" gap={1}>
          {/* Uncontrolled: the field keeps what is typed, and a redraw (a download's progress) never resets it. */}
          <Input
            key="search"
            placeholder="Search models..."
            onInput={value => void update($, search, () => value)}
            onSubmit={value => void update($, search, () => value)}
          />
          <Button
            key="downloaded-only"
            label={onlyDownloaded ? '☑ Downloaded only' : '☐ Downloaded only'}
            onPress={() => void update($, isDownloadedOnly, x => !x)}
          />
        </Box>
        {section(`ACTIVE · ${loaded.length} loaded`, loaded, query ? 'No loaded model matches.' : 'No models loaded.')}
        {section(`DOWNLOADED · ${ready.length} ready`, ready, query ? 'No downloaded model matches.' : 'Nothing else downloaded yet.')}
        {onlyDownloaded ? null : <Text bold dimColor>{`SUGGESTED · ${suggested.length} to download`}</Text>}
        {onlyDownloaded ? null : recipes.length > 0 ? (
          <Box flexDirection="column">{recipes.map(group)}</Box>
        ) : (
          <Text dimColor>{query ? 'No suggested model matches.' : 'Lemonade suggests nothing more.'}</Text>
        )}
      </Box>
    )
  })
}
