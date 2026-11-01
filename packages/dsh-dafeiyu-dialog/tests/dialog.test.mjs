/** 对话总线：node tests/dialog.test.mjs */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-dialog')
fs.rmSync(FIX, { recursive: true, force: true })
fs.mkdirSync(FIX, { recursive: true })
process.env.DSH_HOME = FIX

const mod = await import('../index.js?test=' + Date.now())

const routes = []
let sessionHandler = null
const ctx = {
  provide() {},
  set() {},
  on(type, fn) {
    if (type === 'session/event') sessionHandler = fn
  },
  effect(fn) {
    fn()
  },
  get(name) {
    if (name === 'webServer') return { register: (route) => routes.push(route) }
    return undefined
  },
}
mod.apply(ctx)

const KEY = Symbol.for('dsh-dafeiyu-dialog.service')
const service = globalThis[KEY]
assert.ok(service && typeof service.recent === 'function', '应安装对话服务')

service.append({ channel: 'client', conversation: 'owner', role: 'user', text: '客户端问' })
service.append({ channel: 'qq', conversation: 'owner', role: 'assistant', text: 'QQ 答' })
service.append({ channel: 'qq', conversation: 'group:1', role: 'user', text: '群里说' })
service.append({ channel: 'qq', conversation: 'private:9', role: 'user', text: '陌生人说' })

const owner = service.recent({ conversation: 'owner', limit: 10 })
assert.equal(owner.length, 2)
assert.deepEqual(owner.map((row) => row.channel), ['client', 'qq'])
assert.equal(service.recentOwner(6).length, 2)

const group = service.recent({ conversation: 'group:1', limit: 10 })
assert.equal(group.length, 1)
assert.equal(group[0].text, '群里说')

const stranger = service.recent({ conversation: 'owner', limit: 10 })
assert.ok(!stranger.some((row) => row.text === '陌生人说'), 'owner 不能读到陌生人的对话')

assert.equal(routes.length, 1, '应挂上 /dsh-dafeiyu-dialog/recent')

// 客户端事件：user/message 的正文在 data.content，assistant 在 data.message.content
assert.ok(sessionHandler, '应挂上 session/event')
sessionHandler(
  { id: 's1' },
  { type: 'user/message', data: { content: [{ type: 'text', text: '客户端提问' }] } },
)
sessionHandler(
  { id: 's1' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '客户端回答' }] } } },
)
const captured = service.recent({ conversation: 'owner', limit: 10 })
assert.ok(captured.some((row) => row.role === 'user' && row.text === '客户端提问'), '应抓到用户消息')
assert.ok(captured.some((row) => row.role === 'assistant' && row.text === '客户端回答'), '应抓到助手消息')

sessionHandler(
  { id: 's1' },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. 内部注入' }] } },
)
assert.ok(
  !service.recent({ conversation: 'owner', limit: 10 }).some((row) => row.text.includes('Current runtime context')),
  '运行时上下文注入不应进对话总线',
)
console.log('✓ 客户端事件：user/message 与 assistant/message 都入库，运行时注入被过滤')
console.log('✓ 对话总线：跨渠道写入、按会话隔离、owner 不串陌生人')
console.log('\n全部通过')
