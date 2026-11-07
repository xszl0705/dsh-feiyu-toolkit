/**
 * 统一入口：本机 stdout 会丢（Electron 以 node 模式跑时），所以结果同时写文件。
 * 跑法：ELECTRON_RUN_AS_NODE=1 "E:\dsh\DeepSeek Harness.exe" tests/run-all.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run as runQuote } from './quote.test.mjs'
import { run as runSrs } from './srs.test.mjs'
import { run as runStore } from './store.test.mjs'

const OUT = path.join(os.tmpdir(), 'finance-learn-test.json')

const suites = [
  ['quote', runQuote],
  ['srs', runSrs],
  ['store', runStore],
]

const results = []
for (const [name, fn] of suites) {
  try {
    const r = fn()
    results.push({ name, ok: r.ok, total: r.total, failed: r.failed, failedCases: (r.cases || []).filter((c) => !c.ok) })
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.stack) || error) })
  }
}

const allOk = results.every((r) => r.ok)
const report = { at: new Date().toISOString(), node: process.versions.node, allOk, suites: results }

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
} catch (error) {
  console.error('写结果文件失败：' + error.message)
}

console.log(JSON.stringify({ allOk, suites: results.map((r) => ({ name: r.name, ok: r.ok, failed: r.failed ?? null })) }))
process.exitCode = allOk ? 0 : 1
