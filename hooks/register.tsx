import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LemonadeModel, SavedEnv } from '../types'

const PANE = 'lemonade-picker'
const DEFAULT_BASE_URL = 'http://127.0.0.1:13305'
const DEFAULT_MODEL = 'Qwen3.5-4B-GGUF'
const START_TIMEOUT_S = 60

const offered = atom({ plugin: 'lemonclaude', key: 'offered' } as const, null as string | null)
const routed = atom({ plugin: 'lemonclaude', key: 'routed' } as const, null as string | null)
const saved = atom({ plugin: 'lemonclaude', key: 'saved' } as const, null as SavedEnv | null)
const models = atom({ plugin: 'lemonclaude', key: 'models' } as const, [] as LemonadeModel[])
const notice = atom({ plugin: 'lemonclaude', key: 'notice' } as const, '')
const isOn = atom({ plugin: 'lemonclaude', key: 'isOn' } as const, false)

type $ = EngineInterface

// Labels Lemonade gives models that are not chat LLMs.
const NOT_CHAT = ['transcription', 'realtime-transcription', 'image', 'tts', 'embeddings', 'reranking', 'classification']

async function baseUrl($: $): Promise<string> {
  const fromEnv = await $.env.get('LEMONADE_BASE_URL')
  return (fromEnv ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/** Lemonade's downloaded chat models, tool-calling ones first; throws when the server is unreachable. */
export async function listModels($: $, base: string): Promise<LemonadeModel[]> {
  const listed = await $.http.fetch(`${base}/api/v1/models`)
  if (!listed.ok) throw new Error(`Lemonade answered ${listed.status} at ${base}/api/v1/models`)
  const data = (JSON.parse(listed.text).data ?? []) as Array<{
    id: string
    size?: number
    labels?: string[]
    downloaded?: boolean
  }>

  let loaded = new Set<string>()
  const health = await $.http.fetch(`${base}/api/v1/health`).catch(() => undefined)
  if (health?.ok) {
    const all = (JSON.parse(health.text).all_models_loaded ?? []) as Array<{ model_name: string }>
    loaded = new Set(all.map(m => m.model_name))
  }

  return data
    .filter(m => m.downloaded !== false)
    .filter(m => !(m.labels ?? []).some(l => NOT_CHAT.includes(l)))
    .map(m => ({
      id: m.id,
      size: m.size,
      labels: m.labels ?? [],
      hasTools: (m.labels ?? []).includes('tool-calling'),
      isLoaded: loaded.has(m.id),
    }))
    .sort((a, b) => Number(b.hasTools) - Number(a.hasTools) || a.id.localeCompare(b.id))
}

/** Refreshes the model list; on failure keeps the last one and says why. */
async function refresh($: $): Promise<LemonadeModel[]> {
  const base = await baseUrl($)
  try {
    const list = await listModels($, base)
    await update($, models, () => list)
    await update($, notice, () => '')
    return list
  } catch (err) {
    await update($, notice, () => `Lemonade isn't reachable at ${base}: ${(err as Error).message}`)
    return read($, models)
  }
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
  return { id, labels: [], hasTools: true, isLoaded: false }
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
      description: 'Use a local Lemonade model (/lemonade on, /lemonade off, /lemonade <model>, /lemonade list)',
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

    await refresh($)
    await $.ui.open({ id: PANE, title: 'Lemonade model', focus: true, closeOnEscape: true, holdToasts: true })
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const list = await read($, models)
    const shown = await read($, offered)
    const problem = await read($, notice)

    const pickOne = async (value: string) => {
      $.ui.toast(await choose($, value))
      await $.ui.close({ id: PANE })
    }

    return (
      <Box flexDirection="column">
        {problem ? <Text color="red">{problem}</Text> : null}
        {list.length === 0 ? (
          <Text dimColor>No downloaded chat models. Pull one with lemonade pull.</Text>
        ) : (
          <Select
            key="model"
            label="Offer in the model selector: "
            options={list.map(m => ({ value: m.id, label: `${m.id}  ${describeModel(m)}` }))}
            value={shown ?? list[0]!.id}
            autoFocus
            onSelect={value => void pickOne(value)}
          />
        )}
        <Text dimColor>Enter chooses · Esc closes · then pick 🍋 in the model selector, or /lemonade on</Text>
      </Box>
    )
  })
}
