/**
 * 客户端图片入库：聊天窗口里拖进来的图不经过 QQ 链路。
 *
 * 两条互补的路子，任何一条成功就够：
 * 1) llm/stream 观察器：请求前扫 message content 里的 image 块（块里通常是 attachment id）；
 * 2) 附件目录监视：DSH 把上传的图落在 <DSH_HOME>/attachments/v1/objects/<aa>/<sha256>，
 *    新文件一出现就收——不依赖块结构，结构变了也还能用。
 *
 * attachment id 一般就是内容 sha256；读不到时按最新文件兜底。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sniffImage } from './image-library.js'

export function attachmentsRoot() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, 'attachments', 'v1', 'objects')
}

/** 按 attachment id 找文件；支持完整 sha256 与短前缀。 */
export function resolveAttachmentFile(id, root = attachmentsRoot()) {
  const key = String(id || '').trim().toLowerCase()
  if (!/^[0-9a-f]{8,128}$/.test(key)) return null
  const exact = path.join(root, key.slice(0, 2), key)
  if (fs.existsSync(exact)) return exact
  try {
    const name = fs.readdirSync(path.join(root, key.slice(0, 2))).find((item) => item.startsWith(key))
    return name ? path.join(root, key.slice(0, 2), name) : null
  } catch {
    return null
  }
}

function decodeDataUrl(url) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(url || '').trim())
  if (!match) return null
  return { mediaType: match[1], bytes: Buffer.from(match[2], 'base64') }
}

function readFileIfImage(file) {
  try {
    const bytes = fs.readFileSync(file)
    const sniffed = sniffImage(bytes)
    if (!sniffed) return null
    return { bytes, mediaType: sniffed.mediaType, path: file }
  } catch {
    return null
  }
}

/** 把一个 message content 里的 image 块读成 {bytes, mediaType, attachmentId}；认不出返回 null。 */
export function readImageBlock(block, root = attachmentsRoot()) {
  if (!block || block.type !== 'image') return null
  const value = block.value || {}
  const id = block.attachment?.id
    || (typeof block.attachment === 'string' ? block.attachment : '')
    || block.attachmentId
    || block.id
    || block.image?.id
    || block.file_id
    || block.fileId
    || value.attachment?.id
    || value.attachmentId
    || value.id
  if (id) {
    const file = resolveAttachmentFile(id, root)
    if (file) {
      const image = readFileIfImage(file)
      if (image) return { ...image, attachmentId: String(id) }
    }
  }
  const fromData = decodeDataUrl(block.image_url?.url || block.url || value.url || value.previewUrl)
  if (fromData) return fromData
  const filePath = block.path || block.file || value.path || block.attachment?.path
  if (filePath && fs.existsSync(String(filePath))) {
    const image = readFileIfImage(String(filePath))
    if (image) return image
  }
  const inline = block.source?.data || block.data || value.data
  if (typeof inline === 'string' && inline.length > 64) {
    try {
      return { bytes: Buffer.from(inline, 'base64'), mediaType: block.source?.media_type || block.mediaType || '' }
    } catch {
      return null
    }
  }
  return null
}

/** 只收用户消息里的图（assistant 引用的不算），一轮最多 4 张。 */
export function collectClientImages(messages, root = attachmentsRoot()) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user') continue
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      const image = readImageBlock(block, root)
      if (image?.bytes?.length) out.push(image)
    }
  }
  return out.slice(-4)
}

/** 附件目录里最新的一张图（按 mtime），限定最近 maxAgeMs 内。 */
export function newestAttachmentImage(root = attachmentsRoot(), { maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  let best = null
  const visit = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 2) visit(file, depth + 1)
        continue
      }
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      if (stat.size === 0 || now() - stat.mtimeMs > maxAgeMs) continue
      if (!best || stat.mtimeMs > best.at) best = { file, at: stat.mtimeMs }
    }
  }
  visit(root, 0)
  if (!best) return null
  const image = readFileIfImage(best.file)
  return image ? { ...image, attachmentId: path.basename(best.file), at: best.at } : null
}

function fingerprint(image) {
  if (image.attachmentId) return 'a:' + image.attachmentId
  return 's:' + crypto.createHash('sha256').update(image.bytes).digest('hex')
}

/**
 * 装一个 llm/stream 观察器：请求发出前把用户这轮带的客户端图片交给 onImages。
 * 只读、不改 messages、不影响流式输出；认不出块结构时留一条线索日志。
 */
export function installClientImageLibrary(ctx, { onImages = () => {}, note = () => {}, seen = new Set(), maxSeen = 64, root = attachmentsRoot() } = {}) {
  return ctx.effect(
    () =>
      ctx.on(
        'llm/stream',
        (options, next) =>
          (async function* () {
            try {
              const blocks = []
              for (const message of Array.isArray(options?.messages) ? options.messages : []) {
                if (message?.role !== 'user' || !Array.isArray(message.content)) continue
                for (const block of message.content) if (block?.type === 'image') blocks.push(block)
              }
              if (blocks.length && blocks.every((block) => !readImageBlock(block, root))) {
                note(`客户端图片结构未识别：${JSON.stringify(blocks[0]).slice(0, 300)}`)
              }
              const images = collectClientImages(options?.messages, root)
              const fresh = []
              for (const image of images) {
                const key = fingerprint(image)
                if (seen.has(key)) continue
                seen.add(key)
                if (seen.size > maxSeen) seen.delete(seen.values().next().value)
                fresh.push(image)
              }
              if (fresh.length) onImages(fresh)
            } catch (error) {
              note('客户端图片读取失败：' + String((error && error.message) || error))
            }
            yield* next()
          })(),
        { global: true, prepend: true },
      ),
    'client-image-library',
  )
}

/** 附件目录监视：新上传的图一落盘就交给 onImage，不依赖 llm/stream 的块结构。 */
export function installAttachmentWatcher({ root = attachmentsRoot(), onImage = () => {}, note = () => {}, debounceMs = 500 } = {}) {
  const timers = new Map()
  let watcher = null
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const file = path.join(root, String(filename))
      if (timers.has(file)) clearTimeout(timers.get(file))
      timers.set(file, setTimeout(() => {
        timers.delete(file)
        const image = readFileIfImage(file)
        if (image?.bytes?.length) onImage({ ...image, attachmentId: path.basename(file) })
      }, debounceMs))
    })
  } catch (error) {
    note('附件目录监视安装失败：' + String((error && error.message) || error))
  }
  return () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    try { watcher?.close?.() } catch { /* 已经关了 */ }
  }
}
