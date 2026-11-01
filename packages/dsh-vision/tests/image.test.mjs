import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodePng, encodePng } from '../lib/png.js'
import { codecState, decodeImage, encodeImage, loadSharp } from '../lib/codec.js'
import { cropRgba, cropImage, paletteFromRgba, paletteOfImage, toneOf } from '../lib/image-ops.js'

/** 造一张 2x2 的图：红 绿 / 蓝 白 */
function tinyImage() {
  const width = 2
  const height = 2
  const data = Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ])
  return { width, height, data }
}

test('编码再解码，像素和尺寸都能还原', async () => {
  const source = tinyImage()
  const png = encodePng(source)
  assert.ok(png.length > 0)
  const decoded = decodePng(png)
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual([...decoded.data], [...source.data])
})

test('不是 PNG 的输入明确报错，不猜', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /签名/)
})

test('裁剪按相对坐标取块', () => {
  const source = tinyImage()
  const cropped = cropRgba(source, { x: 0, y: 0, w: 0.5, h: 0.5 })
  assert.equal(cropped.width, 1)
  assert.equal(cropped.height, 1)
  assert.deepEqual([...cropped.data], [255, 0, 0, 255])
})

test('裁剪越界会被夹紧，不会崩', () => {
  const source = tinyImage()
  const cropped = cropRgba(source, { x: 10, y: 10, w: 10, h: 10 })
  assert.ok(cropped.width >= 1 && cropped.height >= 1)
  assert.ok(cropped.data.length === cropped.width * cropped.height * 4)
})

test('主色统计按量化分桶，白色占 1/4', () => {
  const palette = paletteFromRgba(tinyImage(), { top: 8, step: 1 })
  assert.equal(palette.length, 4)
  const white = palette.find((item) => item.hex === '#ffffff')
  assert.ok(white)
  assert.equal(white.share, 0.25)
})

test('深浅判断：全白是 light，全黑是 dark', () => {
  assert.equal(toneOf([{ hex: '#ffffff', rgb: [255, 255, 255], share: 1 }]), 'light')
  assert.equal(toneOf([{ hex: '#000000', rgb: [0, 0, 0], share: 1 }]), 'dark')
  assert.equal(toneOf([]), 'unknown')
})

test('cropImage 走完整链路：解码 → 裁 → 编码，返回可再解的 base64', async () => {
  const png = encodePng(tinyImage())
  const result = await cropImage(png, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { format: 'png' })
  assert.equal(result.width, 1)
  assert.equal(result.height, 1)
  assert.ok(result.base64.length > 0)
  const decoded = decodePng(Buffer.from(result.base64, 'base64'))
  assert.deepEqual([...decoded.data], [0, 255, 0, 255])
})

test('paletteOfImage 返回尺寸、主色、深浅', async () => {
  const png = encodePng(tinyImage())
  const result = await paletteOfImage(png, { top: 4, step: 1 })
  assert.equal(result.width, 2)
  assert.equal(result.height, 2)
  assert.ok(result.palette.length >= 1)
  assert.ok(['light', 'dark', 'mixed', 'unknown'].includes(result.tone))
})

test('真实截图：能解码、能取色、耗时在可接受范围', async () => {
  const dir = path.join(os.tmpdir(), 'dsh-screens')
  if (!fs.existsSync(dir)) return
  const file = fs.readdirSync(dir).find((name) => name.endsWith('.png'))
  if (!file) return
  const bytes = fs.readFileSync(path.join(dir, file))
  const started = Date.now()
  const result = await paletteOfImage(bytes, { top: 5, step: 8 })
  const ms = Date.now() - started
  assert.ok(result.width > 100 && result.height > 100)
  assert.ok(result.palette.length >= 1)
  // 取样步长 8，1080p 大约 3 万次采样，2 秒内必须完成
  assert.ok(ms < 2000, `耗时 ${ms}ms 太慢`)
})

test('sharp 加载状态可查，且不会因为失败而崩溃', () => {
  const state = codecState()
  assert.ok(['unknown', 'ok', 'failed'].includes(state.sharp))
  assert.equal(state.fallback, 'pure-png')
  // 无论成功失败，都不该抛
  assert.doesNotThrow(() => loadSharp())
})

test('解码自动选路：sharp 可用走 sharp，不可用走纯 JS', async () => {
  const png = encodePng(tinyImage())
  const decoded = await decodeImage(png)
  assert.ok(['sharp', 'pure'].includes(decoded.source), decoded.source)
  // 两条路都要能正确解出像素
  assert.deepEqual([...decoded.data.subarray(0, 4)], [255, 0, 0, 255])
})

test('可以显式要求不用原生（preferNative:false）', async () => {
  const png = encodePng(tinyImage())
  const decoded = await decodeImage(png, { preferNative: false })
  assert.equal(decoded.source, 'pure')
})

test('JPEG 编码在 sharp 可用时走原生，否则回落 PNG', async () => {
  const result = await encodeImage(tinyImage(), { format: 'jpeg' })
  assert.ok(['jpeg', 'png'].includes(result.format))
  assert.ok(result.buffer.length > 0)
  assert.ok(['sharp', 'pure'].includes(result.source))
})
