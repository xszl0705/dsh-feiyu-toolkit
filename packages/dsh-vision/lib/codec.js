/**
 * 图像编解码选路：优先 sharp，失败静默回落到纯 JS。
 *
 * 为什么这么绕：这台机器上 pnpm 的符号链接结构会让 Electron 的 ESM 解析失败
 * （报 Cannot find package 'detect-libc'），所以 sharp 必须从**平铺安装**的
 * profile node_modules 用 CJS require 取，不能用裸 import。
 *
 * 三层保障：
 *   1. 多个候选路径，逐个试（插件自己的 → 当前 profile → desktop profile）
 *   2. 全部失败只记状态，不抛
 *   3. 纯 JS PNG 解码器永远在，兜底可用
 *
 * 原则：能力可以降级，服务不能崩。
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './png.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

let sharpModule = null
let sharpState = 'unknown' // unknown | ok | failed
let sharpError = ''
let sharpFrom = ''

function candidateRoots() {
  const roots = [path.join(HERE, '..')]
  const profile = String(process.env.DSH_PROFILE || '').trim()
  if (profile) roots.push(path.join(DSH_HOME, 'profiles', profile))
  roots.push(path.join(DSH_HOME, 'profiles', 'desktop'))
  const seen = new Set()
  return roots.filter((root) => {
    if (seen.has(root)) return false
    seen.add(root)
    return fs.existsSync(path.join(root, 'package.json'))
  })
}

/** 惰性加载 sharp：第一次真正用到才找，不在 apply 时碰它。 */
export function loadSharp() {
  if (sharpState !== 'unknown') return sharpModule
  for (const root of candidateRoots()) {
    try {
      const req = createRequire(path.join(root, 'package.json'))
      const mod = req('sharp')
      // 真正碰一下底层，确认二进制能用（能 require 不代表 libvips 加载成功）
      if (!mod?.versions?.vips) continue
      sharpModule = mod
      sharpState = 'ok'
      sharpFrom = root
      return sharpModule
    } catch (error) {
      sharpError = String((error && error.message) || error).slice(0, 160)
    }
  }
  sharpState = 'failed'
  sharpModule = null
  return null
}

export function codecState() {
  return {
    sharp: sharpState,
    from: sharpFrom,
    version: sharpModule?.versions?.sharp || '',
    error: sharpError,
    fallback: 'pure-png',
  }
}

/**
 * 把图片字节解成 RGBA。
 * sharp 能认 JPEG/WebP 等；纯 JS 只认 PNG。
 */
export async function decodeImage(bytes, { preferNative = true } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (preferNative !== false) {
    const sharp = loadSharp()
    if (sharp) {
      try {
        const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        return {
          width: info.width,
          height: info.height,
          channels: 4,
          data: Buffer.isBuffer(data) ? data : Buffer.from(data),
          source: 'sharp',
        }
      } catch {
        // sharp 解不了（格式不支持等）——继续走纯 JS
      }
    }
  }
  return decodePng(buffer)
}

/** 编码：有 sharp 就能出 JPEG，否则纯 JS PNG。 */
export async function encodeImage({ data, width, height }, { format = 'png' } = {}) {
  const sharp = loadSharp()
  if (sharp && format === 'jpeg') {
    try {
      const buf = await sharp(data, { raw: { width, height, channels: 4 } }).jpeg({ quality: 82 }).toBuffer()
      return { buffer: buf, format: 'jpeg', source: 'sharp' }
    } catch {
      // 回落 PNG
    }
  }
  const { encodePng } = await import('./png.js')
  return { buffer: encodePng({ data, width, height }), format: 'png', source: 'pure' }
}
