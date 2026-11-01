import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanCapabilityFiles } from '../index.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-scan-'))

function plugin(name, manifest) {
  const dir = path.join(temp, name)
  fs.mkdirSync(dir, { recursive: true })
  if (manifest) fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(manifest), 'utf8')
  return dir
}

test('扫描插件目录，只收带 id 的 capability.json', () => {
  plugin('a', { id: 'alpha', intent: '会 A', limits: ['不做 B'] })
  plugin('b', { id: 'beta', intent: '会 B' })
  plugin('c', null)
  plugin('d', { intent: '没有 id 不算' })
  const found = scanCapabilityFiles([temp])
  assert.deepEqual(found.map((item) => item.id).sort(), ['alpha', 'beta'])
  assert.equal(found.find((item) => item.id === 'alpha').intent, '会 A')
  assert.equal(found.every((item) => item.source === 'declared'), true)
})

test('目录不存在时返回空数组，不抛错', () => {
  assert.deepEqual(scanCapabilityFiles([path.join(temp, 'nope')]), [])
  assert.deepEqual(scanCapabilityFiles([]), [])
})

test('坏 JSON 被跳过，不影响其它插件', () => {
  const bad = path.join(temp, 'bad')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, 'capability.json'), '{broken', 'utf8')
  const found = scanCapabilityFiles([temp])
  assert.equal(found.some((item) => item.id === 'alpha'), true)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
