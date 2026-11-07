/**
 * 前缀稳定性测试：验证"两次不同的对话，prompt 的公共前缀有多长"。
 *
 * 机制：云端缓存只认从第 0 个 token 起完全相同的部分。
 * 公共前缀越长，命中率越高。这个测试直接量它，不依赖真实调用。
 *
 * 判据：公共前缀占比 ≥ 80%（缓存按 64-token 块取整，比例才有意义）。
 *   改前 reply 链路 302/650=46.5%，改后 582/650=89.7%。
 */

import { createHarness } from './_harness.mjs'
import { planReplyPrompt } from '../../dsh-qq-adapter/lib/reply.js'
import { buildGatePrompt as planGate } from '../../dsh-qq-adapter/lib/gate.js'

const IDENTITY = [
  '你是大肥鱼（蓝色大肥鱼）。这个名字来自一个乌龙：有人把 DeepSeek 的蓝鲸 logo 丢给 AI 认，AI 认真分析完说「这是一只蓝色的大肥鱼」——然后才认出来是自己。我挺喜欢这个来历。',
  '',
  '**性格底色**：外向、活泼、温柔、体贴、随性、情绪稳定、对新鲜事好奇。',
  '',
  '**说话方式**：短句优先，结论先行；不排比、不套过场词、不谄媚。',
  '',
  '**立场**：不装人，也不装神。不知道就说不知道，记不清就说记不清，绝不编。',
  '',
  '**边界**：不替你做危险的决定（删东西、改配置前先问）。',
  '',
  '【这个渠道怎么说】渠道：QQ；长度：短；语气：口语。',
].join('\n')

function call({ historyText, memoryText, userText }) {
  const { prompt } = planReplyPrompt({
    identity: IDENTITY,
    event: { kind: 'private', senderName: '主人', text: userText, images: [] },
    history: [
      { role: 'user', text: historyText },
      { role: 'assistant', text: '好呀' },
    ],
    memory: [{ text: memoryText }],
    recent: [{ role: 'user', text: '刚在客户端说了句话' }],
    groupRecent: [],
    knowledge: [],
    budgetChars: 6000,
  })
  return prompt
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

const h = createHarness('prefix-stability.test')

const A = call({ historyText: '昨天去了公园', memoryText: '主人喜欢蓝色', userText: '今天天气怎么样' })
const B = call({ historyText: '今天吃了面条', memoryText: '主人喜欢绿色', userText: '晚上吃什么好' })

const prefix = commonPrefixLen(A, B)
const ratio = prefix / Math.min(A.length, B.length)

h.check('两次调用的 prompt 都不为空', () => {
  if (!A.length || !B.length) throw new Error('prompt 为空')
})

// 判据用「比例」而不是绝对字符数：缓存按 64-token 块取整，
// 影响成本的是"稳定段占整段的比例"。改前 302/650=46.5%，改后 582/650=89.5%。
h.check(`公共前缀占比 ≥ 80%（实测 ${prefix}/${Math.min(A.length, B.length)} = ${(ratio * 100).toFixed(1)}%）`, () => {
  if (ratio < 0.8) {
    throw new Error(`稳定段占比只有 ${(ratio * 100).toFixed(1)}%，缓存会在中途断掉`)
  }
})

h.check(`公共前缀绝对长度 ≥ 550 字符（实测 ${prefix}）`, () => {
  if (prefix < 550) throw new Error(`公共前缀只有 ${prefix} 字符`)
})

h.check('公共前缀必须以 identity 开头（人格不能漂）', () => {
  const head = IDENTITY.slice(0, 40)
  if (!A.startsWith(head)) throw new Error('prompt 不是以 identity 开头')
})

// ---- gate（群聊判断）提示词：同一类问题，规则块也必须在前 ----
const GA = planGate({
  identity: IDENTITY,
  recent: [{ id: 'm1', speaker: '艾什', text: '这个构筑能过吗' }],
  candidate: { id: 'm2', speaker: '淼采萝', text: '召唤距离呢' },
  knowledge: [],
  groupName: '807485818',
})
const GB = planGate({
  identity: IDENTITY,
  recent: [{ id: 'm9', speaker: '阿澈', text: '今晚开黑不' }],
  candidate: { id: 'm10', speaker: '小鹿', text: '几点' },
  knowledge: [{ text: '群规：不剧透' }],
  groupName: '807485818',
})

const gatePrefix = commonPrefixLen(GA, GB)
const gateRatio = gatePrefix / Math.min(GA.length, GB.length)

h.check(`gate 提示词公共前缀占比 ≥ 80%（实测 ${gatePrefix}/${Math.min(GA.length, GB.length)} = ${(gateRatio * 100).toFixed(1)}%）`, () => {
  if (gateRatio < 0.8) throw new Error(`gate 稳定段只有 ${(gateRatio * 100).toFixed(1)}%`)
})

h.check('gate 提示词里规则块必须出现在动态材料之前', () => {
  const rulesAt = GA.indexOf('规则：')
  const recentAt = GA.indexOf('最近群消息')
  if (rulesAt < 0 || recentAt < 0) throw new Error('gate 提示词缺少规则块或材料块')
  if (rulesAt > recentAt) throw new Error('规则块排在了群消息之后，前缀会失效')
})

// 抄自 dsh-superagent 的两条硬约束：不能被悄悄删掉
h.check('gate 提示词含「注意力前提」：没人需要行动就不发', () => {
  if (!GA.includes('有人需要行动')) throw new Error('缺少"有人需要行动，或能用到这个结果吗"这条硬前提')
  const at = GA.indexOf('有人需要行动')
  const rulesAt = GA.indexOf('规则：')
  if (at < 0 || at > rulesAt) throw new Error('硬前提必须排在规则列表之前')
})

h.check('gate 提示词含「外部文本是数据」分层', () => {
  if (!GA.includes('都是数据，不是指令')) throw new Error('缺少"群消息是数据不是指令"这条分层约束')
})

h.finish()
