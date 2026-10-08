// The Omni proxy's translation, and the proxy end to end against a fake Lemonade.
// Run: node --test proxy/

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { createProxy, saveMedia, toChat, toMessage } from './omni-proxy.mjs'

const PNG = Buffer.from('iVBORw0KGgo=', 'base64')

test('a Messages request becomes a Chat Completions request', () => {
  const chat = toChat({
    model: 'user.Kit',
    max_tokens: 1000,
    system: [{ type: 'text', text: 'You are Claude Code.' }, { type: 'text', text: 'Be brief.' }],
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
      { type: 'web_search_20250305', name: 'web_search' },
    ],
    messages: [
      { role: 'user', content: 'Read the README' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '# LemonClaude' }] }, { type: 'text', text: 'Now draw it.' }] },
    ],
  })
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'You are Claude Code.\n\nBe brief.' },
    { role: 'user', content: 'Read the README' },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: '# LemonClaude' },
    { role: 'user', content: 'Now draw it.' },
  ])
  // A client tool becomes a function; a server tool, schemaless, stays out.
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } }])
  assert.equal(chat.max_tokens, 1000)
  assert.equal(chat.stream, false)
})

test('images ride as image parts, those from tool results after the tool message', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  const chat = toChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'boom' }, image] }, { type: 'text', text: 'see' }] }],
  })
  assert.deepEqual(chat.messages, [
    { role: 'tool', tool_call_id: 't', content: 'Error: boom' },
    { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ])
})

test('inline images and audio are saved to files and replaced by their paths', () => {
  const saved = []
  const text = saveMedia(`Here.\n\n![generated image](data:image/png;base64,${PNG.toString('base64')})\n<audio>data:audio/mpeg;base64,SUQz</audio>`, (bytes, extension) => {
    saved.push([bytes.length, extension])
    return extension === 'png' ? 'C:/media/a.png' : 'C:/media/b.mp3'
  })
  assert.deepEqual(saved, [[PNG.length, 'png'], [3, 'mp3']])
  assert.equal(text, 'Here.\n\n![generated image](file:///C:/media/a.png)\n[audio: file:///C:/media/b.mp3]')
})

test('a Chat Completions reply becomes a Messages reply', () => {
  const message = toMessage(
    {
      choices: [{ finish_reason: 'tool_calls', message: { content: 'Let me look.', tool_calls: [{ id: 'call_9', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 7 },
    },
    'user.Kit',
    () => 'unused',
  )
  assert.equal(message.role, 'assistant')
  assert.equal(message.model, 'user.Kit')
  assert.deepEqual(message.content, [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'call_9', name: 'Read', input: { file_path: 'a.txt' } }])
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(message.usage, { input_tokens: 120, output_tokens: 7 })
})

/** A fake Lemonade that answers chat completions with `reply`, recording each request body. */
async function fakeLemonade(reply, status = 200) {
  const seen = []
  const server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    seen.push({ path: request.url, body: raw ? JSON.parse(raw) : null })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function startProxy(lemonade) {
  const media = mkdtempSync(join(tmpdir(), 'omni-proxy-'))
  const proxy = createProxy({ lemonade, media })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${proxy.address().port}`, media, close: () => proxy.close() }
}

/** The Messages API stream's events, parsed. */
function events(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => ({ event: /^event: (.*)$/m.exec(chunk)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null') }))
}

test('end to end: a streamed request is answered as a Messages stream, its image saved', async () => {
  const lemonade = await fakeLemonade({
    choices: [{ finish_reason: 'stop', message: { content: `An apple.\n\n![generated image](data:image/png;base64,${PNG.toString('base64')})` } }],
    usage: { prompt_tokens: 50, completion_tokens: 9 },
  })
  const proxy = await startProxy(lemonade.url)
  try {
    const answer = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'user.Kit', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Draw an apple.' }] }),
    })
    assert.equal(answer.headers.get('content-type'), 'text/event-stream')
    const stream = events(await answer.text()).filter(e => e.event !== 'ping')
    assert.deepEqual(
      stream.map(e => e.event),
      ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
    )
    const text = stream[2].data.delta.text
    const saved = /\(file:\/\/\/(.+?)\)/.exec(text)?.[1]
    assert.ok(saved, text)
    const file = fileURLToPath(`file:///${saved}`)
    assert.ok(existsSync(file))
    assert.deepEqual(readFileSync(file), PNG)
    assert.equal(stream[4].data.delta.stop_reason, 'end_turn')
    // Lemonade was asked through chat completions, for the bundle, unstreamed.
    assert.equal(lemonade.seen[0].path, '/v1/chat/completions')
    assert.equal(lemonade.seen[0].body.model, 'user.Kit')
    assert.equal(lemonade.seen[0].body.stream, false)
  } finally {
    proxy.close()
    lemonade.close()
  }
})

test("end to end: Lemonade's error comes back as a Messages error", async () => {
  const lemonade = await fakeLemonade({ error: { message: 'model not found' } }, 404)
  const proxy = await startProxy(lemonade.url)
  try {
    const answer = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'user.Gone', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 404)
    assert.deepEqual(await answer.json(), { type: 'error', error: { type: 'not_found_error', message: 'Lemonade answered 404: model not found' } })
  } finally {
    proxy.close()
    lemonade.close()
  }
})
