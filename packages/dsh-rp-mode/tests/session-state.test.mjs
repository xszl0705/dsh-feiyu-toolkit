/**
 * 会话维度卡状态的单测（2026-11-10）。
 *
 * 背景：提示词以前读全局 `current.json` 判「本会话有没有卡」，新建会话会继承
 * 上一局的卡 → 提示词说「本会话角色已定」→ 模型不挑卡、切卡也不生效。
 * 现在判定走 `resolveCardsFor(root, sessionId)`：有锁=有卡，无锁=没卡。
 *
 * 跑法：node tests/session-state.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MAX_CARDS, addCard, agentSessionId, clearLock, getLock, resolveCardsFor, setScenario } from '../lib/session.js'
import { cardsSummary, currentSummary, renderCardMemory, scenarioForSession, writeCurrent } from '../lib/card.js'

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fails.push(name + (extra ? ' :: ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-state-'))
try {
  // 1. agent 会话 id 的三条取值链
  ok('session.id', agentSessionId({ session: { id: 'SID-A' } }) === 'SID-A')
  ok('session.sessionId', agentSessionId({ session: { sessionId: 'SID-B' } }) === 'SID-B')
  ok('agent.id 兜底', agentSessionId({ id: 'SID-C' }) === 'SID-C')
  ok('拿不到就空串', agentSessionId({}) === '')

  // 2. 无锁 = 没卡（新会话不得继承任何全局状态）
  ok('新会话没有卡', resolveCardsFor(root, 'SID-NEW') === null)

  // 3. 锁了才有卡
  addCard(root, 'SID-NEW', { file: 'E:\\cards\\a.png', name: '甲' })
  const cards = resolveCardsFor(root, 'SID-NEW')
  ok('锁定后按会话读得到', Array.isArray(cards) && cards.length === 1, JSON.stringify(cards))
  ok('卡名正确', cards && cards[0] && cards[0].name === '甲')

  // 4. 另一个会话不受影响（关键：不串会话）
  ok('另一个会话仍是没卡', resolveCardsFor(root, 'SID-OTHER') === null)

  // 5. 卡组上限仍是 4
  for (let i = 0; i < MAX_CARDS + 2; i++) addCard(root, 'SID-NEW', { file: 'E:\\cards\\x' + i + '.png', name: '补充' + i })
  const grown = resolveCardsFor(root, 'SID-NEW')
  ok('卡组不超过上限', grown.length === MAX_CARDS, String(grown.length))

  // 6. 移除锁后回到「没卡」
  clearLock(root, 'SID-NEW')
  ok('清锁后回到没卡', resolveCardsFor(root, 'SID-NEW') === null)

  // 7. 摘要文案
  ok('空卡组没有摘要', cardsSummary([], '') === '')
  ok('单卡摘要', cardsSummary([{ name: '甲' }], '') === '当前角色：甲')
  const duo = cardsSummary([{ name: '甲' }, { name: '乙' }], '雨夜')
  ok('群聊摘要带人数', duo.startsWith('本局角色（群聊 2 位）：甲、乙'), duo)
  ok('摘要带背景', duo.includes('背景：雨夜'), duo)

  // 8. 全局 current.json 的旧格式仍可用（面板/工具回显靠它）
  const curFile = path.join(root, 'current.json')
  writeCurrent({ character: '甲', cards: [{ name: '甲', file: 'E:\\cards\\a.png' }], scenario: '雨夜', source: '自建' }, curFile)
  const line = currentSummary(curFile)
  ok('全局摘要含角色', line.includes('当前角色：甲'), line)
  ok('全局摘要含卡源', line.includes('卡源 自建'), line)

  // 9. ★2026-11-10 记忆串卡回归：背景按会话隔离
  addCard(root, 'SID-P', { file: 'E:\\cards\\a.png', name: '甲' })
  addCard(root, 'SID-Q', { file: 'E:\\cards\\b.png', name: '乙' })
  ok('会话级背景写入成功', setScenario(root, 'SID-P', '甲的夜都市') === true)
  const lockP = getLock(root, 'SID-P')
  const lockQ = getLock(root, 'SID-Q')
  const cardsP = resolveCardsFor(root, 'SID-P')
  const cardsQ = resolveCardsFor(root, 'SID-Q')
  ok('P 会话读到自己的背景', scenarioForSession(lockP, cardsP, null) === '甲的夜都市')
  ok('Q 会话不被 P 的背景污染', scenarioForSession(lockQ, cardsQ, null) === '')

  // 10. 老会话回退全局时必须与本会话卡组同源，否则宁可不带（就是这次「记忆混乱」的形态）
  const mixed = { character: '甲', file: 'E:\\cards\\b.png', scenario: '甲的夜都市' }
  ok('全局 file 不属于本会话 → 不带背景', scenarioForSession(lockQ, cardsQ, mixed) === '')
  ok('全局 character 不属于本会话 → 不带背景', scenarioForSession(lockQ, cardsQ, { ...mixed, file: 'E:\\cards\\b.png', character: '甲' }) === '')
  const same = { character: '乙', file: 'E:\\cards\\b.png', scenario: '乙的旧背景' }
  ok('全局与本会话同源 → 可以回退带上', scenarioForSession(lockQ, cardsQ, same) === '乙的旧背景')
  // 会话级背景优先于全局
  ok('会话级背景优先', scenarioForSession(lockP, cardsP, same) === '甲的夜都市')
  // normalizeLock 不能丢背景（addCard 重建锁对象时最容易漏）
  addCard(root, 'SID-P', { file: 'E:\\cards\\c.png', name: '丙' })
  // 往卡组再加一张后背景仍在
  ok('往卡组再加一张后背景仍在', getLock(root, 'SID-P').scenario === '甲的夜都市', JSON.stringify(getLock(root, 'SID-P')))

  // 11. ★2026-11-10 pick 报「body 不能为空」的根因回归：
  //     有些卡只有 first_mes，没有 description/personality/scenario，renderCardMemory 以前返回空串，
  //     pick 走到 saveEntry 就抛错，整次调用失败 → 模型反复重试同一个 pick。
  const onlyOpening = renderCardMemory({ name: '丙', firstMes: '雨夜，她抬起头，伞沿滴着水。' })
  ok('只有 first_mes 的卡也能生成记忆正文', onlyOpening.includes('雨夜'), onlyOpening.slice(0, 40))
  const bare = renderCardMemory({ name: '丁' })
  ok('字段全空的卡也不返回空串（否则 pick 会被 body 不能为空 拦死）', bare.trim().length > 0, JSON.stringify(bare))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

console.log('\n' + pass + ' 通过 / ' + fails.length + ' 失败')
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log('RESULT: PASS ' + pass + '/' + pass)
