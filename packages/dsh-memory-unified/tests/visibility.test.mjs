import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { SqliteStore } from '../lib/sqlite-store.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-visibility-'))
for (const Store of [MemoryStore, SqliteStore]) {
  const store = new Store(path.join(temp, Store.name))
  store.open?.()
  store.addItem({ folderName: '关系', text: '主人在群里叫虚世', visibility: 'public' })
  store.addItem({ folderName: '关系', text: '主人今天有点累', visibility: 'private' })

  const all = store.search('主人')
  assert.equal(all.length, 2, `${Store.name}: 全量应命中两条`)
  const publicOnly = store.search('主人', { visibility: 'public' })
  assert.equal(publicOnly.length, 1, `${Store.name}: 公开档只该剩一条`)
  assert.match(publicOnly[0].text, /虚世/)
  const privateOnly = store.search('主人', { visibility: 'private' })
  assert.equal(privateOnly.length, 1, `${Store.name}: 私密档只该剩一条`)
  assert.match(privateOnly[0].text, /有点累/)

  // 重复写入升级可见性：同一条从私密改成公开，公开档应能搜到
  store.addItem({ folderName: '关系', text: '主人今天有点累', visibility: 'public' })
  assert.equal(store.search('主人', { visibility: 'public' }).length, 2, `${Store.name}: 重写应升级为公开`)
  store.close?.()
}
fs.rmSync(temp, { recursive: true, force: true })
console.log('visibility passed')
