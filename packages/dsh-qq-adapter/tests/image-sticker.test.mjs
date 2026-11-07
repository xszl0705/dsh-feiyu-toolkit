import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createImageLibrary, sniffImage } from '../lib/image-library.js'
import { parseStickerIntent } from '../lib/sticker-intent.js'
import { parseJudge, heuristicJudge } from '../lib/image-judge.js'
import { resolveAttachmentFile, readImageBlock, collectClientImages, installClientImageLibrary, newestAttachmentImage } from '../lib/client-image-library.js'
import { askVision } from '../lib/vision.js'

// 够长的 PNG 头：签名 + IHDR，宽 2 高 3
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]),
  Buffer.from([0, 0, 0, 0]),
])
// GIF89a，宽 10 高 20
const GIF = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([10, 0, 20, 0, 0xf7, 0, 0]),
  Buffer.from([0, 0, 0, 0x3b]),
])

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-test-'))
}

test('sniffImage 认出 png/gif 与尺寸、动图标记', () => {
  const png = sniffImage(PNG)
  assert.equal(png.mediaType, 'image/png')
  assert.equal(png.ext, 'png')
  assert.equal(png.width, 2)
  assert.equal(png.height, 3)
  assert.equal(png.animated, false)

  const gif = sniffImage(GIF)
  assert.equal(gif.mediaType, 'image/gif')
  assert.equal(gif.width, 10)
  assert.equal(gif.height, 20)
  assert.equal(gif.animated, true)

  assert.equal(sniffImage(Buffer.from('not an image at all')), null)
})

test('同图去重：sha 相同只落一份，seen 累加', () => {
  const dir = tempDir()
  const lib = createImageLibrary({ dir })
  const first = lib.remember({ bytes: PNG, source: { channel: 'qq', kind: 'group', groupId: '1' } })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  const second = lib.remember({ bytes: PNG, caption: '一只可爱的猫', source: { channel: 'qq', kind: 'private', userId: '9' } })
  assert.equal(second.created, false)
  assert.equal(second.record.seen, 2)
  assert.equal(second.record.caption, '一只可爱的猫')
  assert.equal(lib.stats().total, 1)
  assert.equal(fs.readdirSync(path.join(dir, 'files')).length, 1)
})

test('收藏档跨实例持久化，forget 连文件一起删', () => {
  const dir = tempDir()
  const lib = createImageLibrary({ dir })
  const saved = lib.remember({ bytes: GIF, caption: '动图表情' })
  lib.update(saved.record.id, { saved: true, tags: ['表情包', '动图'] })
  const reopened = createImageLibrary({ dir })
  const again = reopened.get(saved.record.id)
  assert.equal(again.saved, true)
  assert.deepEqual(again.tags, ['表情包', '动图'])
  assert.equal(again.animated, true)

  assert.equal(reopened.forget(saved.record.id), true)
  assert.equal(reopened.get(saved.record.id), null)
  assert.equal(fs.existsSync(again.path), false)
})

test('recent 档超上限滚动淘汰，收藏档不被淘汰', () => {
  const dir = tempDir()
  const lib = createImageLibrary({ dir, maxRecentFiles: 1 })
  const png = lib.remember({ bytes: PNG })
  const gif = lib.remember({ bytes: GIF })
  assert.equal(lib.stats().recent, 1)
  assert.equal(lib.get(png.record.id), null)
  assert.ok(lib.get(gif.record.id))

  lib.update(gif.record.id, { saved: true })
  const third = lib.remember({ bytes: Buffer.concat([PNG, Buffer.from([1])]), caption: '另一张' })
  assert.ok(lib.get(gif.record.id), '收藏档必须留着')
  assert.ok(lib.get(third.record.id))
})

test('list 支持按描述/标签/已收藏过滤', () => {
  const dir = tempDir()
  const lib = createImageLibrary({ dir })
  const a = lib.remember({ bytes: PNG, caption: '蓝色的大肥鱼表情包', tags: ['表情包'] })
  lib.remember({ bytes: GIF, caption: '普通的截图' })
  lib.update(a.record.id, { saved: true })

  assert.equal(lib.list({ query: '肥鱼' }).length, 1)
  assert.equal(lib.list({ query: '表情包' }).length, 1)
  assert.equal(lib.list({ saved: true }).length, 1)
  assert.equal(lib.list({ saved: false }).length, 1)
  assert.equal(lib.list({}).length, 2)
})

test('「存这个」意图识别只认明确说法', () => {
  for (const text of ['存这个', '存这张图', '收藏这张', '把这张图存起来', '存表情包', '这个存一下']) {
    assert.deepEqual(parseStickerIntent(text), { action: 'save' }, text)
  }
  assert.deepEqual(parseStickerIntent('别存了'), { action: 'unsave' })
  assert.equal(parseStickerIntent('今天存钱了吗'), null)
  assert.equal(parseStickerIntent('这张图挺好看的'), null)
})

test('判断结果解析与隐私规则兜底', () => {
  assert.deepEqual(parseJudge('```json\n{"save":true,"tags":["表情包"],"reason":"梗图"}\n```'), {
    save: true,
    tags: ['表情包'],
    reason: '梗图',
  })
  assert.equal(parseJudge('看不懂').save, false)
  assert.equal(heuristicJudge({ caption: '一张聊天记录截图，含手机号' }).save, false)
  assert.equal(heuristicJudge({ caption: '可爱的猫猫表情包' }).save, true)
  assert.equal(heuristicJudge({ caption: '', animated: true }).save, false)
})

