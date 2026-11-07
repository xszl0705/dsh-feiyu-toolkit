/**
 * QQ 图片 → DeepSeek 原生视觉。
 *
 * 不走 DSH 的 image 准入，直接用账号 token 调 DeepSeek chat/completions，
 * 这样即使 DSH provider 把图片投影成占位，QQ 侧也能真正看图。
 */

import { publicDownload } from './public-download.js'

const DEFAULT_BASE = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_IMAGES = 2

function normalizeUsage(raw = {}) {
  const promptTokens = Number(raw.prompt_tokens ?? raw.inputTokens ?? raw.promptTokens ?? 0) || 0
  const outTokens = Number(raw.completion_tokens ?? raw.outputTokens ?? raw.outTokens ?? 0) || 0
  const cacheReadTokens = Number(raw.prompt_cache_hit_tokens ?? raw.cacheReadTokens ?? 0) || 0
  return {
    promptTokens,
    outTokens,
    cacheReadTokens,
    totalTokens: promptTokens + outTokens,
  }
}

async function fetchImage(image, config, download = publicDownload) {
  const url = String(image?.url || '').trim()
  if (!url) throw new Error('image url missing')
  const maxBytes = Math.max(1024, Number(config?.maxBytes) || DEFAULT_MAX_BYTES)
  const res = await download(url, { maxBytes, timeoutMs: Number(config?.downloadTimeoutMs) || 20000 })
  const type = String(res.headers?.['content-type'] || 'image/jpeg').split(';')[0]
  if (!/^image\//i.test(type)) throw new Error(`not image: ${type}`)
  const bytes = Buffer.from(res.bytes)
  if (bytes.length > maxBytes) throw new Error(`image too large: ${bytes.length}`)
  return { type, bytes }
}

async function postVision({ account, config, content, maxTokens, onUsage }) {
  if (!account || typeof account.resolveToken !== 'function') throw new Error('没有 deepseekAccount 服务')
  const baseURL = String(config.baseURL || DEFAULT_BASE).replace(/\/+$/, '')
  // 两条认证路径：优先配置里的官方 API key（Bearer），否则退回宿主账号 token。
  // 实测：宿主账号 token 发给 api.deepseek.com 会被判 "invalid dsh token"——
  // 平台 token 只对宿主自己的推理网关有效，不是 DeepSeek 的 API key。
  const apiKey = String(config.apiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  let headers
  if (apiKey) {
    headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  } else {
    const token = await account.resolveToken(baseURL)
    if (!token) throw new Error('没有 DeepSeek 账号 token')
    headers = { 'content-type': 'application/json', 'x-dsh-auth-token': token }
  }

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: String(config.model || DEFAULT_MODEL),
      messages: [{ role: 'user', content }],
      max_tokens: Math.max(128, Number(maxTokens) || 1000),
      stream: false,
    }),
    signal: AbortSignal.timeout(Number(config.timeoutMs) || 45000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 && !apiKey) {
      throw new Error(
        `vision api 401：宿主账号 token 不能直连 ${baseURL}（DeepSeek 只认自己的 API key）。` +
          `请在 config.json 里配 vision.apiKey，或设置环境变量 DEEPSEEK_API_KEY。原始响应：${text.slice(0, 120)}`,
      )
    }
    throw new Error(`vision api ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  // deepseek-flash 是 reasoning 模型：看图时内容常落在 reasoning_content、content 为空；
  // deepseek-chat 能直接出 content。两条都认，避免把「模型确实看了图」误报成 empty reply。
  const message = data?.choices?.[0]?.message || {}
  const reply = String(message.content || message.reasoning_content || '').trim()
  if (!reply) throw new Error('vision empty reply')
  if (typeof onUsage === 'function') onUsage(normalizeUsage(data?.usage || {}))
  return {
    text: reply,
    model: String(data?.model || config.model || DEFAULT_MODEL),
    route: 'vision',
  }
}

/** 直接发送已经读入内存的图片：{mediaType, bytes}。 */
export async function askVisionBytes({ account, config = {}, prompt, images = [], maxTokens = 1000, onUsage = null }) {
  if (!images.length) throw new Error('没有可发送的图片')
  const content = [{ type: 'text', text: String(prompt || '') }]
  for (const image of images.slice(0, Math.max(1, Number(config.maxImages) || DEFAULT_MAX_IMAGES))) {
    const type = String(image?.mediaType || 'image/jpeg')
    const bytes = Buffer.isBuffer(image?.bytes) ? image.bytes : Buffer.from(image?.bytes || [])
    const maxBytes = Math.max(1024, Number(config.maxBytes) || DEFAULT_MAX_BYTES)
    if (!bytes.length) throw new Error('image bytes empty')
    if (bytes.length > maxBytes) throw new Error(`image too large: ${bytes.length}`)
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${type};base64,${bytes.toString('base64')}`,
        detail: String(config.detail || 'high'),
      },
    })
  }
  return postVision({ account, config, content, maxTokens, onUsage })
}

export async function askVision({ account, config = {}, download = publicDownload, prompt, images = [], maxTokens = 1000, onUsage = null }) {
  const list = images.slice(0, Math.max(1, Number(config.maxImages) || DEFAULT_MAX_IMAGES))
  if (!list.length) throw new Error('没有可发送的图片')
  const maxBytes = Math.max(1024, Number(config.maxBytes) || DEFAULT_MAX_BYTES)
  const loaded = []
  for (const image of list) {
    // 图片库已经下载过的图直接带 bytes，别为了看图再下一遍
    if (Buffer.isBuffer(image?.bytes) && image.bytes.length) {
      if (image.bytes.length > maxBytes) throw new Error(`image too large: ${image.bytes.length}`)
      loaded.push({ mediaType: String(image.mediaType || 'image/jpeg'), bytes: image.bytes })
      continue
    }
    const { type, bytes } = await fetchImage(image, config, download)
    loaded.push({ mediaType: type, bytes })
  }
  return askVisionBytes({ account, config, prompt, images: loaded, maxTokens, onUsage })
}
