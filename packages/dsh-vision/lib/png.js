/**
 * 纯 JS PNG 编解码器（零原生依赖）。
 *
 * 为什么自己写：sharp 会带进 19MB 原生库，还有 ABI / 平台 / 构建脚本三重风险。
 * PNG 格式本身不复杂——真正的解压交给 Node 内置的 zlib，剩下的只是分块和滤波。
 *
 * 支持范围（够用就行，不追求全规范）：
 *   - 8 位深
 *   - 颜色类型 0(灰度) / 2(RGB) / 4(灰度+alpha) / 6(RGBA)
 *   - 非隔行
 * 不支持：16 位深、调色板(3)、隔行(Adam7)。遇到就明确报错，不猜。
 */

import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** 逐块读 PNG：返回 { width, height, colorType, bitDepth, data(rgba) } */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('不是 PNG（签名不对）')
  }
  let offset = 8
  let header = null
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end > buf.length) break
    if (type === 'IHDR') {
      header = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        bitDepth: buf[start + 8],
        colorType: buf[start + 9],
        interlace: buf[start + 12],
      }
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4 // 跳过 CRC
  }
  if (!header) throw new Error('PNG 缺 IHDR')
  if (header.bitDepth !== 8) throw new Error(`不支持 ${header.bitDepth} 位深`)
  if (header.colorType === 3) throw new Error('不支持调色板 PNG')
  if (header.interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = CHANNELS[header.colorType]
  if (!channels) throw new Error(`不支持颜色类型 ${header.colorType}`)
  if (!idat.length) throw new Error('PNG 没有图像数据')

  const inflated = zlib.inflateSync(Buffer.concat(idat))
  const rgba = unfilter(inflated, header.width, header.height, channels)
  return {
    width: header.width,
    height: header.height,
    channels: 4,
    data: rgba,
    source: 'pure',
  }
}

/** 反滤波：PNG 每行开头一个滤波器字节，按 5 种规则还原。 */
function unfilter(inflated, width, height, channels) {
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let offset = 0

  for (let y = 0; y < height; y += 1) {
    if (offset >= inflated.length) break
    const filter = inflated[offset]
    offset += 1
    const line = Buffer.from(inflated.subarray(offset, offset + stride))
    offset += stride

    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? line[i - bpp] : 0
      const up = prev[i] || 0
      const upLeft = i >= bpp ? prev[i - bpp] || 0 : 0
      let value = line[i]
      if (filter === 1) value = (value + left) & 0xff
      else if (filter === 2) value = (value + up) & 0xff
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff
      else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 0xff
      line[i] = value
    }

    // 统一转 RGBA
    const rowStart = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const src = x * bpp
      const dst = rowStart + x * 4
      if (channels === 4) {
        out[dst] = line[src]
        out[dst + 1] = line[src + 1]
        out[dst + 2] = line[src + 2]
        out[dst + 3] = line[src + 3]
      } else if (channels === 3) {
        out[dst] = line[src]
        out[dst + 1] = line[src + 1]
        out[dst + 2] = line[src + 2]
        out[dst + 3] = 255
      } else if (channels === 1) {
        out[dst] = out[dst + 1] = out[dst + 2] = line[src]
        out[dst + 3] = 255
      } else {
        out[dst] = out[dst + 1] = out[dst + 2] = line[src]
        out[dst + 3] = line[src + 1]
      }
    }
    prev = line
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 编码成 PNG：只写 RGBA + 无滤波，追求简单而不是压缩率。 */
export function encodePng({ data, width, height }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // 滤波器 None
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])) >>> 0, 0)
  return Buffer.concat([length, typeBuf, payload, crc])
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
