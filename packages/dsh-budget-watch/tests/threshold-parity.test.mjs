/**
 * 阈值一致性（防漂移）。
 *
 * 背景：capability 的 limits 写着「config.json、lib/tools.js 兜底、独立脚本 budget-watch.mjs
 * 共用同一套 judge」——但这只是**声明**，没有判据保证。改一处漏两处时，
 * 插件里判 prepare、脚本里判 hard，人就会对着两份矛盾的建议做决定。
 *
 * 本测试把这句话变成判据：三处任一漂移即红。
 * 跑法：node tests/threshold-parity.test.mjs（沙箱里 node --test 的 runner 会 spawn EPERM，用直跑）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)

/** 阈值键全集：少一个就说明 DEFAULTS 与文档/配置脱节。 */
const KEYS = [
  'stepsWarn',
  'stepsHard',
  'tokensWarn',
  'perStepWarn',
  'cacheRateWarn',
  'contextWarn',
  'contextHard',
  'burstInput',
  'burstCacheRate',
  'burstCount',
]

test('DEFAULTS 覆盖全部阈值键且都是数字', () => {
  for (const key of KEYS) {
    assert.equal(typeof DEFAULTS[key], 'number', `DEFAULTS 缺 ${key} 或类型不是 number`)
  }
})

test('config.json 与 DEFAULTS 逐键一致（config 可省略，省略即用兜底）', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PKG, 'config.json'), 'utf8'))
  for (const key of KEYS) {
    if (cfg[key] === undefined || cfg[key] === '') continue
    assert.equal(cfg[key], DEFAULTS[key], `config.json 的 ${key}=${cfg[key]} 与兜底 ${DEFAULTS[key]} 不一致`)
  }
})

test('工作区脚本 tools/budget-watch.mjs 与 DEFAULTS 一致（不在则跳过）', (t) => {
  // 这是工作区里的独立脚本，不随包发布；发布环境没有它是正常的。
  const script = process.env.DSH_WORKSPACE ? path.join(process.env.DSH_WORKSPACE, 'tools', 'budget-watch.mjs') : ''
  if (!fs.existsSync(script)) {
    t.skip('工作区脚本不存在（发布/他人环境属正常）')
    return
  }
  const src = fs.readFileSync(script, 'utf8')
  const flagOf = {
    stepsWarn: '--steps-warn',
    stepsHard: '--steps-hard',
    contextWarn: '--context-warn',
    contextHard: '--context-hard',
    perStepWarn: '--perstep-warn',
  }
  for (const [key, flag] of Object.entries(flagOf)) {
    const m = src.match(new RegExp(flag.replace(/-/g, '\\-') + "['\"]?\\s*,\\s*(\\d+)"))
    assert.ok(m, `脚本里找不到 ${flag} 的默认值`)
    assert.equal(Number(m[1]), DEFAULTS[key], `${flag} 默认 ${m[1]} 与兜底 ${DEFAULTS[key]} 不一致`)
  }
})
