/** dsh-gm-craft 单测：不起宿主，直接测 lib 层。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProject, listProjects, readState } from '../lib/store.js'
import { activate, addElement, checkWorld, setRule } from '../lib/world.js'
import { beamStatus, checkAll, checkScene, newScene, recordBeat } from '../lib/scene.js'
import { createGmTools } from '../lib/tools.js'

const results = []
const pending = []
function check(suite, name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      pending.push(out.then(() => results.push({ suite, name, ok: true }), (e) => results.push({ suite, name, ok: false, error: String((e && e.message) || e) })))
      return
    }
    results.push({ suite, name, ok: true })
  } catch (e) {
    results.push({ suite, name, ok: false, error: String((e && e.message) || e) })
  }
}
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败') }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-craft-test-'))
process.env.DSH_GM_CRAFT_ROOT = root
const config = { root, minCluesPerScene: 3, postTargetChars: 200 }

check('world', '建项目', () => {
  const r = createProject('测试团', '第聂伯罗-7', config)
  assert(r.created, '应新建')
  assert(listProjects(config).length === 1, '列表应有 1 个')
})

check('world', '设规则', () => {
  const r = setRule('测试团', '坍塌液污染 + 资源匮乏', ['规则不能中途改'], config)
  assert(r.rule.includes('坍塌液'), '规则写入失败')
  assert(r.limits.length === 1, '限制没写进去')
})

check('world', '加元素并召回', () => {
  addElement('测试团', { type: 'npc', name: '谢尔盖', body: '前矿工', keys: ['谢尔盖', '工头'] }, config)
  addElement('测试团', { type: 'faction', name: '自由阵线', body: '难民武装', keys: ['自由阵线'] }, config)
  const r = activate('测试团', '你们看见谢尔盖站在铁轨边上', config)
  assert(r.hits.length >= 1, '应召回谢尔盖')
  assert(r.hits.some((h) => h.name === '谢尔盖'), '命中项不对')
})

check('world', 'relations 级联', () => {
  const w = readState('测试团', 'world', config)
  const sergei = w.elements.find((e) => e.name === '谢尔盖')
  const ff = w.elements.find((e) => e.name === '自由阵线')
  sergei.relations = [{ to: ff.id, rel: '领导', dir: 'out' }]
  fs.writeFileSync(path.join(root, '测试团', 'world.json'), JSON.stringify(w), 'utf8')
  const r = activate('测试团', '谢尔盖', config)
  assert(r.cascade.some((c) => c.name === '自由阵线'), '级联没带出自由阵线')
})

check('world', '体检抓缺项', () => {
  const r = checkWorld('测试团', config)
  assert(r.issues.some((i) => i.msg.includes('daily') || i.msg.includes('一天')), '应提示缺 daily')
})

check('scene', '建场景并检查互斥', () => {
  const sc = newScene('测试团', { title: '站台', place: '地铁站台', time: '23:40', aWho: '谢尔盖', aWant: '水', bWho: '玩家', bWant: '数据', disaster: '导出即断电', clues: ['灯坏了一半', '机器人说不要同时', '控制台负载98%'] }, config)
  assert(sc.id.startsWith('sc_'), 'id 前缀不对')
  const ck = checkScene('测试团', sc.id, config)
  assert(ck.ok, '应该通过：' + JSON.stringify(ck.issues))
})

check('scene', '目标相同要判不成立', () => {
  const sc = newScene('测试团', { title: '假冲突', aWho: 'A', aWant: '水', bWho: 'B', bWant: '水', disaster: 'x', clues: ['1', '2', '3'] }, config)
  const ck = checkScene('测试团', sc.id, config)
  assert(!ck.ok, '双方要同一东西应判 blocker')
})

check('scene', '线索不足要报', () => {
  const sc = newScene('测试团', { title: '线索少', aWho: 'A', aWant: 'x', bWho: 'B', bWant: 'y', disaster: 'd', clues: ['只有一条'] }, config)
  const ck = checkScene('测试团', sc.id, config)
  assert(ck.issues.some((i) => i.msg.includes('线索')), '应提示线索不足')
})

check('scene', '镜头表', () => {
  const scenes = readState('测试团', 'scenes', config)
  const last = scenes[scenes.length - 1]
  const r = beamStatus('测试团', config)
  assert(r.idle.length === last.cast.length || last.cast.length === 0, '镜头表不对')
})

check('scene', 'beat 记录与横切自检', () => {
  recordBeat('测试团', { at: 'sc_x', who: '艾什', choice: '说实话', changed: '谢尔盖交出信息' }, config)
  const r = checkAll('测试团', config)
  assert(r.counts.beats === 1, 'beat 没记上')
})

check('tools', '六个工具定义完整', () => {
  const tools = createGmTools()
  assert(tools.length === 6, '应有 6 个工具，实际 ' + tools.length)
  for (const t of tools) {
    assert(t.name.startsWith('gm_'), '前缀不对：' + t.name)
    assert(t.description && t.description.length > 20, t.name + ' 缺描述')
    assert(t.parameters && t.parameters.type === 'object', t.name + ' 参数结构错')
    assert(typeof t.execute === 'function', t.name + ' 缺 execute')
    assert(typeof t.output?.render === 'function', t.name + ' 缺 render')
  }
})

check('tools', '闭环：init → rule → add → scene', async () => {
  const tools = createGmTools()
  const w = tools.find((t) => t.name === 'gm_world')
  const s = tools.find((t) => t.name === 'gm_scene')
  const a = await w.execute({ action: 'init', project: '闭环', title: '闭环测试' })
  assert(a.ok, 'init 失败：' + a.error)
  const b = await w.execute({ action: 'rule', project: '闭环', rule: '一条规则', limits: ['限制一'] })
  assert(b.ok, 'rule 失败：' + b.error)
  const c = await s.execute({ action: 'new', project: '闭环', title: '场景一', aWho: 'X', aWant: '甲', bWho: 'Y', bWant: '乙', disaster: '更糟', clues: ['a', 'b', 'c'] })
  assert(c.ok, 'scene 失败：' + c.error)
})

await Promise.all(pending)
const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2), 'utf8')
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }))
for (const f of failed) console.log('FAIL ' + f.suite + '/' + f.name + ': ' + f.error)
try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  // 清理失败不影响结果
}
process.exit(failed.length ? 1 : 0)
