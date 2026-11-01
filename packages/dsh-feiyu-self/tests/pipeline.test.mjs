import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPipeline, diagnose, expireOld, propose, validateChange } from '../lib/pipeline.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'))
const flagsFile = path.join(temp, 'flags.json')

test('诊断只报有证据的问题', () => {
  const issues = diagnose({
    today: { volume: { requests: 10, replies: 0, failed: 0, blocked: 0 }, rates: {} },
    comparison: { 'latency.p95': { direction: 'up', z: 3.2, value: 900, mean: 600 } },
  })
  assert.equal(issues.some((item) => item.id === 'no-reply'), true)
  assert.equal(issues.some((item) => item.id === 'regress:latency.p95'), true)
  assert.equal(issues.every((item) => Array.isArray(item.evidence)), true)
})

test('失败和刷屏各触发对应诊断', () => {
  const issues = diagnose({
    today: { volume: { requests: 20, replies: 20, failed: 5, blocked: 0 }, rates: { spamRate: 0.5 } },
  })
  assert.equal(issues.some((item) => item.id === 'failures'), true)
  assert.equal(issues.some((item) => item.id === 'spam-high'), true)
})

test('没有可行动 flag 时候选只做提醒', () => {
  const diagnoses = [{ id: 'spam-high', severity: 'warn', text: '刷屏高', evidence: [] }]
  const changes = propose({ diagnoses, flags: [] })
  assert.equal(changes.length, 1)
  assert.equal(changes[0].actionable, false)
  assert.equal(changes[0].status, 'proposed')
})

test('候选只允许改 enabled 和 variants', () => {
  assert.equal(validateChange({ id: 'a', kind: 'flag', diff: { 'f.enabled': true } }).ok, true)
  assert.equal(validateChange({ id: 'a', kind: 'flag', diff: { 'f.audience': {} } }).ok, false)
  assert.equal(validateChange({ id: 'a', kind: 'flag', diff: { 'f.variants': { a: 50 } } }).ok, false)
  assert.equal(validateChange({ id: 'a', kind: 'diagnosis', diff: null }).actionable, false)
})

test('过期候选自动作废', () => {
  const rows = [{ id: 'a', status: 'proposed', expiresAt: '2026-01-01T00:00:00Z' }]
  assert.equal(expireOld(rows, new Date('2026-02-01T00:00:00Z'))[0].status, 'expired')
  assert.equal(expireOld(rows, new Date('2025-12-01T00:00:00Z'))[0].status, 'proposed')
})

test('完整闭环：提议 → 审批 → 应用 → 回滚', () => {
  fs.writeFileSync(flagsFile, JSON.stringify({ 'qq.groupRate': { enabled: true, variants: { control: 100 } } }), 'utf8')
  const pipeline = createPipeline({ dir: path.join(temp, 'evolve'), flagsFile })
  const diagnoses = [{ id: 'spam-high', severity: 'warn', text: '刷屏高', evidence: [{ metric: 'spamRate', value: 0.4 }] }]
  const flags = [{ name: 'qq.groupRate', enabled: true, variants: { control: 100 } }]
  const changes = pipeline.propose({ diagnoses, flags })
  assert.equal(changes.length, 1)
  const id = changes[0].id
  assert.equal(changes[0].actionable, true)

  // 未审批不能应用
  assert.equal(pipeline.apply(id).ok, false)

  pipeline.update(id, { status: 'approved' })
  const applied = pipeline.apply(id)
  assert.equal(applied.ok, true)
  const flagsNow = JSON.parse(fs.readFileSync(flagsFile, 'utf8'))
  assert.deepEqual(flagsNow['qq.groupRate'].variants, { control: 90, reduced: 10 })

  const rolled = pipeline.rollback(id)
  assert.equal(rolled.ok, true)
  const flagsBack = JSON.parse(fs.readFileSync(flagsFile, 'utf8'))
  assert.deepEqual(flagsBack['qq.groupRate'].variants, { control: 100 })
  assert.equal(pipeline.list().find((row) => row.id === id).status, 'rolled-back')
})

test('应用前会备份，备份文件真的存在', () => {
  fs.writeFileSync(flagsFile, JSON.stringify({}), 'utf8')
  const dir = path.join(temp, 'evolve2')
  const pipeline = createPipeline({ dir, flagsFile })
  const change = {
    id: 'chg_20261031_01',
    at: new Date().toISOString(),
    kind: 'flag',
    title: '开 5%',
    evidence: [],
    diff: { 'route.modelHint.enabled': true, 'route.modelHint.variants': { control: 95, tiny: 5 } },
    risk: 'low',
    actionable: true,
    status: 'proposed',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }
  pipeline.merge([change])
  pipeline.update(change.id, { status: 'approved' })
  const applied = pipeline.apply(change.id)
  assert.equal(applied.ok, true)
  assert.equal(fs.existsSync(applied.backup), true)
})

test('程序性记忆里标记为已回滚的方向不再被提', () => {
  const diagnoses = [{ id: 'spam-high', severity: 'warn', text: '刷屏高', evidence: [] }]
  const flags = [{ name: 'qq.groupRate', enabled: true, variants: { control: 100 } }]
  const procedures = [{ kind: 'reverted-change', trigger: '尝试过：把群参与率降到 90%（灰度）' }]
  assert.equal(propose({ diagnoses, flags, procedures }).length, 0)
  assert.equal(propose({ diagnoses, flags, procedures: [] }).length, 1)
})

test('程序性记忆里的其它类型不影响候选生成', () => {
  const diagnoses = [{ id: 'spam-high', severity: 'warn', text: '刷屏高', evidence: [] }]
  const flags = [{ name: 'qq.groupRate', enabled: true, variants: { control: 100 } }]
  const procedures = [{ kind: 'failure-pattern', trigger: 'memory 反复出现 rejected' }]
  assert.equal(propose({ diagnoses, flags, procedures }).length, 1)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
