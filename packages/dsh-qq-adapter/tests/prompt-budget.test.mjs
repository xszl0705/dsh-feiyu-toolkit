import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReplyPrompt, planReplyPrompt } from '../lib/reply.js'

const identity = '你是大肥鱼，说话短。'
const event = { kind: 'group', senderName: '阿明', text: '今天吃啥', images: [] }

function bulky() {
  return {
    identity,
    event,
    history: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '历史'.repeat(20) })),
    memory: Array.from({ length: 5 }, () => ({ text: '记忆内容'.repeat(10) })),
    recent: Array.from({ length: 4 }, () => ({ role: 'user', text: '最近对话'.repeat(10) })),
    groupRecent: Array.from({ length: 20 }, (_, i) => ({ speaker: `群友${i}`, text: '群聊内容'.repeat(12) })),
    knowledge: [{ text: '知识条目'.repeat(12) }, { text: '知识二'.repeat(12) }],
  }
}

test('不超预算时不裁剪，人格和当前消息都在', () => {
  const planned = planReplyPrompt({ ...bulky(), budgetChars: 100_000 })
  assert.equal(planned.stats.dropped.length, 0)
  assert.equal(planned.stats.overBudget, false)
  assert.ok(planned.prompt.includes('你是大肥鱼'))
  assert.ok(planned.prompt.includes('今天吃啥'))
})

test('超预算时按「群聊 → 知识库 → 跨渠道 → 历史 → 记忆」的顺序让位', () => {
  const planned = planReplyPrompt({ ...bulky(), budgetChars: 400 })
  assert.ok(planned.stats.dropped.length > 0)
  assert.equal(planned.stats.dropped[0], 'group')
  // 人格和当前这一句永远不裁
  assert.ok(planned.prompt.includes('你是大肥鱼'))
  assert.ok(planned.prompt.includes('今天吃啥'))
})

test('裁到极限也不会把人设或当前消息裁掉', () => {
  const planned = planReplyPrompt({ ...bulky(), budgetChars: 10 })
  assert.ok(planned.prompt.includes('你是大肥鱼'))
  assert.ok(planned.prompt.includes('今天吃啥'))
  assert.equal(planned.stats.overBudget, true)
})

test('budgetChars=0 表示不限制', () => {
  const planned = planReplyPrompt({ ...bulky(), budgetChars: 0 })
  assert.equal(planned.stats.budget, 0)
  assert.equal(planned.stats.dropped.length, 0)
})

test('buildReplyPrompt 仍然返回字符串，兼容旧调用', () => {
  const prompt = buildReplyPrompt({ identity, event })
  assert.equal(typeof prompt, 'string')
  assert.ok(prompt.includes('今天吃啥'))
  assert.ok(prompt.includes('用你自己的话回一句'))
})

test('群聊和私聊的说话对象不同', () => {
  const group = planReplyPrompt({ identity, event }).prompt
  const priv = planReplyPrompt({ identity, event: { kind: 'private', senderName: '阿明', text: '在吗' } }).prompt
  assert.ok(group.includes('QQ 群里 阿明 @ 你说'))
  assert.ok(priv.includes('阿明 私聊你说'))
})

test('传入 contextPlan 时按六组件预算做块级截断，并记录在 componentTrimmed', () => {
  const plan = {
    total: 6000,
    blocks: { instr: 300, know: 120, tools: 100, mem: 200, state: 120, query: 500 },
  }
  const planned = planReplyPrompt({ ...bulky(), contextPlan: plan, budgetChars: 6000 })
  assert.ok(planned.stats.componentTrimmed.length > 0, JSON.stringify(planned.stats))
  assert.ok(planned.stats.componentTrimmed.some((item) => item.startsWith('state:')), JSON.stringify(planned.stats.componentTrimmed))
  assert.ok(planned.stats.componentTrimmed.some((item) => item.startsWith('mem:')), JSON.stringify(planned.stats.componentTrimmed))
  // 人设和当前这一句仍然在
  assert.ok(planned.prompt.includes('你是大肥鱼'))
  assert.ok(planned.prompt.includes('今天吃啥'))
})

test('不传 contextPlan 时行为不变，componentTrimmed 为空', () => {
  const planned = planReplyPrompt({ ...bulky(), budgetChars: 100_000 })
  assert.deepEqual(planned.stats.componentTrimmed, [])
  assert.equal(planned.stats.dropped.length, 0)
})