test('judgeSticker 本地模型不可用时退回关键词规则', async () => {
  const { judgeSticker } = await import('../lib/image-judge.js')
  const down = await judgeSticker({
    caption: '可爱的猫猫表情包',
    config: {},
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(down.save, true)
  assert.ok(down.tags.includes('表情包'))

  const verdict = await judgeSticker({
    caption: '一张聊天记录截图，里面有手机号',
    config: {},
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(verdict.save, false)

  const fromModel = await judgeSticker({
    caption: '动图表情',
    config: {},
    fetchImpl: async () => new Response(JSON.stringify({
      message: { content: '{"save":true,"tags":["动图","表情包"],"reason":"表情包动图"}' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(fromModel.save, true)
  assert.deepEqual(fromModel.tags, ['动图', '表情包'])
})

test('客户端附件：attachment id 就是 sha256 文件名', () => {
  const root = tempDir()
  const sha = crypto.createHash('sha256').update(PNG).digest('hex')
  const dir = path.join(root, sha.slice(0, 2))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, sha), PNG)

  assert.equal(resolveAttachmentFile(sha, root), path.join(dir, sha))
  assert.equal(resolveAttachmentFile(sha.slice(0, 10), root), path.join(dir, sha))
  assert.equal(resolveAttachmentFile('../../etc/passwd', root), null)

  const image = readImageBlock({ type: 'image', attachment: { id: sha } }, root)
  assert.ok(image && image.bytes.equals(PNG))
  assert.equal(image.attachmentId, sha)
})

test('collectClientImages 只收用户消息里的图', () => {
  const root = tempDir()
  const sha = crypto.createHash('sha256').update(PNG).digest('hex')
  fs.mkdirSync(path.join(root, sha.slice(0, 2)), { recursive: true })
  fs.writeFileSync(path.join(root, sha.slice(0, 2), sha), PNG)
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '存这个' }, { type: 'image', attachment: { id: sha } }] },
    { role: 'assistant', content: [{ type: 'image', attachment: { id: sha } }] },
    { role: 'user', content: [{ type: 'text', text: '在吗' }] },
  ]
  const images = collectClientImages(messages, root)
  assert.equal(images.length, 1)
  assert.ok(images[0].bytes.equals(PNG))
})

test('installClientImageLibrary 在请求前收图、同一张不重复收', async () => {
  const root = tempDir()
  const sha = crypto.createHash('sha256').update(PNG).digest('hex')
  fs.mkdirSync(path.join(root, sha.slice(0, 2)), { recursive: true })
  fs.writeFileSync(path.join(root, sha.slice(0, 2), sha), PNG)

  const hooks = []
  const ctx = {
    effect: (fn) => fn(),
    on: (name, handler) => {
      hooks.push({ name, handler })
      return () => {}
    },
  }
  const remembered = []
  installClientImageLibrary(ctx, { onImages: (images) => remembered.push(...images), seen: new Set(), root })
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].name, 'llm/stream')

  const options = { messages: [{ role: 'user', content: [{ type: 'image', attachment: { id: sha } }] }] }
  const next = async function* () {
    yield 'chunk'
  }
  const run = async () => {
    const out = []
    for await (const chunk of hooks[0].handler(options, next)) out.push(chunk)
    return out
  }
  assert.deepEqual(await run(), ['chunk'])
  assert.equal(remembered.length, 1)
  await run()
  assert.equal(remembered.length, 1, '同一附件第二次请求不再重复回调')
})

test('newestAttachmentImage 取最近的一张，太旧的不算', () => {
  const root = tempDir()
  const oldSha = crypto.createHash('sha256').update(PNG).digest('hex')
  const newSha = crypto.createHash('sha256').update(GIF).digest('hex')
  for (const sha of [oldSha, newSha]) fs.mkdirSync(path.join(root, sha.slice(0, 2)), { recursive: true })
  const oldFile = path.join(root, oldSha.slice(0, 2), oldSha)
  const newFile = path.join(root, newSha.slice(0, 2), newSha)
  fs.writeFileSync(oldFile, PNG)
  fs.writeFileSync(newFile, GIF)
  const past = Date.now() - 5 * 60 * 60 * 1000
  fs.utimesSync(oldFile, past / 1000, past / 1000)

  const newest = newestAttachmentImage(root, { maxAgeMs: 2 * 60 * 60 * 1000 })
  assert.equal(newest.attachmentId, newSha)
  assert.equal(newest.mediaType, 'image/gif')

  const none = newestAttachmentImage(root, { maxAgeMs: 0 })
  assert.equal(none, null)
})

test('askVision 已有 bytes 时不再下载', async () => {
  const realFetch = globalThis.fetch
  let apiBody = null
  globalThis.fetch = async (_url, options = {}) => {
    apiBody = JSON.parse(options.body)
    return new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '图里有鱼' } }], usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const result = await askVision({
      download: async () => {
        throw new Error('不该走到下载')
      },
      account: { resolveToken: async () => 'token' },
      config: { baseURL: 'https://api.deepseek.com', maxImages: 1 },
      prompt: '看图',
      images: [{ url: 'https://example.test/a.png', bytes: PNG, mediaType: 'image/png' }],
    })
    assert.equal(result.text, '图里有鱼')
    assert.match(apiBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
  } finally {
    globalThis.fetch = realFetch
  }
})
