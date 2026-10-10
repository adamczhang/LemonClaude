#!/usr/bin/env node
// Lets Claude Code talk to a Lemonade Omni bundle.
//
// Claude Code speaks Anthropic's Messages API (/v1/messages). Lemonade runs an Omni bundle (a chat
// model with image, speech and other models beside it) only on its OpenAI-style
// /v1/chat/completions, where it adds its own tools (generate an image, speak), runs them, and returns
// one reply with the media inline. This proxy sits between the two: it takes Claude Code's request as
// sent (system prompt, messages, every tool's schema), asks Lemonade's chat completions, and answers in
// the Messages API's shape, streamed when asked. Generated images and audio arrive as base64 in the
// text; the proxy saves each to a file and leaves its path, so a picture doesn't fill the context.
//
// Run by LemonClaude for a session: node omni-proxy.mjs --lemonade <base URL> --media <folder>
// It prints "listening <port>" once ready. No dependencies beyond Node 18+.

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The text of a Messages API content value: a string, or the text blocks of a block list joined. */
function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
}

/** An image block as an OpenAI content part, or null for a kind it can't carry. */
function imagePart(block) {
  const source = block.source ?? {}
  if (source.type === 'base64') return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } }
  if (source.type === 'url') return { type: 'image_url', image_url: { url: source.url } }
  return null
}

/**
 * A Messages API request as a Chat Completions request, for `model`.
 * - The system prompt becomes the first message.
 * - An assistant's tool_use blocks become tool_calls.
 * - A user's tool_result blocks become tool messages, in order, ahead of the rest of that user turn.
 *   Images inside a tool result can't ride on a tool message, so they follow as a user message.
 * - Thinking blocks are dropped: the Chat Completions API has no place for them.
 * - Client tools (those with an input_schema) become functions; server tools such as web search,
 *   which have none, are left out.
 */
export function toChat(body) {
  const messages = []
  const system = textOf(body.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const message of body.messages ?? []) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content ?? [])
    if (message.role === 'assistant') {
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
      const calls = blocks
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      messages.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) })
      continue
    }
    const images = []
    for (const block of blocks.filter(b => b.type === 'tool_result')) {
      const inner = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : (block.content ?? [])
      const text = textOf(inner)
      for (const image of inner.filter(b => b.type === 'image')) {
        const part = imagePart(image)
        if (part) images.push(part)
      }
      messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: (block.is_error ? 'Error: ' : '') + (text || '(no output)') })
    }
    const parts = []
    for (const block of blocks.filter(b => b.type !== 'tool_result')) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        const part = imagePart(block)
        if (part) parts.push(part)
      } else if (block.type === 'document') parts.push({ type: 'text', text: '[a document was attached here]' })
    }
    parts.push(...images)
    if (parts.length === 0) continue
    const isText = parts.every(p => p.type === 'text')
    messages.push({ role: 'user', content: isText ? parts.map(p => p.text).join('\n\n') : parts })
  }

  const tools = (body.tools ?? [])
    .filter(t => t.input_schema)
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }))
  const choice = body.tool_choice
  const toolChoice =
    choice?.type === 'any' ? 'required' : choice?.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice?.type === 'none' ? 'none' : undefined

  return {
    model: body.model,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && toolChoice ? { tool_choice: toolChoice } : {}),
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
    stream: false,
  }
}

const EXTENSIONS = { 'svg+xml': 'svg', jpeg: 'jpg', mpeg: 'mp3', 'x-wav': 'wav' }

/**
 * `text` with each inline image or audio clip saved by `save(bytes, extension)` and replaced by its
 * path: images as Markdown images, audio as a line naming the file.
 */
export function saveMedia(text, save) {
  return text
    .replace(/!\[([^\]]*)\]\(data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\)/gi, (_, alt, type, data) => {
      const path = save(Buffer.from(data, 'base64'), EXTENSIONS[type.toLowerCase()] ?? type.toLowerCase())
      return `![${alt || 'generated image'}](${pathToFileURL(path).href})`
    })
    .replace(/<audio>\s*data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\s*<\/audio>/gi, (_, type, data) => {
      const path = save(Buffer.from(data, 'base64'), EXTENSIONS[type.toLowerCase()] ?? type.toLowerCase())
      return `[audio: ${pathToFileURL(path).href}]`
    })
}

const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' }

