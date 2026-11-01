/**
 * 一致性自检：同一个主体，不同渠道只能差在「怎么说」。
 *   node tests/consistency.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, 'tests', '.tmp-core')

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    problems.push(`${label} ${detail}`)
    console.log(`  FAIL ${label} ${detail}`)
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
const { loadCore, personaHash } = await import(
  `file://${path.join(ROOT, 'lib', 'persona.js').replace(/\\/g, '/')}`
)
const { buildSystem, buildPetTemplate, buildClientIdentity, fillTemplate, channelRules } = await import(
  `file://${path.join(ROOT, 'lib', 'compose.js').replace(/\\/g, '/')}`
)

const core = loadCore(TMP, ROOT)

console.log('\n[身份单一来源]')
{
  check('默认 persona 已落盘', fs.existsSync(path.join(TMP, 'persona.md')))
  check('默认 voice 已落盘', fs.existsSync(path.join(TMP, 'voice.json')))
  check('persona 含一致性约定', core.persona.includes('同一个我'))
  check('persona 含边界（隐私日记/不编造）', core.persona.includes('隐私日记') && core.persona.includes('绝不编'))
  check('voice 解析出四个渠道',
    ['client', 'pet', 'qq', 'bili'].every((name) => Boolean(core.voice.channels[name])),
    Object.keys(core.voice.channels).join(','))
}

console.log('\n[跨渠道只换表达]')
{
  const client = buildSystem({ channel: 'client', core })
  const pet = buildSystem({ channel: 'pet', core })
  const qq = buildSystem({ channel: 'qq', core })

  // 身份块必须逐字相同（同一份 persona）
  const identity = core.persona
  check('client 含完整 persona', client.includes(identity))
  check('pet 含完整 persona', pet.includes(identity))
  check('qq 含完整 persona', qq.includes(identity))

  // 渠道差异只允许在约束部分
  check('client 允许长表达', client.includes('按需'))
  check('pet 限制 18 字', pet.includes('18'))
  check('qq 允许表情', qq.includes('表情'))
  check('pet 不允许表情', pet.includes('不用表情符号'))

  // 去身份后剩余部分必须互不相同（说明确实按渠道变）
  const strip = (text) => text.replace(identity, '').trim()
  check('去掉身份后三渠道约束不同', strip(client) !== strip(pet) && strip(pet) !== strip(qq))
}

console.log('\n[桌宠模板可装配]')
{
  const tpl = buildPetTemplate(core)
  check('模板含四类占位符',
    ['{{scene}}', '{{away}}', '{{mood}}', '{{memory}}'].every((tag) => tpl.includes(tag)))
  const filled = fillTemplate(tpl, { scene: '普通时刻', away: '用户刚回来 5 分钟', mood: '心情不错', memory: '记忆库有 16 条' })
  check('占位符被替换', !filled.includes('{{') && filled.includes('用户刚回来 5 分钟'))
  check('替换后仍保留 persona', filled.includes(core.persona))
  check('空值不留下占位符', !fillTemplate(tpl, { scene: '普通时刻' }).includes('{{'))
}

console.log('\n[客户端身份段]')
{
  const identity = buildClientIdentity(core)
  check('含 persona 与渠道说明', identity.includes(core.persona) && identity.includes('客户端'))
  check('声明跨渠道一致', identity.includes('同一个你'))
  check('渠道规则函数可用', channelRules('bili', core.voice).includes('B 站'))
}

console.log('\n[哈希稳定]')
{
  const a = personaHash(core.persona)
  const b = personaHash(loadCore(TMP, ROOT).persona)
  check('同一 persona 哈希一致', a === b)
  check('哈希长度 64', a.length === 64)
}

console.log('\n[systemPrompt 延迟就绪]')
{
  process.env.DSH_HOME = TMP
  const stateKey = Symbol.for('dsh-dafeiyu-core.state')
  delete globalThis[stateKey]
  const mod = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)
  let calls = 0
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      calls += 1
      if (calls <= 2) return undefined
      return { section: (definition) => (sections.push(definition), { dispose() {} }) }
    },
    effect(fn) {
      fn()
    },
  }
  mod.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 800))
  check('服务晚就绪也能挂上', sections.length === 1, `calls=${calls} sections=${sections.length}`)
  check('挂载段用的是同一份 persona', Boolean(sections[0] && sections[0].text().includes('大肥鱼')))
  delete globalThis[stateKey]
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) for (const item of problems) console.log(` - ${item}`)
process.exitCode = fail > 0 ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100)
