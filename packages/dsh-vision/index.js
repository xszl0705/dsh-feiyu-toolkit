/**
 * dsh-vision — 看图（从 dsh-qq-adapter 抽出来）。
 *
 * 为什么单独成插件：
 *  - 视觉是感知器官，不是「QQ 渠道」的一部分；
 *  - 客户端拖图、QQ 消息图、以后别的渠道的图，都该走同一条链路；
 *  - 抽出来以后 qq 不再背着三条 vision 文件。
 *
 * 兼容策略：
 *  - qq 侧优先用这个服务，拿不到再回退自己那份；
 *  - 账号服务（deepseekAccount）通过 ctx 取，取不到如实报错。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from './lib/lifecycle.js'
import { askVision, askVisionBytes } from './lib/vision.js'
import { buildVisionContextPrompt } from './lib/vision-context.js'
import { installClientVisionContext } from './lib/client-vision-context.js'
import { codecState } from './lib/codec.js'
import { cropImage, paletteOfImage } from './lib/image-ops.js'
import { publicDownload } from './lib/public-download.js'

export const name = 'dsh-vision'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_KEY = Symbol.for('dsh-vision.service')

const DEFAULTS = { enabled: true, maxTokens: 1000, installClientContext: true }

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  try {
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了不影响看图
  }
}

function state(ctx) {
  return lifecycle(ctx, () => ({
    started: false,
    calls: 0,
    failures: 0,
    byReason: { account: 0, network: 0, input: 0, vision: 0 },
    lastError: '',
    perf: [],
  }))
}

/** 记一条图像处理耗时，供 perfStats 聚合（环形 60 条，不落盘）。 */
function recordPerf(st, entry) {
  st.perf.push({ at: new Date().toISOString(), ...entry })
  if (st.perf.length > 60) st.perf.shift()
}

/**
 * 把失败分个类。
 * 「账号挂了」和「图太大」混在一个 failures 里，self_metrics 会误判成视觉能力退化。
 */
function classifyFailure(error) {
  const text = String((error && error.message) || error || '')
  if (/40[13]\b|token|auth|unauthorized|permission/i.test(text)) return 'account'
  if (/timeout|timed out|network|ECONN|socket|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(text)) return 'network'
  if (/too large|exceed|invalid|unsupported|地址|上限|不合法/i.test(text)) return 'input'
  return 'vision'
}

