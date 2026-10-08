import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DownloadState, LemonadeModel, SavedEnv } from '../types'

const DEFAULT_BASE_URL = 'http://127.0.0.1:13305'
const DEFAULT_MODEL = 'Qwen3.5-4B-GGUF'
const START_TIMEOUT_S = 60

const offered = atom({ plugin: 'lemonclaude', key: 'offered' } as const, null as string | null)
const routed = atom({ plugin: 'lemonclaude', key: 'routed' } as const, null as string | null)
const saved = atom({ plugin: 'lemonclaude', key: 'saved' } as const, null as SavedEnv | null)
const models = atom({ plugin: 'lemonclaude', key: 'models' } as const, [] as LemonadeModel[])
const notice = atom({ plugin: 'lemonclaude', key: 'notice' } as const, '')
const isOn = atom({ plugin: 'lemonclaude', key: 'isOn' } as const, false)
const catalog = atom({ plugin: 'lemonclaude', key: 'catalog' } as const, [] as LemonadeModel[])
const downloads = atom({ plugin: 'lemonclaude', key: 'downloads' } as const, {} as Record<string, DownloadState>)
const search = atom({ plugin: 'lemonclaude', key: 'search' } as const, '')
const isDownloadedOnly = atom({ plugin: 'lemonclaude', key: 'isDownloadedOnly' } as const, false)
const expanded = atom({ plugin: 'lemonclaude', key: 'expanded' } as const, [] as string[])

type $ = EngineInterface

// Labels Lemonade gives models that are not chat LLMs, even alongside `chat`.
const NOT_CHAT = ['transcription', 'realtime-transcription', 'image', 'tts', 'embeddings', 'reranking', 'classification']

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

/**
 * Lemonade's chat models, downloaded or suggested, by name; throws when the server is unreachable.
 * Models without the `chat` label (speech, images, music) are no use to Claude Code.
 */