/** A Chat Completions response as a Messages API message for `model`, its media saved by `save`. */
export function toMessage(response, model, save) {
  const choice = response.choices?.[0] ?? {}
  const reply = choice.message ?? {}
  const content = []
  const text = saveMedia(typeof reply.content === 'string' ? reply.content : '', save)
  if (text.trim()) content.push({ type: 'text', text })
  for (const call of reply.tool_calls ?? []) {
    let input = {}
    try {
      input = JSON.parse(call.function?.arguments || '{}')
    } catch {
      input = {}
    }
    const id = /^[A-Za-z0-9_-]+$/.test(call.id ?? '') ? call.id : `toolu_${randomUUID().replace(/-/g, '')}`
    content.push({ type: 'tool_use', id, name: call.function?.name ?? '', input })
  }
  const hasTools = content.some(b => b.type === 'tool_use')
  const stopReason = hasTools ? 'tool_use' : (STOP_REASONS[choice.finish_reason] ?? 'end_turn')
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 },
  }
}

/** The Messages API stream events that carry `message`, after its message_start has gone. */
export function streamEvents(message) {
  const events = []
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }])
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  // message_start went out before the answer, with no counts yet: the input's count rides here, as the Messages API's own does.
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { ...message.usage } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events
}

/** A Messages API error body. */
function error(status, message) {
  const type = status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'api_error'
  return { type: 'error', error: { type, message } }
}

/** The proxy's server, answering for the Lemonade at `lemonade`, saving media under `media`. */
export function createProxy({ lemonade, media }) {
  const save = (bytes, extension) => {
    mkdirSync(media, { recursive: true })
    const path = join(media, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${extension}`)
    writeFileSync(path, bytes)
    return path
  }

  return http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const path = (request.url ?? '/').split('?')[0]

    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    try {
      if (request.method === 'POST' && path === '/v1/messages/count_tokens') {
        // An estimate, about four characters a token: Lemonade has no counting endpoint.
        return send(200, { input_tokens: Math.ceil(raw.length / 4) })
      }
      if (request.method !== 'POST' || path !== '/v1/messages') {
        // Anything else (a model list, a health check) is Lemonade's to answer.
        const passed = await fetch(`${lemonade}${request.url}`, { method: request.method, headers: { 'content-type': 'application/json' }, body: raw || undefined })
        response.writeHead(passed.status, { 'content-type': passed.headers.get('content-type') ?? 'application/json' })
        return response.end(Buffer.from(await passed.arrayBuffer()))
      }

      const body = JSON.parse(raw)
      const isStreamed = body.stream === true
      const id = `msg_${randomUUID().replace(/-/g, '')}`
      let pinger
      if (isStreamed) {
        // Start the stream at once and keep it alive: a bundle can take a while, its image tools longer.
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const start = { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }
        response.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`)
        pinger = setInterval(() => response.write(`event: ping\ndata: {"type":"ping"}\n\n`), 10_000)
      }

      let answer
      try {
        const asked = await fetch(`${lemonade}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toChat(body)) })
        const text = await asked.text()
        if (!asked.ok) {
          let said = text
          try {
            const parsed = JSON.parse(text)
            said = parsed.error?.message ?? parsed.message ?? text
          } catch {}
          answer = { status: asked.status, error: `Lemonade answered ${asked.status}: ${said}` }
        } else answer = { message: { ...toMessage(JSON.parse(text), body.model, save), id } }
      } catch (err) {
        answer = { status: 502, error: `Lemonade didn't answer: ${err.message}` }
      } finally {
        clearInterval(pinger)
      }

      if (!isStreamed) return answer.error ? send(answer.status, error(answer.status, answer.error)) : send(200, answer.message)
      if (answer.error) {
        response.write(`event: error\ndata: ${JSON.stringify(error(answer.status, answer.error))}\n\n`)
        return response.end()
      }
      for (const [event, data] of streamEvents(answer.message)) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      response.end()
    } catch (err) {
      if (!response.headersSent) send(500, error(500, err.message))
      else response.end()
    }
  })
}

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const lemonade = argument('lemonade', 'http://127.0.0.1:13305').replace(/\/+$/, '')
  const media = argument('media', join(process.cwd(), 'lemonclaude-media'))
  const server = createProxy({ lemonade, media })
  // LemonClaude ends it with the session: Claude Code kills a mod's child when the mod unloads.
  server.listen(Number(argument('port', '0')), '127.0.0.1', () => {
    process.stdout.write(`listening ${server.address().port}\n`)
  })
}
