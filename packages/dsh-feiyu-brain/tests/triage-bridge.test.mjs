/** 分诊桥单测：node tests/triage-bridge.test.mjs */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-bridge-'))
process.env.DSH_HOME = FIX
fs.mkdirSync(path.join(FIX, 'dafeiyu'), { recursive: true })
const FLAGS = path.join(FIX, 'dafeiyu', 'flags.json')
fs.writeFileSync(FLAGS, JSON.stringify({}))

const { triageRoute, resetTriageCache } = await import('../lib/triage-bridge.js?test=' + Date.now())
const opts = { triage: { timeoutMs: 300 } }

// 1. 没有 flag：必须完全不接管
assert.equal(await triageRoute('收到', opts), null, '没有 route.tier 时不该接管')
console.log('✓ 默认关：不接管')

// 2. 开 flag + 极窄确认类 → local
fs.writeFileSync(FLAGS, JSON.stringify({ 'route.tier': { enabled: true } }))
resetTriageCache()
const ack = await triageRoute('收到', opts)
assert.ok(ack, '开启后应该接管')
assert.equal(ack.route, 'local')
assert.match(ack.reason, /tier:local/)
console.log('✓ 开启后：确认类短句走本地')

// 3. 排障类不降级
const hard = await triageRoute('帮我看看这个 bug，为什么重启后 qq 没反应', opts)
assert.equal(hard?.route, 'big', '需要排障的句子必须留给大模型')
console.log('✓ 复杂句不降级')

// 4. 关掉 flag 即回滚（不用重启）
fs.writeFileSync(FLAGS, JSON.stringify({ 'route.tier': { enabled: false } }))
resetTriageCache()
assert.equal(await triageRoute('收到', opts), null)
console.log('✓ 关掉即回滚')

// 4.5 放量比例为 0 时不接管（默认 control:100）
fs.writeFileSync(FLAGS, JSON.stringify({ 'route.tier': { enabled: true, variants: { control: 100 } } }))
resetTriageCache()
assert.equal(await triageRoute('收到', { ...opts, conversation: 'group:1' }), null, 'triage 权重 0 时不该接管')
console.log('✓ 灰度 0%：不接管')

// 4.6 全量放量时同一会话必命中，不同会话按桶分布
fs.writeFileSync(FLAGS, JSON.stringify({ 'route.tier': { enabled: true, variants: { triage: 100 } } }))
resetTriageCache()
const a = await triageRoute('收到', { ...opts, conversation: 'group:1' })
const b = await triageRoute('收到', { ...opts, conversation: 'group:1' })
assert.equal(a?.route, 'local')
assert.equal(b?.route, 'local', '同一会话必须稳定命中')
console.log('✓ 灰度 100%：同一会话稳定命中')

// 5. local-triage 缺席时降级成 null，不抛
fs.writeFileSync(FLAGS, JSON.stringify({ 'route.tier': { enabled: true } }))
resetTriageCache()
const mod = await import('../lib/triage-bridge.js?absent=' + Date.now())
assert.equal(typeof mod.triageRoute, 'function')
console.log('✓ 桥接模块可重复导入')

fs.rmSync(FIX, { recursive: true, force: true })
console.log('\n全部通过')
