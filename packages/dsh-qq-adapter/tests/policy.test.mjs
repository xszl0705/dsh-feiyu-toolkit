/** QQ 回复路由 / 审批：node tests/policy.test.mjs */

import assert from 'node:assert/strict'
import { isComplex, buildReplyPrompt, generateReply, stripMeta } from '../lib/reply.js'
import { ApprovalStore } from '../lib/approval.js'
import { cleanReply } from '../lib/prompt.js'
import { memoryAllowed, memoryVisibility } from '../index.js'

// ---- 协议级隔离（2026-11-04 起）：没有明确 meta 标记时不删正文 ----
assert.equal(stripMeta('这部分记不全了，别让我瞎编。'), '这部分记不全了，别让我瞎编。')
assert.equal(stripMeta('我不能瞎编，具体是 5 分钟。'), '我不能瞎编，具体是 5 分钟。')
assert.equal(stripMeta('这部分记不清。'), '这部分记不清。')
// 明确的 meta 块（整行括号标记）才删
assert.equal(stripMeta('看到了。\n（自我提醒：别漏）'), '看到了。')
assert.equal(stripMeta('（自我提醒：别漏）'), '')
console.log('✓ meta 只按协议标记删，不按普通词删正文')

// ---- 记忆作用域 ----
assert.equal(memoryAllowed({ kind: 'private', userId: 'o' }, 'o'), true)
assert.equal(memoryAllowed({ kind: 'private', userId: 'x' }, 'o'), false)
assert.equal(memoryAllowed({ kind: 'group', groupId: 'g', userId: 'o' }, 'o'), false)
console.log('✓ 只有 owner 私聊能读私有记忆')

// 公开渠道（群聊/陌生人）走公开档：能认关系与形象，拿不到私密条目
assert.equal(memoryVisibility({ kind: 'group', groupId: 'g', userId: 'o' }, 'o'), 'public')
assert.equal(memoryVisibility({ kind: 'private', userId: 'x' }, 'o'), 'public')
assert.equal(memoryVisibility({ kind: 'private', userId: 'o' }, 'o'), '')
console.log('✓ 群聊与陌生人只检索公开档，owner 私聊才是全量')

const ownerPrompt = buildReplyPrompt({
  identity: '主体',
  event: { kind: 'private', userId: 'o', senderName: '你', text: '上次说的方案' },
  memory: [{ text: '方案定稿：服务化' }],
  memoryScope: 'owner',
  recent: [{ role: 'user', text: '客户端说过的话' }],
})
assert.match(ownerPrompt, /长期记忆/)
assert.match(ownerPrompt, /服务化/)
assert.match(ownerPrompt, /最近跨渠道对话/)
assert.match(ownerPrompt, /客户端说过的话/)
console.log('✓ owner 的 prompt 含记忆与跨渠道对话')

{
  const groupPrompt = buildReplyPrompt({
    identity: '主体',
    event: { kind: 'group', groupId: 'g', senderName: '群友', text: '你认识主人吗' },
    memory: [{ text: '主人在群里叫虚世' }],
    memoryScope: 'group',
  })
  assert.match(groupPrompt, /公开记忆/)
  assert.match(groupPrompt, /虚世/)
  assert.doesNotMatch(groupPrompt, /长期记忆（只有你知道）/)
  console.log('✓ 群聊 prompt 用公开记忆标签，不冒充「只有你知道」')
}

// ---- 复杂回复不再被 120 字截断 ----
{
  const long = '长'.repeat(400)
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: long }
      })()
    },
  }
  const result = await generateReply({
    identity: '主体',
    event: { kind: 'private', senderName: '你', text: '为什么天是蓝的，分析一下原理' },
    llm,
    local: undefined,
    maxTokens: 1000,
  })
  assert.ok(result.text.length > 120, '复杂回复不应再按 120 字截断')
  assert.equal(result.route, 'big')
  console.log('✓ 复杂回复放开到 1000 tokens，不截 120 字')
}

// ---- token 用量采集 ----
{
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '好的' }
        yield { type: 'usage', usage: { inputTokens: 111, outputTokens: 22, cacheReadTokens: 33, totalTokens: 166 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const result = await generateReply({
    identity: '主体',
    event: { kind: 'private', senderName: '你', text: '为什么天是蓝的，分析一下' },
    llm,
    local: undefined,
    maxTokens: 1000,
  })
  assert.equal(result.usage.promptTokens, 111)
  assert.equal(result.usage.outTokens, 22)
  assert.equal(result.usage.cacheReadTokens, 33)
  assert.equal(result.usage.totalTokens, 166)
  console.log('✓ token 用量从 usage chunk 采集')
}

// ---- 路由 ----
assert.equal(isComplex('在吗'), false)
assert.equal(isComplex('晚安'), false)
assert.equal(isComplex('为什么天是蓝的'), true)
assert.equal(isComplex('帮我写一段代码'), true)
assert.equal(isComplex('随便聊聊'.repeat(10)), true) // 超过 12 字
assert.equal(isComplex('第一行\n第二行'), true)
assert.equal(isComplex('p4失败几次'), true) // 含“几”
assert.equal(isComplex('现在回复策略是什么'), true) // 含“什么”
assert.equal(isComplex('你是本地模型还是dsh大模型'), true) // 超过 12 字
console.log('✓ 短消息走本地、长/复杂走大模型')

// ---- 清洗 ----
assert.equal(cleanReply('“你好”', 120), '你好')
assert.equal(cleanReply('字'.repeat(200), 120).length, 120)
assert.ok(cleanReply('字'.repeat(200), 120).endsWith('…'))
console.log('✓ 120 字截断')

// ---- 审批 ----
{
  const sent = []
  let now = 1000
  const store = new ApprovalStore({ now: () => now, ttlMs: 60_000, approvedMs: 10_000 })
  const send = async (payload) => {
    sent.push(payload)
    return { ok: true }
  }
  const asked = store.ask({ userId: 'u1', name: '小明', text: '在吗', ownerId: 'owner', send })
  assert.equal(asked.status, 'asked')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].targetId, 'owner')
  assert.match(sent[0].text, /小明/)
  assert.equal(store.isApproved('u1'), false)

  // 普通聊天词不会误触发
  assert.equal(store.resolve('今天天气不错'), null)
  assert.equal(store.isApproved('u1'), false)

  // 同意
  const ok = store.resolve('同意')
  assert.equal(ok.status, 'approved')
  assert.equal(store.isApproved('u1'), true)

  // 同意过的人后续消息直接放行
  assert.equal(store.ask({ userId: 'u1', name: '小明', text: '再聊一句', ownerId: 'owner', send }).status, 'approved')

  // 24 小时过期（测试配置成 10 秒）
  now += 11_000
  assert.equal(store.isApproved('u1'), false)

  // 拒绝
  now += 1
  store.ask({ userId: 'u2', name: '小红', text: '你好', ownerId: 'owner', send })
  const no = store.resolve('拒绝')
  assert.equal(no.status, 'denied')
  assert.equal(store.isApproved('u2'), false)
  console.log('✓ 陌生人先问主人，同意后才放行')
}

// ---- 待审批超时 ----
{
  let now = 1000
  const store = new ApprovalStore({ now: () => now, ttlMs: 5_000 })
  const send = async () => ({ ok: true })
  store.ask({ userId: 'u3', name: '路人', text: 'hi', ownerId: 'owner', send })
  now += 6_000
  assert.equal(store.pendingFor('u3'), null)
  assert.equal(store.resolve('同意').status, 'none')
  console.log('✓ 待审批 5 分钟后过期')
}

console.log('\n全部通过')
