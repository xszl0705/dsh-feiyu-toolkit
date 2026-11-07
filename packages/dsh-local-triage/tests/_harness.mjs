/**
 * 极简测试脚手架。
 * Electron 当 node 用时 stdout 会丢，所以结果一律落文件，靠退出码判定。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function createHarness(name) {
  const results = []
  let failed = 0

  function check(label, fn) {
    try {
      fn()
      results.push({ label, ok: true })
    } catch (error) {
      failed += 1
      results.push({ label, ok: false, error: String(error?.message || error) })
    }
  }

  function finish() {
    const report = { name, at: new Date().toISOString(), total: results.length, failed, results }
    try {
      const dir = path.join(HERE, '..', 'reports')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2), 'utf8')
    } catch {
      // 报告写不了也照常退出
    }
    process.exit(failed ? 1 : 0)
  }

  return { check, finish, results }
}