export function apply(ctx) {
  const st = state(ctx)
  // 幂等：宿主可能对同一插件重复 apply，第二次直接把已有服务还回去
  if (st.started) return st.api || undefined
  const config = loadConfig()
  if (config.enabled === false) {
    note('config.enabled=false，未启动')
    return
  }
  st.started = true

  const account = () => {
    try {
      return ctx.get?.('deepseekAccount') || null
    } catch {
      return null
    }
  }

  async function guard(kind, run) {
    st.calls += 1
    try {
      const result = await run()
      if (result && result.ok === false) {
        st.failures += 1
        st.lastError = String(result.error || '')
        st.byReason[classifyFailure(result.error)] += 1
      }
      return result
    } catch (error) {
      st.failures += 1
      st.lastError = String((error && error.message) || error)
      st.byReason[classifyFailure(error)] += 1
      note(`${kind} 失败：${st.lastError}`)
      return { ok: false, text: '', error: st.lastError, reason: classifyFailure(error) }
    }
  }

  /**
   * 从 images[0] 拿字节：有 bytes 直接用，有 url 就下载（走公网地址校验）。
   * 裁剪/取色不需要模型，但需要真实像素——所以这里必须拿到完整字节。
   */
  async function firstImageBytes(images) {
    const first = Array.isArray(images) ? images[0] : null
    if (!first) throw new Error('缺图片')
    if (first.bytes) return Buffer.from(first.bytes)
    if (first.url) {
      const result = await publicDownload(first.url, {
        maxBytes: Number(config.vision?.maxImageBytes) || 8388608,
      })
      if (!result?.bytes?.length) throw new Error('下载回来是空的')
      return result.bytes
    }
    throw new Error('图片既没有 bytes 也没有 url')
  }

  /**
   * OCR：逐字读图。
   * 和 askVision 的区别只有 prompt —— 不描述、不解释，只把字抄下来。
   * 为什么不用本地 OCR：我们已经有能看图的模型，多装一整套图像栈不值得。
   */
  const OCR_PROMPT = [
    '逐字读出图中所有文字，保留原有的换行和分段。',
    '只输出读到的文字，不要解释、不要总结、不要加「图中写着」这类前缀。',
    '原文是什么语言就保留什么语言。',
    '看不清的字用「□」代替；整张图都看不清就直接说「看不清」。',
  ].join('')

  const COMPARE_PROMPT = [
    '这是两张图。只描述它们之间**可见的差异**：多了什么、少了什么、位置挪了、颜色变了、文字改了什么。',
    '如果两张图完全一样，就说「没有差异」。',
    '不要评价好坏，不要猜原因。',
  ].join('')

  const groundPrompt = (target) =>
    [
      `在图中找到「${target}」。`,
      '如果找到，只输出 JSON：{"found":true,"x":0.5,"y":0.3,"description":"它长什么样、在哪个方位"}',
      'x、y 是相对坐标（0 到 1，左上角是原点）。',
      '如果找不到，只输出 {"found":false}。不要输出任何其它文字。',
    ].join('')

  /** 从模型回复里抠出 JSON，容忍 ```json 包裹和前后废话。 */
  function parseJsonReply(text) {
    const raw = String(text || '').trim()
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    const body = fenced ? fenced[1] : raw
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch {
      return null
    }
  }

  const api = {
    id: 'vision',
    buildVisionContextPrompt,
    // 元素定位：让她说「那个按钮在哪」，返回相对坐标
    locate: (options = {}) => {
      const target = String(options.target || '').trim()
      if (!target) return Promise.resolve({ ok: false, found: false, error: '缺 target' })
      const images = Array.isArray(options.images) ? options.images : []
      const hasBytes = images.some((image) => image && image.bytes)
      const runner = hasBytes ? askVisionBytes : askVision
      return guard('locate', async () => {
        const result = await runner({
          config: config.vision || {},
          maxTokens: config.maxTokens,
          ...options,
          prompt: options.prompt || groundPrompt(target),
          account: options.account ?? account(),
        })
        const parsed = parseJsonReply(result?.text)
        if (!parsed || typeof parsed !== 'object') {
          return { ...result, found: false, error: '模型没按 JSON 回答' }
        }
        return {
          ...result,
          found: Boolean(parsed.found),
          x: Number.isFinite(Number(parsed.x)) ? Number(parsed.x) : null,
          y: Number.isFinite(Number(parsed.y)) ? Number(parsed.y) : null,
          description: String(parsed.description || ''),
        }
      })
    },
    // 两张图对比：语义差异，不做像素级计算
    compare: (options = {}) => {
      const images = Array.isArray(options.images) ? options.images : []
      if (images.length < 2) return Promise.resolve({ ok: false, error: '需要两张图' })
      const hasBytes = images.some((image) => image && image.bytes)
      const runner = hasBytes ? askVisionBytes : askVision
      return guard('compare', () =>
        runner({
          config: config.vision || {},
          maxTokens: config.maxTokens,
          ...options,
          prompt: options.prompt || COMPARE_PROMPT,
          account: options.account ?? account(),
        }),
      )
    },
    // OCR：图片既可以是远程 url，也可以是本地字节，按给的内容选下载还是直传
    readText: (options = {}) => {
      const images = Array.isArray(options.images) ? options.images : []
      const hasBytes = images.some((image) => image && image.bytes)
      const runner = hasBytes ? askVisionBytes : askVision
      return guard('readText', () =>
        runner({
          config: config.vision || {},
          maxTokens: config.ocrMaxTokens || 2000,
          ...options,
          prompt: options.prompt || OCR_PROMPT,
          account: options.account ?? account(),
        }),
      )
    },
    askVision: (options = {}) =>
      guard('askVision', () =>
        askVision({
          config: config.vision || {},
          maxTokens: config.maxTokens,
          ...options,
          account: options.account ?? account(),
        }),
      ),
    askVisionBytes: (options = {}) =>
      guard('askVisionBytes', () =>
        askVisionBytes({
          config: config.vision || {},
          maxTokens: config.maxTokens,
          ...options,
          account: options.account ?? account(),
        }),
      ),
    // 裁剪：解码 → 裁 → 编码，返回 base64。sharp 可用时走 sharp，否则纯 JS。
    crop: (options = {}) =>
      guard('crop', async () => {
        const started = Date.now()
        const bytes = await firstImageBytes(options.images)
        const result = await cropImage(bytes, options.rect || {}, { format: options.format || 'png' })
        recordPerf(st, {
          kind: 'crop',
          inputBytes: bytes.length,
          ms: Date.now() - started,
          width: result.width,
          height: result.height,
          source: result.decodeSource,
        })
        return { ok: true, ...result }
      }),
    // 主色：解码 → 量化统计 → top N
    palette: (options = {}) =>
      guard('palette', async () => {
        const started = Date.now()
        const bytes = await firstImageBytes(options.images)
        const result = await paletteOfImage(bytes, { top: Number(options.top) || 8, step: Number(options.step) || 4 })
        recordPerf(st, {
          kind: 'palette',
          inputBytes: bytes.length,
          ms: Date.now() - started,
          width: result.width,
          height: result.height,
          source: result.decodeSource,
        })
        return { ok: true, ...result }
      }),
    // 多目标检测：locate 的复数版，一次列出多个元素及相对坐标
    detect: (options = {}) => {
      const question = String(options.question || '图里有哪些可以点击或值得注意的元素').trim()
      const images = Array.isArray(options.images) ? options.images : []
      const hasBytes = images.some((image) => image && image.bytes)
      const runner = hasBytes ? askVisionBytes : askVision
      const prompt =
        `列出${question}。只输出 JSON：{"items":[{"label":"名称","x":0.5,"y":0.3,"description":"长什么样、在哪个方位"}]}。` +
        'x、y 是相对坐标（0 到 1，左上角为原点）。一个都没有就输出 {"items":[]}。不要输出任何其它文字。'
      return guard('detect', async () => {
        const result = await runner({
          config: config.vision || {},
          maxTokens: config.maxTokens,
          ...options,
          prompt: options.prompt || prompt,
          account: options.account ?? account(),
        })
        const parsed = parseJsonReply(result?.text)
        const items = Array.isArray(parsed?.items)
          ? parsed.items
              .map((item) => ({
                label: String(item?.label || '').slice(0, 40),
                x: Number.isFinite(Number(item?.x)) ? Number(item.x) : null,
                y: Number.isFinite(Number(item?.y)) ? Number(item.y) : null,
                description: String(item?.description || '').slice(0, 120),
              }))
              .filter((item) => item.label)
          : []
        return { ...result, items, count: items.length }
      })
    },
    perfStats: () => {
      const rows = st.perf.slice(-30)
      if (!rows.length) return { samples: 0, byKind: {}, inputBytesAvg: null, slowest: null }
      const byKind = {}
      for (const row of rows) {
        const bucket = byKind[row.kind] || { count: 0, msSum: 0, msMax: 0, native: 0 }
        bucket.count += 1
        bucket.msSum += Number(row.ms) || 0
        bucket.msMax = Math.max(bucket.msMax, Number(row.ms) || 0)
        if (row.source === 'sharp') bucket.native += 1
        byKind[row.kind] = bucket
      }
      for (const bucket of Object.values(byKind)) {
        bucket.avgMs = Math.round(bucket.msSum / bucket.count)
        delete bucket.msSum
      }
      const slowest = rows.reduce((worst, row) => ((Number(row.ms) || 0) > (Number(worst?.ms) || 0) ? row : worst), null)
      return {
        samples: rows.length,
        byKind,
        inputBytesAvg: Math.round(rows.reduce((sum, row) => sum + (Number(row.inputBytes) || 0), 0) / rows.length),
        slowest,
        codec: codecState(),
      }
    },
    installClientVisionContext: (targetCtx = ctx, extra = {}) => {
      if (config.installClientContext === false) return false
      try {
        installClientVisionContext(targetCtx, { note, ...extra })
        return true
      } catch (error) {
        note('客户端图片上下文注入安装失败：' + String((error && error.message) || error))
        return false
      }
    },
    stats: () => ({ calls: st.calls, failures: st.failures, byReason: { ...st.byReason }, lastError: st.lastError }),
  }

  try {
    if (typeof ctx.provide === 'function') ctx.provide('vision', api)
  } catch {
    // 宿主可能不认这个服务名
  }
  globalThis[SERVICE_KEY] = api
  st.own(() => {
    if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY]
  })

  // 把状态报给 self
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.declare?.({
      id: 'vision',
      package: 'dsh-vision',
      intent: '看图：把图片转成文字描述，供模型在拿不到原生视觉时使用',
      limits: ['只描述看到的，不推测图片外的事', '远程图只取公网地址，内网/回环拒绝', '模型不可用时如实报错，不编描述'],
      failureModes: [
        { code: 'VISION_UNAVAILABLE', meaning: '视觉模型服务不可用', retry: '如实返回错误' },
        { code: 'NON_PUBLIC_ADDRESS', meaning: '图片地址指向内网/回环', retry: '拒绝下载' },
      ],
      scope: ['owner', 'group', 'private'],
      state: () => ({
        calls: st.calls,
        failures: st.failures,
        byReason: { ...st.byReason },
        lastError: st.lastError ? st.lastError.slice(0, 60) : '',
      }),
    })
  } catch {
    // self 没装不影响看图
  }

  note('dsh-vision 就绪')
  st.api = api
  return api
}
