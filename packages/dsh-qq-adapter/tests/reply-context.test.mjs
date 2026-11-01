import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReplyPrompt } from '../lib/reply.js'

test('reply prompt includes group context, knowledge and external-only rule', () => {
  const prompt = buildReplyPrompt({
    identity: '你是大肥鱼',
    event: { kind: 'group', senderName: '甲', text: '@鱼 在吗' },
    groupRecent: [{ speaker: '乙', text: '昨晚在打巨兽蔓生' }],
    knowledge: [{ text: '巨兽蔓生：平时带种子，需要时种下扩散' }],
  })
  assert.match(prompt, /最近群聊/)
  assert.match(prompt, /巨兽蔓生/)
  assert.match(prompt, /群知识库/)
  assert.match(prompt, /不要提.*心跳/)
})
