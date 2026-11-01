/**
 * 合并重复记忆（同主题 + 文本完全相同）：保留最早一条，其余标 superseded。
 *
 *   node scripts/consolidate.mjs [--dir <记忆库目录>] [--dry-run]
 */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createSqliteStore, sqliteReady } = await import(
  `file://${path.join(ROOT, 'lib', 'sqlite-store.js').replace(/\\/g, '/')}`
)

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dir = arg('dir', path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-memory-unified'))
const dryRun = process.argv.includes('--dry-run')

if (!sqliteReady()) {
  console.error('当前 Node 没有 node:sqlite')
  process.exit(2)
}

const store = createSqliteStore(dir)
const before = store.stats()
const ratio = Number(arg('ratio', '0.75'))
const result = store.consolidateDuplicates({ dryRun, ratio })
const after = dryRun ? before : store.stats()

console.log(`记忆库：${dir}（相似度阈值 ${ratio}）`)
console.log(`重复组：${result.duplicates}${dryRun ? '（dry-run，未修改）' : ' 已合并（旧条标 superseded）'}`)
for (const merge of result.merges.slice(0, 10)) {
  console.log(`  保留 ${merge.keep} ← 失效 ${merge.drop}`)
}
console.log(`库统计：${JSON.stringify(after)}`)
store.close()
