/**
 * 截图插件工具注册重试自测：node tests/retry.mjs
 * 模拟宿主 tools 服务晚 500ms 才就绪。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const KEY = Symbol.for('dsh-screenshot.state')
const mod = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
// Per-context state lives in the lifecycle WeakMap; the same ctx yields the same instance.
const { lifecycle } = await import('dsh-plugin-kit/lifecycle')

// ---- 1. tools 晚到：应该自动重试并最终注册 ----
{
  delete globalThis[KEY]
  const registered = []
  let gets = 0
  const tools = {
    register(definition) {
      registered.push(definition.name)
      return { dispose() {} }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name !== 'tools') return undefined
      gets += 1
      return gets >= 3 ? tools : undefined
    },
    effect(fn) {
      fn()
    },
  }
  mod.apply(ctx)
  assert.equal(registered.length, 0, '首次没有 tools 不应注册')
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.deepEqual(registered, ['screenshot'], '重试后应注册一个工具')
  assert.ok(gets >= 3, `应至少查询 3 次 tools，实际 ${gets}`)

  // ---- 2. 重复 apply 不应重复注册 ----
  mod.apply(ctx)
  assert.equal(registered.length, 1, '已注册后再次 apply 不应重复')
  console.log('✓ tools 晚就绪会重试，且不重复注册')
}

// ---- 3. 一直等不到 tools：120 秒后放弃，不再定时器空转 ----
{
  delete globalThis[KEY]
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    effect: (fn) => fn(),
  }
  mod.apply(ctx)
  const state = lifecycle(ctx)
  assert.ok(state && state._toolsWaiting, '应进入等待状态')
  state._toolsSince = Date.now() - 121000 // 假装已经等了 121 秒
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(registered.length, 0)
  assert.equal(lifecycle(ctx)._toolsWaiting, false, '超时后应停止重试')
  console.log('✓ 120 秒超时后停止重试')
}

console.log('\n全部通过')
