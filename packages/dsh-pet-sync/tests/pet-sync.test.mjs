/**
 * pet-sync 冒烟：它和 pet-hub 共用同一份 lib/pet.js（副本一致性由 copy-parity 之外的人工维护），
 * 这里只保证本包能加载、配置读写路径没断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sync-'))
process.env.DSH_HOME = tmp
const pet = await import('dsh-plugin-kit/pet')
const index = await import('../index.js')

test('插件入口导出 name / apply', () => {
  assert.equal(typeof index.name, 'string')
  assert.equal(typeof index.apply, 'function')
})

test('配置读写与 pet-hub 同源同行为', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'))
  assert.deepEqual(pet.readPetConfig(dir), {})
  pet.writePetConfig(dir, { mode: 'widget' })
  assert.equal(pet.readPetConfig(dir).mode, 'widget')
})

test('状态文件路径落在 DSH_HOME 下', () => {
  assert.equal(path.dirname(pet.stateFilePath()), tmp)
  pet.writeState({ ok: 1 })
  const back = pet.readState()
  assert.equal(back.ok, 1)
  assert.equal(typeof back.updatedAt, 'number', 'writeState 会补 updatedAt 时间戳')
})

test('清理', () => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
