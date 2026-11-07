/**
 * vision_describe 路径白名单：越界路径拒绝、非图片拒绝、显式目录放行。
 * 验收用例直接对齐方案 0.5：传 C:\\Windows\\win.ini 必须被拒。
 * 2026-11-04 随工具从 dsh-qq-adapter 迁到本插件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVisionPath, sniffImageType } from '../lib/vision-path.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.dirname(HERE)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-path-'))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function writePng(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PNG)
  return file
}

test('临时目录里的真实 PNG 可以读', () => {
  const file = writePng(path.join(temp, 'ok.png'))
  const got = resolveVisionPath(file)
  assert.equal(got.mediaType, 'image/png')
  assert.deepEqual(got.bytes, PNG)
})

test('非图片即使叫 .png 也拒绝', () => {
  const file = path.join(temp, 'fake.png')
  fs.writeFileSync(file, '这不是图片', 'utf8')
  assert.throws(() => resolveVisionPath(file), /不是可识别的图片/)
  assert.equal(sniffImageType(Buffer.from('hello')), '')
})

test('C:\\Windows\\win.ini 被拒（白名单 + 非图片）', () => {
  assert.throws(() => resolveVisionPath('C:\\Windows\\win.ini'), /不允许读取|不是可识别的图片/)
})

test('白名单外的图片也拒绝，加 allowedRoots 后放行', () => {
  const file = writePng(path.join(WORKSPACE, '_tmp', 'outside-vision.png'))
  try {
    assert.throws(() => resolveVisionPath(file), /不允许读取/)
    const got = resolveVisionPath(file, { extraRoots: [path.dirname(file)] })
    assert.equal(got.mediaType, 'image/png')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
