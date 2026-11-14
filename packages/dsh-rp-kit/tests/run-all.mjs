/**
 * dsh-rp-kit 单测：不起宿主，直接测 lib 层。
 * 跑法：ELECTRON_RUN_AS_NODE=1 "<DSH_HOME>/DeepSeek Harness.exe" tests/run-all.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addSource,
  createProject,
  listProjects,
  listSources,
  readIssues,
  splitByHeading,
  upsertIssue,
} from '../lib/store.js'
import { listChecklists, loadChecklist } from '../lib/checklists.js'
import { extractTerms } from '../lib/terms.js'
import { parseDice, simulate } from '../lib/sim.js'
import { buildReport } from '../lib/report.js'
import { createRpTools } from '../lib/tools.js'

const results = []
const pending = []
function check(suite, name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      pending.push(
        out.then(
          () => results.push({ suite, name, ok: true }),
          (error) => results.push({ suite, name, ok: false, error: String((error && error.message) || error) }),
        ),
      )
      return
    }
    results.push({ suite, name, ok: true })
  } catch (error) {
    results.push({ suite, name, ok: false, error: String((error && error.message) || error) })
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-kit-test-'))
process.env.DSH_RP_KIT_ROOT = root
const config = { root, maxPacketChars: 24000, simTrialLimit: 50000 }

const SAMPLE = `# 判定规则

攻击：d100 ≤ 攻击值命中。
伤害 = 1d10 + 攻击修正。

# 战斗流程

命中后减护甲，HP 归零死亡。

# 主神空间

积分可兑换能力。`

check('store', '按标题切章', () => {
  const chapters = splitByHeading(SAMPLE)
  assert(chapters.length === 3, '应切出 3 章，实际 ' + chapters.length)
  assert(chapters[0].title === '判定规则', '第一章标题错：' + chapters[0].title)
})

check('store', '建项目与登记源文', () => {
  const { created } = createProject('测试团', '无限流测试', config)
  assert(created, '应新建项目')
  const added = addSource('测试团', 'rules', '规则书 v1', SAMPLE, config)
  assert(added.added === 3, '应登记 3 章，实际 ' + added.added)
  const sources = listSources('测试团', 'rules', config)
  assert(sources.length === 3, '源文应有 3 个文件')
  const projects = listProjects(config)
  assert(projects.length === 1 && projects[0].name === '测试团', '项目列表不对')
})

check('store', '问题台账', () => {
  const one = upsertIssue('测试团', { severity: 'blocker', category: 'rules', problem: '死亡条件缺失' }, config)
  assert(one.id === 'I001', '首个问题 id 应为 I001')
  upsertIssue('测试团', { id: one.id, status: 'fixed', problem: '死亡条件缺失' }, config)
  const issues = readIssues('测试团', config)
  assert(issues.length === 1 && issues[0].status === 'fixed', '状态更新失败')
})

check('checklists', '四套清单都能解析', () => {
  const list = listChecklists()
  assert(list.length === 4, '应有 4 套清单')
  for (const item of list) {
    assert(item.count >= 8, item.kind + ' 条目太少：' + item.count)
  }
  const rules = loadChecklist('rules')
  assert(rules.items[0].id === 'R1', 'R1 缺失')
  assert(rules.items[0].criteria.length > 10, 'R1 判据为空')
})

check('checklists', '未知类别报错', () => {
  let threw = false
  try {
    loadChecklist('nope')
  } catch {
    threw = true
  }
  assert(threw, '应抛错')
})

check('terms', '术语候选抽取', () => {
  const terms = extractTerms(['主神空间里，《无限恐怖》的轮回者要完成任务。主神空间会重置。'])
  const found = terms.map((t) => t.term)
  assert(found.includes('无限恐怖'), '应抽到书名')
  assert(found.includes('主神空间'), '应抽到重复专名')
})

check('sim', '骰式解析', () => {
  assert(JSON.stringify(parseDice('1d10+3')) === JSON.stringify({ count: 1, sides: 10, bonus: 3 }), '1d10+3 解析错')
  assert(parseDice('d20').sides === 20, 'd20 解析错')
  assert(parseDice('5').bonus === 5, '定值解析错')
  let threw = false
  try {
    parseDice('abc')
  } catch {
    threw = true
  }
  assert(threw, '非法骰式应抛错')
})

check('sim', '模拟结果合理', () => {
  const r = simulate({ trials: 2000, maxRounds: 20, hit: { dice: 'd100', lte: 65 }, damage: '1d10+3', defender: { hp: 40, dr: 2 } }, config)
  assert(r.hitRate > 0.55 && r.hitRate < 0.75, '命中率应在 65% 附近，实际 ' + r.hitRate)
  assert(r.roundsToKill && r.roundsToKill.p50 > 0, '应有击杀轮次')
  assert(typeof r.verdict === 'string' && r.verdict.length > 4, '应有结论')
})

check('sim', '打不死时给结论', () => {
  const r = simulate({ trials: 500, maxRounds: 5, damage: '1d4', defender: { hp: 9999 } }, config)
  assert(r.killRate === 0 && r.verdict.includes('打不死'), '应判定打不死')
})

check('report', '报告含概览与问题', () => {
  const md = buildReport('测试团', config)
  assert(md.includes('体检报告'), '缺标题')
  assert(md.includes('问题合计'), '缺概览')
  assert(md.includes('I001'), '缺问题条目')
})

check('tools', '六个工具都定义完整', () => {
  const tools = createRpTools()
  assert(tools.length === 6, '应有 6 个工具，实际 ' + tools.length)
  for (const tool of tools) {
    assert(tool.name.startsWith('rp_'), '工具名应带 rp_ 前缀：' + tool.name)
    assert(tool.description && tool.description.length > 20, tool.name + ' 缺描述')
    assert(tool.parameters && tool.parameters.type === 'object', tool.name + ' 参数结构错')
    assert(typeof tool.execute === 'function', tool.name + ' 缺 execute')
    assert(typeof tool.output?.render === 'function', tool.name + ' 缺 render')
  }
})

// 用工具层跑一遍闭环（会写临时 root，不碰真实项目库）
check('tools', 'rp_open 闭环', async () => {
  const tools = createRpTools()
  const open = tools.find((t) => t.name === 'rp_open')
  const created = await open.execute({ action: 'create', project: '闭环', title: '闭环测试' })
  assert(created.ok, '建项目失败：' + created.error)
  const added = await open.execute({ action: 'add', project: '闭环', kind: 'outline', content: '# 副本一\n\n背景设定：废弃医院。\n\n# 副本二\n\n通关条件：找到出口。' })
  assert(added.ok, '登记失败：' + added.error)
})

await Promise.all(pending)
const failed = results.filter((r) => !r.ok)
const summary = {
  root,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log(JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed }))
for (const f of failed) console.log('FAIL ' + f.suite + '/' + f.name + ': ' + f.error)
try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  // 清理失败不影响结果
}
process.exit(failed.length ? 1 : 0)