export async function listCatalog($: $, base: string): Promise<LemonadeModel[]> {
  const listed = await $.http.fetch(`${base}/api/v1/models?show_all=true`)
  if (!listed.ok) throw new Error(`Lemonade answered ${listed.status} at ${base}/api/v1/models`)
  const data = (JSON.parse(listed.text).data ?? []) as Array<{
    id: string
    size?: number
    labels?: string[]
    recipe?: string
    downloaded?: boolean
    suggested?: boolean
  }>

  let loaded = new Set<string>()
  const health = await $.http.fetch(`${base}/api/v1/health`).catch(() => undefined)
  if (health?.ok) {
    const all = (JSON.parse(health.text).all_models_loaded ?? []) as Array<{ model_name: string }>
    loaded = new Set(all.map(m => m.model_name))
  }

  return data
    .filter(m => (m.labels ?? []).includes('chat') && !(m.labels ?? []).some(l => NOT_CHAT.includes(l)))
    .filter(m => m.downloaded !== false || m.suggested !== false)
    .map(m => ({
      id: m.id,
      size: m.size,
      labels: m.labels ?? [],
      recipe: m.recipe ?? '',
      isDownloaded: m.downloaded !== false,
      hasTools: (m.labels ?? []).includes('tool-calling'),
      isLoaded: loaded.has(m.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }))
}

/**
 * Refreshes the catalog and the downloaded models in it, tool-calling ones first; on failure keeps
 * the last ones and says why.
 */
async function refresh($: $): Promise<LemonadeModel[]> {
  const base = await baseUrl($)
  try {
    const all = await listCatalog($, base)
    const list = all
      .filter(m => m.isDownloaded)
      .sort((a, b) => Number(b.hasTools) - Number(a.hasTools) || a.id.localeCompare(b.id))
    await update($, catalog, () => all)
    await update($, models, () => list)
    await update($, notice, () => '')
    return list
  } catch (err) {
    await update($, notice, () => `Lemonade isn't reachable at ${base}: ${(err as Error).message}`)
    return read($, models)
  }
}

/**
 * Reads Lemonade's server-owned downloads into `downloads` once, and refreshes the lists when one
 * finished; true while one still runs.
 */
async function pollDownloads($: $): Promise<boolean> {
  const base = await baseUrl($)
  const listed = await $.http.fetch(`${base}/api/v1/downloads`).catch(() => undefined)
  if (!listed?.ok) return false
  const jobs = JSON.parse(listed.text) as Array<{
    model_name: string
    status: string
    running?: boolean
    percent?: number
    complete?: boolean
    error?: string
  }>
  const before = await read($, downloads)
  const now: Record<string, DownloadState> = {}
  const finished: string[] = []
  for (const job of jobs) {
    if (job.complete || job.status === 'completed') {
      if (before[job.model_name]) finished.push(job.model_name)
      continue
    }
    if (job.status === 'cancelled') continue
    now[job.model_name] = { percent: job.percent ?? 0, status: job.status, ...(job.error ? { error: job.error } : {}) }
  }
  // A download we saw running that is gone from the list finished while nobody looked.
  for (const [id, d] of Object.entries(before)) {
    if (d.status === 'downloading' && !(id in now) && !finished.includes(id)) finished.push(id)
  }
  await update($, downloads, () => now)
  if (finished.length > 0) {
    await refresh($)
    $.ui.toast(`Downloaded ${finished.join(', ')}. Press Use in /lemonade to switch to it.`)
  }
  return jobs.some(j => j.running) || Object.values(now).some(d => d.status === 'downloading')
}

// One poll at a time while Lemonade downloads; a module variable, so a reload starts it again.
let poller: { cancel: () => void } | null = null

/** Polls Lemonade's downloads each second until none runs. */
function watchDownloads($: $): void {
  if (poller) return
  poller = $.clock.every(1000, () =>
    void pollDownloads($).then(isRunning => {
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
  return [m.hasTools ? 'tools' : '', ...['vision', 'reasoning', 'coding'].filter(l => m.labels.includes(l))].filter(Boolean).join(' · ')
}

/** Starts a server-owned download of `id`, which Lemonade keeps going whatever happens to this session. */
async function download($: $, id: string): Promise<void> {
  const base = await baseUrl($)
  await update($, downloads, d => ({ ...d, [id]: { percent: 0, status: 'downloading' } }))
  const started = await $.http
    .fetch(`${base}/api/v1/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: id, stream: true, subscribe: false }),
    })
    .catch((err: Error) => ({ ok: false, status: 0, text: err.message }))
  if (!started.ok) {
    await update($, downloads, d => ({ ...d, [id]: { percent: 0, status: 'error', error: `Lemonade answered ${started.status}` } }))
    return
  }
  watchDownloads($)
}

async function answers($: $, base: string): Promise<boolean> {
  return $.http
    .fetch(`${base}/api/v1/health`)
    .then(r => r.ok)
    .catch(() => false)
}

/**
 * LemonadeServer.exe where Lemonade's Windows installer puts it, or null when LemonClaude shouldn't
 * start a server: none installed there, a server that isn't on this machine, or LEMONCLAUDE_AUTOSTART=0.
 */
async function serverExe($: $): Promise<string | null> {
  if ((await $.env.get('LEMONCLAUDE_AUTOSTART')) === '0') return null
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(await baseUrl($))) return null
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

function describeModel(m: LemonadeModel): string {
  return [m.size ? `${m.size} GB` : '', m.hasTools ? 'tools' : 'no tools', m.isLoaded ? 'loaded' : ''].filter(Boolean).join(', ')
}

/**
 * Puts `m` in Claude Code's model selector, as the one custom entry it has. `isUp` false marks an
 * entry offered from memory while Lemonade did not answer; `canStart` says picking it starts Lemonade.
 */
async function offer($: $, m: LemonadeModel, isUp = true, canStart = false): Promise<void> {
  const down = canStart ? 'Lemonade not running, starts when picked' : 'Lemonade not running, start it first'
  const detail = isUp ? describeModel(m) : `${m.size ? `${m.size} GB, ` : ''}${down}`
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

// Claude Code reads these per request, so setting them on the running process reroutes the next one.
// Unlike `lemonade launch claude`, the model aliases (ANTHROPIC_DEFAULT_*_MODEL) stay Claude's: pointing
// them at Lemonade would make picking Opus in the selector resolve to the Lemonade model. turn.step
// renames the model on each request instead, subagents included.
async function applyEnv($: $, env: SavedEnv): Promise<void> {
  await $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL ?? undefined)
  await $.env.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? undefined)
}

/** Sends requests to Lemonade's `model`, or back to Claude for null; a no-op when already so. */
export async function route($: $, model: string | null): Promise<void> {
  if ((await read($, routed)) === model) return
  if (model) {
    // Keep the environment from before the first switch, so switching between Lemonade models still restores Claude's.
    if ((await read($, saved)) === null) {
      const env = await snapshot($)
      await update($, saved, () => env)
    }
    await applyEnv($, {
      ANTHROPIC_BASE_URL: await baseUrl($),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
  } else {
    const env = await read($, saved)
    if (env) await applyEnv($, env)
    await update($, saved, () => null as SavedEnv | null)
  }
  await update($, routed, () => model)
  $.ui.status(model ? `🍋 ${model} (Lemonade)` : undefined)
}

/**
 * The Lemonade model the session runs on, or null when it runs on Claude: the offered model while
 * `/lemonade on` holds, else the session's model when it is a Lemonade one.
 */
async function lemonadeModelOf($: $, sessionModel: string): Promise<string | null> {
  if (await read($, isOn)) return read($, offered)
  if (sessionModel === (await read($, offered))) return sessionModel
  return (await read($, models)).some(m => m.id === sessionModel) ? sessionModel : null
}

/** Offers the model `query` names; resolves that model, or why there is none. */
async function offerQuery($: $, query: string): Promise<LemonadeModel | string> {
  const list = await refresh($)
  const problem = await read($, notice)
  if (problem && list.length === 0) return `${problem}. Start Lemonade Server and try again.`

  const found = pick(list, query)
  if (typeof found === 'string') return `${found} Downloaded: ${list.map(m => m.id).join(', ') || 'none'}.`

  await offer($, found)
  // A session already on Lemonade moves to the new model at once.
  if (await read($, routed)) await route($, found.id)
  return found
}

function caveats(m: LemonadeModel): string {
  const load = m.isLoaded ? '' : ' It loads on its first request, which takes a few seconds.'
  const warn = m.hasTools ? '' : ' Lemonade does not label it tool-calling, so Claude Code tools may fail.'
  return `${load}${warn}`
}

/** `/lemonade <model>`: makes the selector's Lemonade entry name that model. */
export async function choose($: $, query: string): Promise<string> {
  const found = await offerQuery($, query)
  if (typeof found === 'string') return found
  const how = (await read($, isOn))
    ? 'Requests go to it now; /lemonade off goes back.'
    : `Pick it there (or /model ${found.id}, or /lemonade on); pick a Claude model to go back.`
  return `The model selector now offers 🍋 ${found.id}. ${how}${caveats(found)}`
}

/**
 * `/lemonade on [model]`: every request goes to the offered Lemonade model, whatever the session's
 * model, until `/lemonade off`. For pickers that don't list the entry, such as the desktop app's.
 */
async function switchOn($: $, query: string): Promise<string> {
  const named = query ? await offerQuery($, query) : undefined
  if (typeof named === 'string') return named
  const id = await read($, offered)
  if (!id) return 'The model selector offers no Lemonade model. Name one: /lemonade on <model>.'
  await update($, isOn, () => true)
  await route($, id)
  const m = named ?? (await read($, models)).find(x => x.id === id)
  return `Requests now go to 🍋 ${id} via Lemonade, whatever the model selector shows. /lemonade off goes back.${m ? caveats(m) : ''}`
}

/** `/lemonade off`: requests follow the session's model again. */
async function switchOff($: $): Promise<string> {
  await update($, isOn, () => false)
  const model = await lemonadeModelOf($, await $.session.model())
  await route($, model)
  return model
    ? `Requests follow the model selector again. It has 🍋 ${model} selected, so they still go to Lemonade.`
    : 'Requests follow the model selector again, so Claude answers.'
}

async function describe($: $): Promise<string> {
  const list = await refresh($)
  const problem = await read($, notice)
  const now = await read($, routed)
  const shown = await read($, offered)
  const held = (await read($, isOn)) ? ' (/lemonade on; /lemonade off goes back)' : ''
  return [
    now ? `Requests go to ${now} via Lemonade${held}.` : 'Claude answers; pick 🍋 in the model selector, or /lemonade on, to use Lemonade.',
    shown ? `The selector offers: 🍋 ${shown}` : 'The selector offers no Lemonade model yet.',
    problem || 'Downloaded chat models:',
    ...list.map(m => `${m.id === shown ? '* ' : '  '}${m.id} (${describeModel(m)})`),
    '/lemonade <model> changes which one the selector offers.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lemonade',
      description: 'Use a local Lemonade model: /lemonade opens the model list; /lemonade on, off, <model>, list',
    })

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
    await update($, isOn, () => false)
    await route($, null)
    return next(e)
  })

  on('command.run', { command: 'lemonade' }, async ($, e) => {
    const arg = e.args.trim()
    const [word = '', ...rest] = arg.split(/\s+/)
    if (arg === 'list' || arg === 'status') return { text: await describe($) }
    if (arg === 'off') return { text: await switchOff($) }
    await ensureServer($)
    if (word === 'on') return { text: await switchOn($, rest.join(' ')) }
    if (arg) return { text: await choose($, arg) }

    // Bare, the output row draws as the model manager (the CommandOutput hook); the text is what the model reads.
    await refresh($)
    if (await pollDownloads($)) watchDownloads($)
    return { text: await describe($) }
  })

  // Every model request follows the session's model: main loop and subagents alike go to Lemonade while it is picked.
  on('turn.step', async function* ($, e, next) {
    const model = await lemonadeModelOf($, await $.session.model())
    // A failed start has said so already; the request goes on and fails as it would have.
    const didStartFail = model ? await ensureServer($) : false
    await route($, model)
    const result = yield* next(model ? { ...e, model } : e)
    // No response from Lemonade is most often a server that isn't running.
    if (model && !didStartFail && result.stopReason === null && !next.signal.aborted) {
      $.ui.toast(`Lemonade didn't answer at ${await baseUrl($)}. Start Lemonade Server, or pick a Claude model.`)
    }
    return result
  })

  // Bare /lemonade draws its output row as a model manager after Lemonade's own: a row the desktop app
  // shows, where it places no panes. Its other runs keep their text.
  on('ui.render', { component: 'CommandOutput', props: { command: 'lemonade' } }, async ($, e, next) => {
    if (e.props.args.trim() !== '' || e.props.isErrored) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const all = await read($, catalog)
    const typed = await read($, search)
    const query = typed.trim().toLowerCase()
    const onlyDownloaded = await read($, isDownloadedOnly)
    const open = await read($, expanded)
    const jobs = await read($, downloads)
    const now = await read($, routed)
    const held = await read($, isOn)
    const problem = await read($, notice)

    // A handler that says how it went in a toast.
    const act = (work: () => Promise<string | void>) => () =>
      void work().then(text => {
        if (text) $.ui.toast(text)
      })

    const action = (m: LemonadeModel) => {
      if (m.id === now) return <Text color="green">In use</Text>
      if (m.isDownloaded) return <Button key={`use-${m.id}`} label="Use" onPress={act(() => switchOn($, m.id))} />
      const job = jobs[m.id]
      if (job?.status === 'downloading' || job?.status === 'paused') {
        return <Text dimColor>{`${job.status === 'paused' ? 'Paused' : 'Downloading'} ${Math.round(job.percent)}%`}</Text>
      }
      const label = job?.status === 'error' ? 'Retry download' : 'Download'
      return <Button key={`get-${m.id}`} label={label} onPress={act(() => download($, m.id))} />
    }

    const row = (m: LemonadeModel) => (
      <Box key={`row-${m.id}`} flexDirection="row" gap={1}>
        {m.isLoaded ? <Text color="green">●</Text> : <Text dimColor={!m.isDownloaded}>●</Text>}
        <Text bold={m.isDownloaded}>{m.id}</Text>
        <Text dimColor>{[formatSize(m.size), tags(m)].filter(Boolean).join(' · ')}</Text>
        {action(m)}
      </Box>
    )

    const shown = all.filter(m => (!onlyDownloaded || m.isDownloaded) && (!query || m.id.toLowerCase().includes(query)))
    const groups = new Map<string, LemonadeModel[]>()
    for (const m of shown) groups.set(m.recipe, [...(groups.get(m.recipe) ?? []), m])
    const recipes = [...groups.keys()].sort((a, b) => recipeName(a).localeCompare(recipeName(b)))
    const loaded = all.filter(m => m.isLoaded)

    const group = (recipe: string) => {
      const list = groups.get(recipe)!
      // A search or the downloaded-only view opens every group it leaves.
      const isOpen = open.includes(recipe) || query !== '' || onlyDownloaded
      const toggle = () => void update($, expanded, xs => (xs.includes(recipe) ? xs.filter(x => x !== recipe) : [...xs, recipe]))
      return (
        <Box key={`group-box-${recipe}`} flexDirection="column">
          <Button key={`group-${recipe}`} plain label={`${isOpen ? '▾' : '▸'} ${recipeName(recipe)} (${list.length})`} onPress={toggle} />
          {isOpen ? <Box flexDirection="column" paddingLeft={2}>{list.map(row)}</Box> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>🍋 Lemonade model manager</Text>
          <Text dimColor>{now ? `· requests go to ${now}` : '· Claude answers'}</Text>
          {held ? <Button key="claude" label="Back to Claude" onPress={act(() => switchOff($))} /> : null}
        </Box>
        {problem ? <Text color="red">{problem}</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Input
            key="search"
            placeholder="Search models..."
            value={typed}
            onInput={value => void update($, search, () => value)}
            onSubmit={value => void update($, search, () => value)}
          />
          <Button
            key="downloaded-only"
            label={onlyDownloaded ? '☑ Downloaded only' : '☐ Downloaded only'}
            onPress={() => void update($, isDownloadedOnly, x => !x)}
          />
        </Box>
        <Text bold dimColor>{`ACTIVE MODELS · ${loaded.length} loaded`}</Text>
        {loaded.length > 0 ? <Box flexDirection="column">{loaded.map(row)}</Box> : <Text dimColor>No models loaded</Text>}
        <Text bold dimColor>{`${onlyDownloaded ? 'DOWNLOADED' : 'SUGGESTED'} MODELS · ${shown.length} shown`}</Text>
        {recipes.length > 0 ? <Box flexDirection="column">{recipes.map(group)}</Box> : <Text dimColor>No models match.</Text>}
      </Box>
    )
  })
}
