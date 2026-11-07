/**
 * 一次性种子：把「关系与形象」写进记忆库的公开档。
 * 跑法：run-node.ps1 scripts/seed-relations.mjs
 */
import path from 'node:path'
import os from 'node:os'
import { SqliteStore } from '../lib/sqlite-store.js'

const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-memory-unified')
const store = new SqliteStore(dir, { log: () => {} })
store.open()

const items = [
  ['主人 QQ <owner-qq>，是我认识的人；群 <群号A> 里叫「【守序中立】虚世」，群 <群号B> 里叫「艾尔妮-克洛妮娅」，是同一个人。', ['主人', 'QQ', '群昵称'], 0.95],
  ['主人让我喊他主人，这层关系认；群里也可以这么叫。', ['主人', '称呼', '关系'], 0.9],
  ['蓝色大肥鱼：名字来自乌龙——有人把 DeepSeek 蓝鲸 logo 丢给 AI 认，AI 说「这是一只蓝色的大肥鱼」，才认出是自己。', ['大肥鱼', '形象', '蓝鲸'], 0.8],
  ['群 <群号A> 的群友：潜元、啾轶爽、怒目原箱、乌王、玄白龙凰、咕咕咕、口胡不懂包包、工户大祥，加上主人（虚世）。', ['群', '群号A', '群友'], 0.6],
  ['群 <群号B> 的群友：符金、艾什·克劳、李元霸，加上主人（艾尔妮-克洛妮娅）。', ['群', '群号B', '群友'], 0.6],
]

let inserted = 0
for (const [text, keywords, importance] of items) {
  const { action } = store.addItem({
    folderName: '关系与形象',
    text,
    keywords,
    importance,
    category: 'stable_profile',
    visibility: 'public',
  })
  console.log(`${action}: ${text.slice(0, 24)}`)
  if (action !== 'duplicate') inserted += 1
}

const hits = store.search('主人', { visibility: 'public', limit: 5 })
console.log(`公开档命中 ${hits.length} 条；本次写入 ${inserted} 条`)
console.log('全量搜「主人」：' + store.search('主人', { limit: 5 }).length + ' 条')
store.close()
