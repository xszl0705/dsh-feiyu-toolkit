import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPublicAddress, publicTarget, publicDownload } from '../lib/public-download.js'
import { KnowledgeStore } from '../lib/knowledge.js'

test('knowledge is isolated by group even for identical content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-scope-'))
  const store = new KnowledgeStore(path.join(dir, 'knowledge.db'))
  try {
    store.add({ title: 'ALPHA_ONLY', groupId: 'A' })
    assert.equal(store.search('ALPHA_ONLY', { channel: 'qq-group', groupId: 'B' }).length, 0)
    assert.equal(store.search('ALPHA_ONLY', { channel: 'qq-group' }).length, 0)
    assert.equal(store.search('ALPHA_ONLY').length, 0)
    assert.equal(store.search('ALPHA_ONLY', { channel: 'qq-group', groupId: 'A' }).length, 1)
    assert.equal(store.add({ title: 'ALPHA_ONLY', groupId: 'B' }).inserted, true)
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('public download rejects non-public literals and mixed DNS answers', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip)
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700::1111'), true)
  await assert.rejects(publicTarget('http://2130706433/'), /NON_PUBLIC/)
  await assert.rejects(publicTarget('http://example.test/', async () => [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]), /NON_PUBLIC/)
})

test('redirect is checked again; response size and deadline are enforced', async () => {
  const resolve = async () => [{ address: '8.8.8.8', family: 4 }]
  let calls = 0
  await assert.rejects(publicDownload('https://example.test/', { resolve, transport: async (_url, options) => {
    calls += 1; assert.equal(options.address.address, '8.8.8.8')
    return { location: 'http://127.0.0.1/' }
  }}), /NON_PUBLIC/)
  assert.equal(calls, 1)
  await assert.rejects(publicDownload('https://example.test/', { resolve, maxBytes: 2, transport: async () => ({ bytes: Buffer.alloc(3) }) }), /TOO_LARGE/)
  await assert.rejects(publicDownload('https://example.test/', { timeoutMs: 5, resolve: () => new Promise(() => {}) }), /TIMEOUT/)
})
