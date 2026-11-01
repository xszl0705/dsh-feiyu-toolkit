import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-group-context-test-'))
process.env.DSH_HOME = tmp
const { appendGroupMessage, recentGroupMessages, groupContextVersion } = await import(`../lib/group-context.js?test=${Date.now()}`)

test('group context keeps order and version', () => {
  const base = { kind: 'group', groupId: 'g1', senderName: '甲', userId: '1' }
  appendGroupMessage({ ...base, messageId: 'm1', text: '第一句' })
  appendGroupMessage({ ...base, messageId: 'm2', text: '第二句', images: [{ url: 'x' }] })
  appendGroupMessage({ ...base, messageId: 'm2', text: '第二句' })
  assert.equal(groupContextVersion('g1'), 2)
  const rows = recentGroupMessages('g1')
  assert.deepEqual(rows.map((r) => r.text), ['第一句', '第二句'])
  assert.equal(rows[1].images, 1)
  assert.equal(recentGroupMessages('g1', { excludeId: 'm2' }).length, 1)
})

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
