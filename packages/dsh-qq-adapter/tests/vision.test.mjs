import test from 'node:test'
import assert from 'node:assert/strict'
import { askVision, askVisionBytes } from '../lib/vision.js'
import { parseEvent } from '../lib/onebot.js'
import { generateReply } from '../lib/reply.js'

test('parseEvent keeps image segments', () => {
  const event = parseEvent(
    {
      post_type: 'message',
      message_type: 'private',
      user_id: 10001,
      message_id: 1,
      message: [
        { type: 'text', data: { text: '看看这个' } },
        { type: 'image', data: { url: 'https://example.test/a.png', file: 'a.png' } },
      ],
      sender: { nickname: '主人' },
    },
    '2799812774',
  )
  assert.equal(event.text, '看看这个[图片]')
  assert.equal(event.images.length, 1)
  assert.equal(event.images[0].url, 'https://example.test/a.png')
})

test('askVision sends image and reads usage', async () => {
  const realFetch = globalThis.fetch
  let apiBody = null
  let apiHeaders = null
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://example.test/')) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    apiBody = JSON.parse(options.body)
    apiHeaders = options.headers
    return new Response(
      JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ message: { content: '图里是 CODE-5144' } }],
        usage: { prompt_tokens: 253, completion_tokens: 20, prompt_cache_hit_tokens: 10 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const usage = []
    const result = await askVision({
      download: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), headers: {'content-type':'image/png'} }),
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com', maxImages: 1 },
      prompt: '看图回答',
      images: [{ url: 'https://example.test/a.png' }],
      maxTokens: 300,
      onUsage: (value) => usage.push(value),
    })
    assert.equal(result.text, '图里是 CODE-5144')
    assert.equal(result.route, 'vision')
    assert.equal(apiHeaders['x-dsh-auth-token'], 'test-token')
    assert.equal(apiBody.messages[0].content[1].type, 'image_url')
    assert.match(apiBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
    assert.deepEqual(usage[0], { promptTokens: 253, outTokens: 20, cacheReadTokens: 10, totalTokens: 273 })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('generateReply routes image messages to vision before local', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://example.test/')) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    return new Response(
      JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ message: { content: '蓝色三角形、红色正方形、红色正方形' } }],
        usage: { prompt_tokens: 255, completion_tokens: 20 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const result = await generateReply({
      identity: '你是大肥鱼',
      event: {
        kind: 'private',
        userId: '1',
        senderName: '主人',
        text: '[图片]',
        images: [{ url: 'https://example.test/a.png' }],
      },
      llm: null,
      local: { enabled: true },
      vision: {
        download: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), headers: {'content-type':'image/png'} }),
        config: { enabled: true, baseURL: 'https://api.deepseek.com', maxImages: 1 },
        account: { resolveToken: async () => 'test-token' },
      },
      maxTokens: 500,
    })
    assert.equal(result.route, 'vision')
    assert.equal(result.model, 'deepseek-flash')
    assert.match(result.text, /蓝色三角形/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('askVisionBytes sends local bytes without downloading', async () => {
  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = async (_url, options = {}) => {
    called += 1
    const body = JSON.parse(options.body)
    assert.equal(body.messages[0].content[1].type, 'image_url')
    return new Response(
      JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ message: { content: '本地图片描述' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const result = await askVisionBytes({
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      prompt: '看图',
      images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
    })
    assert.equal(result.text, '本地图片描述')
    assert.equal(called, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})
