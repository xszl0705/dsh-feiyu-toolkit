/**
 * 无宿主自测：心情数学 + 判断解析 + 轮次扫描 + 插件整链（mock ctx）
 * 运行：node _test/run.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-mood-test-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { readState, saveState, applyDelta, decay, normalize, moodFile, summary } = await import('../lib/mood.js')
const { parseReply, heuristicMood, appraisalToDelta } = await import('../lib/judge.js')
const { createTurnScanner } = await import('../lib/scanner.js')

// ---------- 1. 状态数学 ----------
{
  const state = normalize({ version: 2, moods: { __default__: { mood: 50, dims: { happy: 10 } } } })
  assert.equal(state.moods.__default__.mood, 50)
  assert.equal(state.moods.__default__.dims.sad, 0)

  applyDelta(state, { delta: 8, reason: '被夸了', dims: { happy: 80 }, at: 1000 })
  assert.equal(state.moods.__default__.mood, 58)
  assert.equal(state.moods.__default__.dims.happy, 80)
  assert.equal(state.moods.__default__.timeline.length, 1)

  applyDelta(state, { delta: 50, reason: '爆夸', at: 2000 })
  assert.equal(state.moods.__default__.mood, 70, '单次涨幅应被夹到 +12')

  // ---- 差异化衰减 ----
  const now = Date.now()
  const twoHoursAgo = now - 2 * 3600 * 1000

  const up = normalize({ version: 2, moods: { __default__: { mood: 80, dims: { happy: 80, sad: 80 }, lastDecayAt: twoHoursAgo } } })
  decay(up, { at: now, baseline: 60, rate: 0.12 })
  const upRoom = up.moods.__default__
  assert.ok(upRoom.mood > 74 && upRoom.mood < 76, `高于基线应回落（实际 ${upRoom.mood.toFixed(2)}）`)
  assert.ok(upRoom.dims.happy > 38 && upRoom.dims.happy < 42, `happy 2 小时约剩 40（实际 ${upRoom.dims.happy.toFixed(1)}）`)
  assert.ok(upRoom.dims.sad > 61 && upRoom.dims.sad < 65, `sad 2 小时约剩 63（实际 ${upRoom.dims.sad.toFixed(1)}）`)
  assert.ok(upRoom.dims.sad > upRoom.dims.happy, '负面维度应比正面留得久')

  const down = normalize({ version: 2, moods: { __default__: { mood: 40, lastDecayAt: twoHoursAgo } } })
  decay(down, { at: now, baseline: 60, rate: 0.12 })
  assert.ok(down.moods.__default__.mood > 42.5 && down.moods.__default__.mood < 43.7, '低于基线恢复更慢')

  const custom = normalize({ version: 2, moods: { __default__: { mood: 60, dims: { happy: 60 }, lastDecayAt: twoHoursAgo } } })
  decay(custom, { at: now, baseline: 60, rate: 0.12, dimRates: { happy: 0 } })
  assert.equal(custom.moods.__default__.dims.happy, 60, '配置成 0 的维度不衰减')

  const tiny = normalize({ version: 2, moods: { __default__: { mood: 60, dims: { happy: 0.3 }, lastDecayAt: twoHoursAgo } } })
  decay(tiny, { at: now, baseline: 60, rate: 0.12 })
  assert.equal(tiny.moods.__default__.dims.happy, 0, '小于 0.5 的残值直接归零')
  console.log('✓ 心情数学与差异化衰减')
}

// ---------- 2. 评价变量 → delta ----------
{
  // 被夸、且有点意外：0.6*10*0.94 = 5.64 → +6
  const positive = appraisalToDelta({ desirability: 0.6, expectancy: 0.2, agency: 'user', control: 0.8 })
  assert.equal(positive.delta, 6)
  assert.equal(positive.dims.happy, 48)
  assert.equal(positive.dims.sweet, 36)
  assert.equal(positive.appraisal.agency, 'user')

  // 坏消息、意料之中、控制不了：负面偏差 1.2 → -6
  const negative = appraisalToDelta({ desirability: -0.6, expectancy: 0.5, agency: 'world', control: 0.2 })
  assert.equal(negative.delta, -6)
  assert.equal(negative.dims.sad, 42)
  assert.equal(negative.dims.worry, 36)

  // 普通干活：明确允许不变
  const neutral = appraisalToDelta({ desirability: 0.1, expectancy: 0.8, agency: 'world', control: 0.5 })
  assert.equal(neutral.delta, 0)
  assert.deepEqual(neutral.dims, {})
  assert.equal(neutral.appraisal.desirability, 0.1, '不变时也要留评价快照')

  // 新格式解析（含 appraisal 包裹）
  const parsed = parseReply('```json\n{"appraisal":{"desirability":0.6,"expectancy":0.2,"agency":"user","control":0.8,"reason":"被夸了"}}\n```')
  assert.equal(parsed.delta, 6)
  assert.equal(parsed.source, 'appraisal')

  // 旧格式兼容
  const legacy = parseReply('{"delta": -5, "reason":"被嫌慢", "dims":{"sad":70}}')
  assert.equal(legacy.delta, -5)
  assert.equal(legacy.dims.sad, 70)
  assert.equal(parseReply('不是 JSON'), null)

  const bad = heuristicMood({ userText: '你太慢了，真烦' })
  assert.ok(bad.delta < 0, '负面关键词应扣分')
  const good = heuristicMood({ userText: '谢谢你，真厉害' })
  assert.ok(good.delta > 0, '正面关键词应加分')
  console.log('✓ 评价变量映射、解析与启发式')
}

// ---------- 3. 轮次扫描 ----------
{
  let got = null
  const scan = createTurnScanner({ onTurn: (turn) => (got = turn) })
  const session = {
    id: 's1',
    seq: 1,
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'user/message', data: { turn: 3, message: { content: [{ type: 'text', text: '谢谢，真棒' }] } } },
      { type: 'user/message', data: { turn: 3, message: { content: [{ type: 'text', text: '（时间注入）' }], source: { kind: 'injection' } } } },
      { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '嘿嘿' }] } } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ],
  }
  scan([{ ...session, seq: 1 }]) // 建立基线
  scan([{ ...session, seq: 6 }]) // 推事件
  assert.ok(got, '应产生一轮完成事件')
  assert.equal(got.turn, 3)
  assert.ok(got.user.includes('谢谢'), '应抓到用户原话')
  assert.ok(!got.user.includes('时间注入'), '注入消息应被跳过')
  assert.ok(got.assistant.includes('嘿嘿'))
  console.log('✓ 轮次扫描')
}

// ---------- 4. 插件整链（mock ctx） ----------
{
  const file = moodFile()
  try {
    fs.rmSync(file)
  } catch {}

  const sections = []
  const routes = []
  const tools = []

  const fakeStream = async function* () {
    yield { type: 'text-delta', text: '{"desirability":0.6,"expectancy":0.2,"agency":"user","control":0.8,"reason":"被夸了"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const session = { id: 's1', seq: 10, snapshotEvents: () => [] }

  const services = {
    sessions: { list: () => [session] },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return { dispose() {} }
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return { dispose() {} }
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return { dispose() {} }
      },
    },
    llm: { stream: () => fakeStream() },
  }

  const ctx = {
    get: (name) => services[name],
    effect: (fn) => {
      const handle = fn()
      return () => handle && handle.dispose && handle.dispose()
    },
    logger: { info() {}, warn() {} },
  }

  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(routes.length, 1, '应注册一个端点')
  assert.equal(routes[0].path, '/dsh-feiyu-mood/state')
  assert.equal(tools.length, 1, '应注册一个工具')
  assert.equal(tools[0].name, 'feiyu_mood_status')
  // 2026-11-01 用户裁定：心情只对接桌宠与 QQ，不进入客户端对话 ——
  // 不再挂 systemPrompt（动态段会触发系统提示整份重写），这里断言零注入。
  assert.equal(sections.length, 0, '不应挂系统提示词段')

  const initial = summary(readState(file))
  assert.equal(initial.mood, 60)

  // 模拟一轮完成：事件从 seq 10 推到 16
  session.seq = 16
  session.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { turn: 2, message: { content: [{ type: 'text', text: '谢谢你，好可爱' }] } } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '嘿嘿' }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]

  let after = null
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    after = summary(readState(file))
    if (after.reason === '被夸了') break
  }
  assert.ok(after, '应读到心情文件')
  assert.equal(after.mood, 66, '0.6 的评价 → +6')
  assert.equal(after.reason, '被夸了')
  assert.equal(after.dims.happy, 48)
  assert.ok(after.timeline.length >= 1)
  const last = after.timeline[after.timeline.length - 1]
  assert.equal(last.appraisal && last.appraisal.desirability, 0.6, '时间线里应留下评价快照')
  console.log('✓ 插件整链（mock ctx）')
}

console.log('\n全部通过')
process.exit(0)
