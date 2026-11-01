import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-order-'))
process.env.DSH_HOME = temp
const { apply } = await import('../index.js')
apply({ get: () => ({ register() {} }) })
const service = globalThis[Symbol.for('dsh-dafeiyu-dialog.service')]
const now = new Date(), yesterday = new Date(now)
yesterday.setDate(yesterday.getDate() - 1)
service.append({ conversation: 'owner', text: 'new', at: now.toISOString() })
service.append({ conversation: 'owner', text: 'old', at: yesterday.toISOString() })
assert.equal(service.recent({ days: 2, limit: 1 })[0].text, 'new')
assert.deepEqual(service.recent({ days: 2, limit: 2 }).map(x => x.text), ['old', 'new'])
fs.rmSync(temp, {recursive:true,force:true})
console.log('date ordering passed')
