/**
 * pet-hub 冒烟：配置读写与状态文件。不启动真实桌宠进程，只测落盘行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-hub-'))
process.env.DSH_HOME = tmp
const { readPetConfig, writePetConfig, readState, writeState } = await import('dsh-plugin-kit/pet')

test('没有配置时返回空对象，不抛错', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'empty-'))
  assert.deepEqual(readPetConfig(dir), {})
})

test('writePetConfig 合并 patch 并落盘', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'))
  writePetConfig(dir, { skin: 'dafeiyu', size: 0.7 })
  writePetConfig(dir, { size: 0.9 })
  const back = readPetConfig(dir)
  assert.equal(back.skin, 'dafeiyu', '旧键不能被覆盖掉')
  assert.equal(back.size, 0.9, '同名键以后写的为准')
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), true)
})

test('readState 无文件时返回空对象', () => {
  fs.rmSync(path.join(tmp, 'pet-sync.json'), { force: true })
  assert.deepEqual(readState(), {})
})

test('writeState 写入后可读回', () => {
  const written = writeState({ mode: 'pet', since: 123 })
  assert.equal(written.mode, 'pet')
  const back = readState()
  assert.equal(back.mode, 'pet')
  assert.equal(back.since, 123)
})

test('清理', () => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
