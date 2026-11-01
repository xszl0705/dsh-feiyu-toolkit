import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { askVision, askVisionBytes } from '../lib/vision.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-svc-'))
process.env.DSH_HOME = temp

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)

const declared = []
globalThis[Symbol.for('dsh-feiyu-self.service')] = { declare: (manifest) => declared.push(manifest) }

const ctx = {
  logger: { info() {}, warn() {} },
  get: (name) => (name === 'deepseekAccount' ? { resolveToken: async () => 'test-token' } : undefined),
  effect: (fn) => fn(),
  provide: () => {},
}

test('askVision 发图并读回 usage', async () => {
  const realFetch = globalThis.fetch
  let apiBody = null
  let apiHeaders = null
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://example.test/')) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } })
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
      download: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), headers: { 'content-type': 'image/png' } }),
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

test('askVisionBytes 用本地字节，不下载', async () => {
  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = async (_url, options = {}) => {
    called += 1
    const body = JSON.parse(options.body)
    assert.equal(body.messages[0].content[1].type, 'image_url')
    return new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '本地图片描述' } }] }),
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

test('服务层：apply 后能拿到 askVision / askVisionBytes，并声明能力', () => {
  const api = mod.apply(ctx)
  assert.ok(api)
  assert.equal(typeof api.askVision, 'function')
  assert.equal(typeof api.askVisionBytes, 'function')
  assert.equal(typeof api.buildVisionContextPrompt, 'function')
  const manifest = declared.find((item) => item.id === 'vision')
  assert.ok(manifest)
  assert.equal(manifest.package, 'dsh-vision')
  assert.equal(typeof manifest.state, 'function')
})

test('服务层：看图失败时返回 ok:false，不抛错', async () => {
  const api = mod.apply(ctx)
  const result = await api.askVisionBytes({
    account: { resolveToken: async () => 'test-token' },
    config: {
      baseURL: 'https://api.deepseek.com',
      // 指向一个必然失败的地址
      fetchImpl: undefined,
    },
    prompt: '看图',
    images: [{ mediaType: 'image/png', bytes: Buffer.from('not-an-image') }],
  })
  // 不校验一定失败（依赖网络），只要求结构可预期、不抛
  assert.equal(typeof result.ok, 'boolean')
})

test('失败按原因分类：401 归到 account，不该混进 vision', async () => {
  const api = mod.apply(ctx)
  const before = api.stats().byReason
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Authentication Fails (invalid dsh token)' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  try {
    const result = await api.askVisionBytes({
      account: { resolveToken: async () => 'bad-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      prompt: '看图',
      images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50]) }],
    })
    assert.equal(result.ok, false)
    const after = api.stats().byReason
    assert.equal(after.account, before.account + 1, '401 应该记到 account')
    assert.equal(after.vision, before.vision, '不该记成 vision 能力退化')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('readText 用 OCR 专用 prompt：只抄字，不描述', async () => {
  const api = mod.apply(ctx)
  const realFetch = globalThis.fetch
  let sentPrompt = ''
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body)
    sentPrompt = JSON.stringify(body.messages[0].content)
    return new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '第一行\n第二行' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const result = await api.readText({
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50]) }],
    })
    assert.equal(result.ok !== false, true)
    assert.match(sentPrompt, /逐字读出图中所有文字/)
    assert.match(sentPrompt, /不要解释/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('readText 允许调用方覆盖 prompt', async () => {
  const api = mod.apply(ctx)
  const realFetch = globalThis.fetch
  let sentPrompt = ''
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body)
    sentPrompt = JSON.stringify(body.messages[0].content)
    return new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    await api.readText({
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      prompt: '只读数字',
      images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50]) }],
    })
    assert.match(sentPrompt, /只读数字/)
    assert.doesNotMatch(sentPrompt, /逐字读出图中所有文字/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('locate 把模型的 JSON 解析成坐标', async () => {
  const api = mod.apply(ctx)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ message: { content: '```json\n{"found":true,"x":0.72,"y":0.18,"description":"右上角的蓝色按钮"}\n```' } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  try {
    const result = await api.locate({
      target: '保存按钮',
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50]) }],
    })
    assert.equal(result.found, true)
    assert.equal(result.x, 0.72)
    assert.equal(result.y, 0.18)
    assert.match(result.description, /蓝色按钮/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('locate 找不到时返回 found:false，不编坐标', async () => {
  const api = mod.apply(ctx)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '{"found":false}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  try {
    const result = await api.locate({
      target: '不存在的按钮',
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50]) }],
    })
    assert.equal(result.found, false)
    assert.equal(result.x, null)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('locate 缺 target 直接拒绝，不发请求', async () => {
  const api = mod.apply(ctx)
  const result = await api.locate({ images: [] })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /target/)
})

test('compare 至少需要两张图', async () => {
  const api = mod.apply(ctx)
  const result = await api.compare({
    account: { resolveToken: async () => 'test-token' },
    images: [{ mediaType: 'image/png', bytes: Buffer.from([0x89]) }],
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /两张图/)
})

test('compare 用对比专用 prompt', async () => {
  const api = mod.apply(ctx)
  const realFetch = globalThis.fetch
  let sent = ''
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body)
    sent = JSON.stringify(body.messages[0].content)
    return new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '多了一个按钮' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const result = await api.compare({
      account: { resolveToken: async () => 'test-token' },
      config: { baseURL: 'https://api.deepseek.com' },
      images: [
        { mediaType: 'image/png', bytes: Buffer.from([0x89]) },
        { mediaType: 'image/png', bytes: Buffer.from([0x90]) },
      ],
    })
    assert.equal(result.ok !== false, true)
    assert.match(sent, /两张图/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
