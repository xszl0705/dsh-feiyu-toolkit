import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { SqliteStore } from '../lib/sqlite-store.js'
import { createMemoryTools } from '../lib/tools.js'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-boundary-'))
for (const Store of [MemoryStore, SqliteStore]) {
  const store = new Store(path.join(temp, Store.name)); store.open?.()
  const text = '我的 api key 是 sk-abcdef123456'
  assert.throws(() => store.addItem({folderName:'test',text}), /MEMORY_SENSITIVE/)
  const tools = createMemoryTools({store,config:{}})
  assert.equal((await tools.find(t=>t.name==='memory').execute({action:'remember',text})).ok, false)
  assert.ok(store.addItem({folderName:'test',text:'用户喜欢简洁清晰的回答'}).item.id)
  if (store.importFromFile) {
    const file = path.join(temp,'import.json')
    fs.writeFileSync(file, JSON.stringify({folders:[{name:'import',items:[{text,id:'synthetic-secret'}]}]}))
    assert.equal(store.importFromFile(file).imported,0)
  }
  store.close?.()
}
fs.rmSync(temp,{recursive:true,force:true})
console.log('write boundaries passed')
