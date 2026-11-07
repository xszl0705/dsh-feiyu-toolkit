/**
 * vision_describe 的路径白名单。
 *
 * 工具参数里的路径是模型给的，不能直接按路径读任意文件（否则一句
 * 「看看 C:\\Windows\\win.ini」就能把本机任意文件送进视觉模型）。
 *
 * 两道闸：
 *  1. 路径必须在允许的根目录下：$DSH_HOME 的 attachments / image-library、
 *     系统临时目录、以及本插件 config.json 里 `vision.allowedRoots` 显式配置的目录；
 *  2. 文件头必须是真实图片（png / jpeg / gif / webp / bmp）——改名成 .png 的文本文件也读不了。
 *
 * 2026-11-04 从 dsh-qq-adapter 迁来：工具跟着 vision 走，白名单也一起搬。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff])
const GIF = Buffer.from('GIF8', 'ascii')
const BMP = Buffer.from('BM', 'ascii')

/** 按文件头认图片类型；认不出返回空字符串。 */
export function sniffImageType(bytes) {
  const head = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || [])
  if (head.length >= PNG.length && head.subarray(0, PNG.length).equals(PNG)) return 'image/png'
  if (head.length >= JPEG.length && head.subarray(0, JPEG.length).equals(JPEG)) return 'image/jpeg'
  if (head.length >= GIF.length && head.subarray(0, GIF.length).equals(GIF)) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (head.length >= BMP.length && head.subarray(0, BMP.length).equals(BMP)) return 'image/bmp'
  return ''
}

function defaultRoots() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return [
    path.join(home, 'attachments'),
    path.join(home, 'dafeiyu', 'image-library'),
    os.tmpdir(),
  ]
}

function canonical(root) {
  const absolute = path.resolve(String(root || ''))
  try {
    return fs.realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** file 是否在 root 子树内（按路径分段判断，避免 C:\a 匹配 C:\ab）。 */
export function isUnder(file, root) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * 校验并读出图片。
 * @returns {{ file: string, mediaType: string, bytes: Buffer }}
 * @throws 路径越界、文件不存在、不是图片、超过大小上限
 */
export function resolveVisionPath(input, { extraRoots = [], maxBytes = MAX_IMAGE_BYTES } = {}) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('path 为空')

  let real
  try {
    real = fs.realpathSync(path.resolve(raw))
  } catch {
    throw new Error('文件不存在：' + raw)
  }

  const stat = fs.statSync(real)
  if (!stat.isFile()) throw new Error('不是文件：' + real)
  if (stat.size > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)

  const roots = [...defaultRoots(), ...extraRoots].filter(Boolean).map(canonical)
  if (!roots.some((root) => isUnder(real, root))) {
    throw new Error('不允许读取这个路径（只允许 ~/.dsh 附件、图片库、临时目录或 vision.allowedRoots 下的图片）：' + real)
  }

  const fd = fs.openSync(real, 'r')
  let head
  try {
    head = Buffer.alloc(Math.min(stat.size, 16))
    fs.readSync(fd, head, 0, head.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  const mediaType = sniffImageType(head)
  if (!mediaType) throw new Error('不是可识别的图片（仅支持 png / jpeg / gif / webp / bmp）')

  return { file: real, mediaType, bytes: fs.readFileSync(real) }
}
