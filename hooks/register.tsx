import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Active, LemonadeModel, SavedEnv } from '../types'

const PANE = 'lemonade-picker'
const OFF = '__off__'
const DEFAULT_BASE_URL = 'http://127.0.0.1:13305'

const active = atom({ plugin: 'sidekick', key: 'active' } as const, null as Active | null)
const saved = atom({ plugin: 'sidekick', key: 'saved' } as const, null as SavedEnv | null)
const models = atom({ plugin: 'sidekick', key: 'models' } as const, [] as LemonadeModel[])
const notice = atom({ plugin: 'sidekick', key: 'notice' } as const, '')

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

/** The one model `query` names: exact id first, then a unique case-insensitive substring. */
export function pick(list: LemonadeModel[], query: string): LemonadeModel | string {
  const q = query.toLowerCase()
  const exact = list.find(m => m.id.toLowerCase() === q)
  if (exact) return exact
  const hits = list.filter(m => m.id.toLowerCase().includes(q))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return `"${query}" matches ${hits.map(m => m.id).join(', ')}; name one.`
  return `No downloaded Lemonade chat model matches "${query}".`
}

async function snapshot($: $): Promise<SavedEnv> {
  return {
    ANTHROPIC_BASE_URL: (await $.env.get('ANTHROPIC_BASE_URL')) ?? null,
    ANTHROPIC_DEFAULT_OPUS_MODEL: (await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')) ?? null,
    ANTHROPIC_DEFAULT_SONNET_MODEL: (await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')) ?? null,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: (await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')) ?? null,
    CLAUDE_CODE_SUBAGENT_MODEL: (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ?? null,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) ?? null,
  }
}

// The same variables `lemonade launch claude` sets, applied to the running process.
async function applyEnv($: $, env: SavedEnv): Promise<void> {
  await $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL ?? undefined)
  await $.env.set('ANTHROPIC_DEFAULT_OPUS_MODEL', env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? undefined)
  await $.env.set('ANTHROPIC_DEFAULT_SONNET_MODEL', env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? undefined)
  await $.env.set('ANTHROPIC_DEFAULT_HAIKU_MODEL', env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? undefined)
  await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL', env.CLAUDE_CODE_SUBAGENT_MODEL ?? undefined)
  await $.env.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? undefined)
}

function showStatus($: $, a: Active | null): void {
  $.ui.status(a ? `🍋 ${a.model} (Lemonade)` : undefined)
}

export async function switchTo($: $, query: string): Promise<string> {
  const base = await baseUrl($)
  let list: LemonadeModel[]
  try {
    list = await listModels($, base)
  } catch (err) {
    return `Lemonade isn't reachable at ${base} (${(err as Error).message}). Start Lemonade Server and try again.`
  }
  await update($, models, () => list)

  const found = pick(list, query)
  if (typeof found === 'string') {
    const names = list.map(m => m.id).join(', ') || 'none'
    return `${found} Downloaded: ${names}.`
  }

  // Keep the pre-switch environment from the first switch only, so a second switch still restores Claude's.
  if ((await read($, saved)) === null) {
    const env = await snapshot($)
    await update($, saved, () => env)
  }

  const m = found.id
  await applyEnv($, {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
    CLAUDE_CODE_SUBAGENT_MODEL: m,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  })
  const next: Active = { model: m, baseUrl: base, hasTools: found.hasTools }
  await update($, active, () => next)
  await $.store.set('lastModel', m)
  showStatus($, next)

  const warn = found.hasTools ? '' : ' Warning: Lemonade does not label this model tool-calling, so Claude Code tools may fail.'
  const load = found.isLoaded ? '' : ' It loads on the first request, which can take a while.'
  return `Now on ${m} via Lemonade at ${base}.${load}${warn} /lemonade off switches back.`
}

export async function switchOff($: $): Promise<string> {
  const was = await read($, active)
  const env = await read($, saved)
  if (env) await applyEnv($, env)
  await update($, active, () => null as Active | null)
  await update($, saved, () => null as SavedEnv | null)
  showStatus($, null)
  return was ? `Back on Claude (left ${was.model}).` : 'Lemonade is already off.'
}

async function describe($: $): Promise<string> {
  const a = await read($, active)
  const base = await baseUrl($)
  let lines: string[]
  try {
    const list = await listModels($, base)
    await update($, models, () => list)
    lines = list.map(m => {
      const tags = [m.size ? `${m.size} GB` : '', m.hasTools ? 'tools' : 'no tools', m.isLoaded ? 'loaded' : ''].filter(Boolean)
      return `${a?.model === m.id ? '* ' : '  '}${m.id} (${tags.join(', ')})`
    })
  } catch (err) {
    lines = [`  Lemonade isn't reachable at ${base}: ${(err as Error).message}`]
  }
  return [
    a ? `Now on ${a.model} via Lemonade.` : 'Lemonade is off; Claude answers.',
    'Downloaded chat models:',
    ...lines,
    'Use /lemonade <model> to switch, /lemonade off to go back.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lemonade',
      description: 'Pick a local Lemonade model for this session (/lemonade <model>, /lemonade off)',
    })
    // A hot reload keeps $.state: show the routing that is still in force.
    showStatus($, await read($, active))
    return next(e)
  })

  // Hand the environment back when the conversation ends (/clear included), so no Claude request goes to Lemonade.
  on('session.end', async ($, e, next) => {
    if (await read($, active)) await switchOff($)
    return next(e)
  })

  on('command.run', { command: 'lemonade' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'claude') return { text: await switchOff($) }
    if (arg === 'list' || arg === 'status') return { text: await describe($) }
    if (arg) return { text: await switchTo($, arg) }

    // No argument: the picker.
    const base = await baseUrl($)
    try {
      const list = await listModels($, base)
      await update($, models, () => list)
      await update($, notice, () => '')
    } catch (err) {
      await update($, notice, () => `Lemonade isn't reachable at ${base}: ${(err as Error).message}`)
    }
    await $.ui.open({ id: PANE, title: 'Lemonade model', focus: true, closeOnEscape: true, holdToasts: true })
    return { text: await describe($) }
  })

  // Every model request of the session, main loop and subagents, names the Lemonade model while it is on.
  on('turn.step', async function* ($, e, next) {
    const a = await read($, active)
    return yield* next(a ? { ...e, model: a.model } : e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const list = await read($, models)
    const a = await read($, active)
    const problem = await read($, notice)
    const last = await $.store.get('lastModel')

    const options = [
      { value: OFF, label: 'Claude (Lemonade off)' },
      ...list.map(m => ({
        value: m.id,
        label: `${m.id}  ${[m.size ? `${m.size} GB` : '', m.hasTools ? 'tools' : 'no tools', m.isLoaded ? 'loaded' : ''].filter(Boolean).join(' · ')}`,
      })),
    ]
    const current = a?.model ?? (typeof last === 'string' && list.some(m => m.id === last) ? last : OFF)

    const choose = async (value: string) => {
      const text = value === OFF ? await switchOff($) : await switchTo($, value)
      $.ui.toast(text)
      await $.ui.close({ id: PANE })
    }

    return (
      <Box flexDirection="column">
        {problem ? <Text color="red">{problem}</Text> : null}
        {list.length === 0 && !problem ? <Text dimColor>No downloaded chat models. Pull one with lemonade pull.</Text> : null}
        <Select key="model" label="Model: " options={options} value={current} autoFocus onSelect={value => void choose(value)} />
        <Text dimColor>Enter switches · Esc closes · {a ? `now ${a.model}` : 'now Claude'}</Text>
      </Box>
    )
  })
}
