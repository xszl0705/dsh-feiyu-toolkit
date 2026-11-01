import test from 'node:test'
import assert from 'node:assert/strict'
import { installClientVisionContext } from '../lib/client-vision-context.js'

test('injects memory context into image LLM requests', async () => {
  let handler = null
  let captured = null
  const ctx = {
    get(name) {
      if (name === 'llm') return this.llm
      if (name === 'memory') return { search: () => [{ text: '记忆：主人在做群聊引擎' }] }
      if (name === 'dialog') return { recent: () => [{ role: 'user', text: '之前聊过图片测试' }] }
      return undefined
    },
    effect(fn) {
      fn()
    },
    on(name, fn) {
      if (name === 'llm/stream') handler = fn
      return () => {}
    },
    llm: {
      async *stream(options) {
        captured = options
        yield { type: 'text', text: 'ok' }
      },
    },
  }
  installClientVisionContext(ctx, { note: () => {} })
  assert.equal(typeof handler, 'function')
  const options = {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '这张图里的构筑对吗' }, { type: 'image', attachment: { id: 'x' } }] },
    ],
  }
  const chunks = []
  for await (const chunk of handler(options, async function* () {
    yield { type: 'text', text: 'original' }
  })) chunks.push(chunk)
  assert.ok(captured)
  const text = captured.messages[0].content.find((b) => b.type === 'text').text
  assert.match(text, /图片上下文/)
  assert.match(text, /主人在做群聊引擎/)
  assert.equal(chunks[0].text, 'ok')
})
