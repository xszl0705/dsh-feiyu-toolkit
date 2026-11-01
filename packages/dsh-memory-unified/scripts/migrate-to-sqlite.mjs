/**
 * 把 v1 JSON 记忆库迁移到 SQLite（幂等：库里已有数据就跳过）。
 *
 *   node scripts/migrate-to-sqlite.mjs [--dir <记忆库目录>] [--dry-run]
 *
 * 默认目录：$DSH_HOME/dsh-memory-unified（未设 DSH_HOME 时用 ~/.dsh）。
 * JSON 原文件不会被删除，可随时回滚（config.store = "json"）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  console.error('当前 Node 没有 node:sqlite，无法迁移（可继续用 JSON 后端）')
  process.exit(2)
}
if (!fs.existsSync(dir)) {
  console.error(`记忆库目录不存在：${dir}`)
  process.exit(2)
}

const jsonIndex = path.join(dir, 'index.json')
const jsonCount = (() => {
  if (!fs.existsSync(jsonIndex)) return 0
  try {
    const index = JSON.parse(fs.readFileSync(jsonIndex, 'utf8'))
    let total = 0
    for (const entry of index.folders || []) {
      const file = path.join(dir, 'folders', `${entry.id}.json`)
      if (!fs.existsSync(file)) continue
      const folder = JSON.parse(fs.readFileSync(file, 'utf8'))
      total += (folder.items || []).filter((item) => !item.status || item.status === 'active').length
    }
    return total
  } catch {
    return 0
  }
})()

console.log(`记忆库：${dir}`)
console.log(`JSON 侧活跃条目：${jsonCount}`)
console.log(`SQLite 文件：${fs.existsSync(path.join(dir, 'memory.db')) ? '已存在' : '将新建'}`)

if (dryRun) {
  console.log('（dry-run：不做修改）')
  process.exit(0)
}

const store = createSqliteStore(dir)
const forceImport = process.argv.includes('--force-import')
const result = forceImport ? store.migrateFromJson({ force: true }) : store.migrateFromJsonIfEmpty()
const after = store.stats()
console.log(`迁移结果：${JSON.stringify(result)}${forceImport ? '（增量补齐）' : ''}`)
console.log(`库统计：${JSON.stringify(after)}`)
if (after.items > 0) {
  for (const query of ['重启之前要先做什么', '语音网关', '飞鱼 keeper']) {
    const hits = store.search(query, { limit: 2 })
    console.log(`  检索「${query}」→ ${hits.length ? hits.map((hit) => `[${hit.folder}] ${hit.text.slice(0, 18)}… (${hit.score})`).join(' | ') : '无命中（拒答）'}`)
  }
}
store.close()
