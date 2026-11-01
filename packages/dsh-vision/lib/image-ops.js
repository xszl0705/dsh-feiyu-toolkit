/**
 * 图像操作：裁剪、取色、缩略。
 *
 * 全部基于 RGBA 像素数组，编解码交给 codec（sharp 优先，纯 JS 兜底）。
 * 不引入任何原生依赖也能跑——这是「能力可以降级，服务不能崩」的具体落地。
 */

import { decodeImage, encodeImage } from './codec.js'

/** 相对坐标(0-1) → 像素矩形，越界自动夹紧。 */
function toPixels(rect, width, height) {
  const clamp = (v, max) => Math.min(max, Math.max(0, Math.round(v)))
  const x = clamp(Number(rect?.x || 0) * width, width - 1)
  const y = clamp(Number(rect?.y || 0) * height, height - 1)
  const w = Math.max(1, clamp(Number(rect?.w || 1) * width, width - x))
  const h = Math.max(1, clamp(Number(rect?.h || 1) * height, height - y))
  return { x, y, w, h }
}

/** 从 RGBA 里裁出一块，返回新的 RGBA 缓冲区。 */
export function cropRgba({ data, width, height }, rect) {
  const { x, y, w, h } = toPixels(rect, width, height)
  const out = Buffer.alloc(w * h * 4)
  for (let row = 0; row < h; row += 1) {
    const srcStart = ((y + row) * width + x) * 4
    data.copy(out, row * w * 4, srcStart, srcStart + w * 4)
  }
  return { data: out, width: w, height: h }
}

/**
 * 主色统计：按 16 级量化分桶（每通道 0-15），桶内取真实均值。
 * 为什么量化：一张 1080p 截图有 200 万像素，精确颜色几乎全是唯一值，直接计数没意义。
 */
export function paletteFromRgba({ data, width, height }, { top = 8, step = 4 } = {}) {
  const buckets = new Map()
  const stride = Math.max(1, Number(step) || 4)
  let total = 0
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 128) continue // 半透明以上不计
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const entry = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 }
      entry.count += 1
      entry.r += r
      entry.g += g
      entry.b += b
      buckets.set(key, entry)
      total += 1
    }
  }
  if (!total) return []
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Number(top) || 8))
    .map((entry) => {
      const r = Math.round(entry.r / entry.count)
      const g = Math.round(entry.g / entry.count)
      const b = Math.round(entry.b / entry.count)
      return {
        hex: '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''),
        rgb: [r, g, b],
        share: Number((entry.count / total).toFixed(4)),
      }
    })
}

/** 最亮/最暗的颜色，用来粗判主题是深色还是浅色。 */
export function toneOf(palette = []) {
  if (!palette.length) return 'unknown'
  const luminance = (item) => {
    const [r, g, b] = item.rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const sorted = [...palette].sort((a, b) => luminance(b) - luminance(a))
  const bright = luminance(sorted[0])
  const dark = luminance(sorted[sorted.length - 1])
  if (bright > 200 && dark < 90) return 'mixed'
  return bright > 160 ? 'light' : 'dark'
}

/** 对外：解码 → 裁剪 → 编码。返回 base64，调用方自己决定存不存盘。 */
export async function cropImage(bytes, rect, { format = 'png' } = {}) {
  const decoded = await decodeImage(bytes)
  const cropped = cropRgba(decoded, rect)
  const encoded = await encodeImage(cropped, { format })
  return {
    base64: encoded.buffer.toString('base64'),
    width: cropped.width,
    height: cropped.height,
    format: encoded.format,
    decodeSource: decoded.source,
    encodeSource: encoded.source,
  }
}

/** 对外：解码 → 统计主色。 */
export async function paletteOfImage(bytes, { top = 8, step = 4 } = {}) {
  const decoded = await decodeImage(bytes)
  const palette = paletteFromRgba(decoded, { top, step })
  return {
    width: decoded.width,
    height: decoded.height,
    palette,
    tone: toneOf(palette),
    decodeSource: decoded.source,
  }
}
