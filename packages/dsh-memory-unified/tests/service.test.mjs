/** 记忆服务注册：node tests/service.test.mjs */

import assert from 'node:assert/strict'
import { installMemoryService, getMemoryService, SERVICE_KEY } from '../lib/service.js'

const provided = {}
const ctx = {
  provide(name, api) {
    provided[name] = api
  },
  get(name) {
    return provided[name]
  },
}

const api = {
  source: 'test',
  search: async () => [{ text: '一条记忆' }],
  remember: async () => 'id',
}

installMemoryService(ctx, api)
assert.equal(provided.memory, api)
assert.equal(getMemoryService(ctx), api)
assert.equal(globalThis[SERVICE_KEY], api, '全局 symbol 也要能拿到')
console.log('✓ 记忆服务：ctx.provide + 全局 symbol 双通道')
console.log('\n全部通过')
