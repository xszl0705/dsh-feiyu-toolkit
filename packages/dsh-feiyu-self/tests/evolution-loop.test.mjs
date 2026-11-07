/**
 * 阶段 1.5 进化闭环：诊断源聚合、单一候选制、三重验证、变体档案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_ACTIVE_CHANGES,
  MAX_DIFF_LINES,
  archiveVariant,
  diagnoseFromSources,
  propose,
  tripleVerify,
  validateChange,
} from '../lib/pipeline.js'

const diag = (id, severity = 'warn') => ({ id, severity, text: id, evidence: [{ metric: id }] })

test('1.5.1 diagnoseFromSources：load.log 同句出现 2 次才报', () => {
  const loadLogs = {
    'dsh-vision': '2026-11-04T10:00:00.000Z  重试注册截图工具失败\n2026-11-04T10:01:00.000Z  重试注册截图工具失败\n2026-11-04T10:02:00.000Z  偶发一次',
    'dsh-qq-adapter': '2026-11-04T10:00:00.000Z  只出现一次',
  }
  const found = diagnoseFromSources({ loadLogs })
  assert.equal(found.length, 1)
  assert.equal(found[0].id, 'loadlog:dsh-vision')
  assert.equal(found[0].evidence[0].count, 2)
})

test('1.5.1 diagnoseFromSources：回归失败与未覆盖插件各一条', () => {
  const found = diagnoseFromSources({
    verifyFailures: [{ name: 'tests/x.test.mjs', exit: 1 }],
    uncoveredPlugins: ['dsh-new-thing'],
  })
  assert.equal(found.length, 2)
  assert.equal(found.some((row) => row.id.startsWith('verify-fail:')), true)
  assert.equal(found.some((row) => row.id === 'uncovered:dsh-new-thing'), true)
  assert.equal(found.find((row) => row.id.startsWith('verify-fail:')).severity, 'warn')
})

test('1.5.1 降噪：正常启动信息重复多少次都不报', () => {
  const loadLogs = {
    'dsh-vision': [
      '2026-11-04T10:00:00.000Z  dsh-vision 就绪',
      '2026-11-04T10:01:00.000Z  dsh-vision 就绪',
      '2026-11-04T10:02:00.000Z  工具已注册',
      '2026-11-04T10:03:00.000Z  工具已注册',
    ].join('\n'),
  }
  assert.deepEqual(diagnoseFromSources({ loadLogs }), [], '「就绪/已注册」不是问题')
})

test('1.5.1 降噪：真实错误仍然报，且是 warn', () => {
  const loadLogs = {
    'dsh-screenshot': '2026-11-04T10:00:00.000Z  60s 内没等到 tools 服务，screenshot 未注册\n2026-11-04T10:01:00.000Z  60s 内没等到 tools 服务，screenshot 未注册',
    'dsh-vision': '2026-11-04T10:00:00.000Z  askVisionBytes 失败：vision api 401\n2026-11-04T10:01:00.000Z  askVisionBytes 失败：vision api 401',
  }
  const found = diagnoseFromSources({ loadLogs })
  assert.equal(found.length, 2)
  assert.equal(found.every((row) => row.severity === 'warn'), true)
  assert.equal(found.some((row) => row.id === 'loadlog:dsh-screenshot'), true)
  assert.equal(found.some((row) => row.id === 'loadlog:dsh-vision'), true)
})

test('1.5.2 单一候选制：在途满时新候选降级为提醒', () => {
  const flags = [{ name: 'qq.groupRate' }]
  const free = propose({ diagnoses: [diag('spam-high')], flags })
  assert.equal(free[0].actionable, true, '没有在途候选时应可应用')

  const busy = propose({
    diagnoses: [diag('spam-high')],
    flags,
    active: [{ id: 'chg_x', actionable: true, status: 'approved' }],
  })
  assert.equal(busy[0].actionable, false)
  assert.equal(busy[0].blockedBy.includes(String(MAX_ACTIVE_CHANGES)), true)
  assert.equal(busy[0].downgradedFrom, 'actionable')
})

test('1.5.2 单一候选制：只算 proposed/approved/applied 的在途', () => {
  const busy = propose({
    diagnoses: [diag('spam-high')],
    flags: [{ name: 'qq.groupRate' }],
    active: [{ id: 'chg_x', actionable: true, status: 'rolled-back' }],
  })
  assert.equal(busy[0].actionable, true, '已回滚的不占额度')
})

test('1.5.2 改动规模上限：配置看字符数、补丁看行数', () => {
  const variants = { control: 50, reduced: 50 }
  for (let i = 0; i < 398; i += 1) variants['v_' + i] = 0
  const huge = validateChange({ id: 'a', kind: 'flag', diff: { 'f.variants': variants } })
  assert.equal(huge.ok, false)
  assert.equal(huge.problems[0].includes('字符'), true)

  const bigPatch = validateChange({
    id: 'b',
    kind: 'flag',
    patch: Array.from({ length: MAX_DIFF_LINES + 10 }, () => 'x').join('\n'),
    diff: { 'f.enabled': true },
  })
  assert.equal(bigPatch.ok, false)
  assert.equal(bigPatch.problems[0].includes('补丁'), true)

  const ok = validateChange({ id: 'c', kind: 'flag', diff: { 'f.enabled': true } })
  assert.equal(ok.ok, true, '小改动不该被拦')
})

test('1.5.3 三重验证：三项全绿才 ok', () => {
  const pass = tripleVerify({
    target: { ok: true, detail: 'fixed' },
    migration: { ok: true },
    full: { ok: true, pass: 63, total: 63 },
  })
  assert.equal(pass.ok, true)
  assert.equal(pass.full.pass, 63)

  const fail = tripleVerify({ target: { ok: true }, migration: { ok: false, detail: '同类用例 2 个失败' }, full: { ok: true, pass: 61, total: 63 } })
  assert.equal(fail.ok, false)
  assert.equal(fail.blockers.length, 1)
  assert.equal(fail.blockers[0].startsWith('migration:'), true)

  const missing = tripleVerify({ target: { ok: true } })
  assert.equal(missing.ok, false)
  assert.equal(missing.blockers.some((row) => row.includes('缺同类迁移子集结果')), true)
})

test('1.5.4 变体档案：落三件并按 keep 保留最近 N 个', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants-'))
  try {
    for (let i = 0; i < 12; i += 1) {
      archiveVariant({ dir, id: `chg_20261104_${String(i).padStart(2, '0')}`, patch: '--- a\n+++ b\n', diff: { i }, metrics: { z: i }, keep: 10 })
    }
    const all = fs.readdirSync(path.join(dir, 'variants')).sort()
    assert.equal(all.length, 10, '只保留最近 10 个')
    assert.equal(all[0], 'chg_20261104_02', '最旧的两个被清掉')
    const one = path.join(dir, 'variants', 'chg_20261104_11')
    assert.equal(fs.existsSync(path.join(one, 'patch.diff')), true)
    assert.equal(fs.existsSync(path.join(one, 'diff.json')), true)
    assert.equal(fs.existsSync(path.join(one, 'metrics.json')), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
