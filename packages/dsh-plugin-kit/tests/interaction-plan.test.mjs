import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITIES, detectActivity, planInteraction } from '../lib/interaction-plan.js'

test('detectActivity 四类基本样本', () => {
  assert.equal(detectActivity('帮我整理成报告'), 'work')
  assert.equal(detectActivity('为什么这个报错'), 'explain')
  assert.equal(detectActivity('今天累死了'), 'support')
  assert.equal(detectActivity('在吗'), 'chat')
  assert.equal(detectActivity(''), 'chat')
})

test('planInteraction 闲聊短、工作足、解释足', () => {
  assert.equal(planInteraction({ activity: 'chat' }).length, 'brief')
  assert.equal(planInteraction({ activity: 'work' }).length, 'sufficient')
  assert.equal(planInteraction({ activity: 'explain' }).length, 'sufficient')
  assert.equal(planInteraction({ activity: 'support' }).length, 'brief')
})

test('用户显式要求覆盖默认长度', () => {
  assert.equal(planInteraction({ activity: 'work', userPreference: '简短说' }).length, 'brief')
  assert.equal(planInteraction({ activity: 'chat', userPreference: '详细点，列依据' }).length, 'detailed')
})

test('群聊不固定称主人，owner 用你', () => {
  assert.equal(planInteraction({ audience: 'group' }).addressForm, '您')
  assert.equal(planInteraction({ audience: 'owner' }).addressForm, '你')
})

test('preserve 包含六类保真对象', () => {
  const plan = planInteraction({ activity: 'work' })
  assert.deepEqual(plan.preserve, ['code', 'quotes', 'links', 'paths', 'tables', 'numbers'])
  assert.ok(ACTIVITIES.includes(plan.activity))
})

test('任务状态存在时不再追问', () => {
  assert.equal(planInteraction({ activity: 'work', taskState: { id: 't1' } }).questionNeeded, false)
  assert.equal(planInteraction({ activity: 'work' }).questionNeeded, true)
})
