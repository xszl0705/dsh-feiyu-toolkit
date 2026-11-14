/** 六个工具的入口。判断归模型，这里只负责结构化、召回、校验、落盘。 */
import { cleanName, createProject, loadConfig, listProjects, readState, requireProject, writeState } from './store.js'
import { TYPES, activate, addElement, checkWorld, setRule } from './world.js'
import { listGroups, pickQuestions } from './questionnaire.js'
import { beamStatus, checkAll, checkScene, newScene, recordBeat } from './scene.js'

const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
const PROJ = { type: 'string', description: '项目名（中文/字母/数字/_-）' }

function guard(fn) {
  return async (args) => {
    try {
      return await fn(args)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
}

// ── gm_world ────────────────────────────────────────────
const gmWorld = {
  name: 'gm_world',
  description: '建世界卡：设一条硬规则、加元素（NPC/地点/势力/事件/概念）、按文本召回该进上下文的元素、做确定性体检。规则是骨架，元素是血肉。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['init', 'rule', 'add', 'list', 'show', 'activate', 'check', 'ask'], description: 'init 建项目；rule 设/改核心规则；add 加元素；activate 按文本召回；check 体检；ask 出问卷题（按组）' },
      project: PROJ,
      group: { type: 'number', description: 'ask 时第几组（1-18），不带则列全部组' },
      limit: { type: 'number', description: 'ask 时出几题，默认 5' },
      offset: { type: 'number', description: 'ask 时从第几题开始，默认 0' },
      title: { type: 'string' },
      rule: { type: 'string', description: '一条硬规则，中途不能改' },
      limits: { type: 'array', items: { type: 'string' }, description: '这条规则带来的限制（限制比力量有趣）' },
      type: { type: 'string', enum: ['npc', 'place', 'faction', 'item', 'event', 'concept'] },
      name: { type: 'string', description: '元素名' },
      body: { type: 'string', description: '元素正文' },
      keys: { type: 'array', items: { type: 'string' }, description: '激活关键词（不填就用元素名）' },
      tags: { type: 'array', items: { type: 'string' } },
      text: { type: 'string', description: 'activate 时用于匹配的文本' },
    },
    required: ['action'],
  },
  output: { schema: { type: 'object' }, render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || JSON.stringify(v)) },
  timeoutMs: 15000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const action = String(args.action || '')
    if (action === 'ask') {
      if (!args.group) {
        const gs = listGroups()
        return { ok: true, groups: gs, message: '共 ' + gs.length + ' 组：\n' + gs.map((g) => '· 第 ' + g.id + ' 组 ' + g.title + '（' + g.count + ' 题）').join('\n') + '\n\n用 gm_world(action=ask, group=2, limit=5) 出题。别一次答完 300 题。' }
      }
      const r = pickQuestions(args.group, args.limit, args.offset)
      const lines = ['【第 ' + r.id + ' 组 · ' + r.title + '】共 ' + r.total + ' 题，本次 ' + r.questions.length + ' 题：']
      for (const q of r.questions) lines.push(q.no + '. ' + q.text)
      lines.push('', '答不出来的题，就是世界还没立住的地方。')
      return { ok: true, ...r, message: lines.join('\n') }
    }
    if (action === 'list') {
      const ps = listProjects(config)
      return { ok: true, projects: ps, message: ps.length ? ps.map((p) => '· ' + p.name + '（' + p.title + '）元素 ' + p.elements + '，场景 ' + p.scenes).join('\n') : '还没有项目，先 gm_world(action=init)' }
    }
    if (action === 'init') {
      const r = createProject(args.project, args.title, config)
      return { ok: true, created: r.created, message: r.created ? '已建项目 ' + r.world.name + '。下一步：gm_world(action=rule) 设一条硬规则' : '项目已存在：' + args.project }
    }
    const name = cleanName(args.project)
    requireProject(name, config)
    if (action === 'rule') {
      const r = setRule(name, args.rule, args.limits, config)
      return { ok: true, ...r, message: (r.changedFrom ? '规则已更新（旧：' + r.changedFrom + '）\n' : '') + '规则：' + r.rule + (r.limits.length ? '\n限制：' + r.limits.join('；') : '') }
    }
    if (action === 'add') {
      const el = addElement(name, { ...args, name: args.name, type: args.type, body: args.body }, config)
      return { ok: true, element: el, message: '已加 ' + el.type + '：' + el.name + '（关键词 ' + el.activation.keys.join('/') + '）' }
    }
    if (action === 'activate') {
      const r = activate(name, args.text, config)
      const lines = ['召回 ' + r.hits.length + ' 条，级联 ' + r.cascade.length + ' 条：']
      for (const h of r.hits) lines.push('· [' + h.type + '] ' + h.name + (h.body ? '：' + h.body.slice(0, 100) : ''))
      for (const c of r.cascade) lines.push('· [级联:' + c.type + '] ' + c.name)
      if (!r.hits.length) lines.push('（没有命中——要么文本里没提到，要么元素没设关键词）')
      return { ok: true, hits: r.hits.length, cascade: r.cascade.length, message: lines.join('\n') }
    }
    if (action === 'check') {
      const r = checkWorld(name, config)
      return { ok: r.ok, issues: r.issues, message: (r.ok ? '世界卡体检通过' : '有阻断项') + (r.issues.length ? '\n' + r.issues.map((i) => '· [' + i.level + '] ' + i.msg).join('\n') : '') }
    }
    if (action === 'show') {
      const w = readState(name, 'world', config)
      return { ok: true, world: w, message: '【' + w.title + '】规则：' + (w.rule || '未设') + '\n元素 ' + (w.elements || []).length + ' 条' }
    }
    throw new Error('未知 action：' + action)
  }),
}

// ── gm_scene ────────────────────────────────────────────
const gmScene = {
  name: 'gm_scene',
  description: '出场景卡：必须拆出冲突双方各自要什么（代码会检查是否互斥）、写清"更糟"、给至少三条线索。goal 故意留空——那是玩家的事。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['new', 'list', 'check'], description: 'new 新建；list 列出；check 检查' },
      project: PROJ,
      title: { type: 'string' },
      place: { type: 'string' },
      time: { type: 'string' },
      cast: { type: 'array', items: { type: 'string' } },
      aWho: { type: 'string', description: '冲突 A 方是谁' },
      aWant: { type: 'string', description: 'A 方要什么' },
      bWho: { type: 'string' },
      bWant: { type: 'string' },
      disaster: { type: 'string', description: '失败时"更糟"是什么' },
      clues: { type: 'array', items: { type: 'string' }, description: '至少三条' },
      id: { type: 'string', description: 'check 时指定场景 id' },
    },
    required: ['action', 'project'],
  },
  output: { schema: { type: 'object' }, render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || JSON.stringify(v)) },
  timeoutMs: 15000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    requireProject(name, config)
    const action = String(args.action || '')
    if (action === 'new') {
      const sc = newScene(name, args, config)
      const ck = checkScene(name, sc.id, config)
      return { ok: ck.ok, scene: sc, issues: ck.issues, message: '已建场景 ' + sc.title + '（' + sc.id + '）' + (ck.issues.length ? '\n' + ck.issues.map((i) => '· [' + i.level + '] ' + i.msg).join('\n') : '\n检查通过') }
    }
    if (action === 'list') {
      const scenes = readState(name, 'scenes', config) || []
      return { ok: true, scenes, message: scenes.length ? scenes.map((s) => '· ' + s.id + ' ' + s.title + (s.outcome ? '（已结束）' : '')).join('\n') : '还没有场景' }
    }
    if (action === 'check') {
      const r = checkScene(name, args.id, config)
      return { ok: r.ok, ...r, message: (r.ok ? '通过' : '有问题') + (r.issues.length ? '\n' + r.issues.map((i) => '· [' + i.level + '] ' + i.msg).join('\n') : '') }
    }
    throw new Error('未知 action：' + action)
  }),
}

// ── gm_post ─────────────────────────────────────────────
const gmPost = {
  name: 'gm_post',
  description: '生成一条群聊帖子草稿：时间地点 + 可交互物 + 一个钩子，控制在 100-300 字。只给模板和素材，正文由模型写。',
  parameters: {
    type: 'object',
    properties: {
      project: PROJ,
      sceneId: { type: 'string' },
      focus: { type: 'string', description: '这一帖想让玩家注意什么' },
    },
    required: ['project', 'sceneId'],
  },
  output: { schema: { type: 'object' }, render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || '') },
  timeoutMs: 10000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    requireProject(name, config)
    const scenes = readState(name, 'scenes', config) || []
    const sc = scenes.find((s) => s.id === args.sceneId)
    if (!sc) throw new Error('没有这个场景')
    const lines = [
      '【' + (sc.time || '时间未定') + ' · ' + (sc.place || '地点未定') + '】',
      '',
      '模板（填三样，别多写）：',
      '1. 环境一句：只挑两个感官细节，一个常见、一个反常',
      '2. 可交互物：一件玩家能上手的东西（一个动作就能触碰）',
      '3. 钩子：一个问题 / 一个未定结果 / 一个新细节',
      '',
      '本场素材：',
      '- 冲突：' + sc.conflict.a.who + '要' + sc.conflict.a.want + '；' + sc.conflict.b.who + '要' + sc.conflict.b.want,
      '- 更糟：' + (sc.disaster || '（未写）'),
      '- 线索：' + (sc.clues.length ? sc.clues.join(' / ') : '（不足三条）'),
    ]
    if (args.focus) lines.push('- 这一帖的重点：' + args.focus)
    lines.push('', '写完自检：玩家听完能说出至少一个动作吗？说不出就重写。')
    return { ok: true, message: lines.join('\n') }
  }),
}

// ── gm_beam ─────────────────────────────────────────────
const gmBeam = {
  name: 'gm_beam',
  description: '镜头表：看当前场景里哪些在场角色还没"有戏"，下一帖该给谁具体处境。防止有人整晚旁听。',
  parameters: { type: 'object', properties: { project: PROJ }, required: ['project'] },
  output: { schema: { type: 'object' }, render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || JSON.stringify(v)) },
  timeoutMs: 10000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    requireProject(name, config)
    const r = beamStatus(name, config)
    const lines = r.scene ? ['场景：' + r.title, '在场：' + (r.cast.join('、') || '（未填）'), '已有戏：' + (r.acted.join('、') || '无'), '还没戏：' + (r.idle.join('、') || '无'), r.note] : [r.note]
    return { ok: true, ...r, message: lines.join('\n') }
  }),
}

// ── gm_beat ─────────────────────────────────────────────
const gmBeat = {
  name: 'gm_beat',
  description: '记录"玩家的选择改变了什么"。每个结束的场景都该至少有一条——没有就是假选择。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['record', 'list'] },
      project: PROJ,
      at: { type: 'string', description: '场景 id' },
      who: { type: 'string', description: '谁做的选择' },
      choice: { type: 'string' },
      changed: { type: 'string', description: '改变了什么' },
      cost: { type: 'string', description: '代价' },
    },
    required: ['action', 'project'],
  },
  output: { schema: { type: 'object' }, render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || JSON.stringify(v)) },
  timeoutMs: 10000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    requireProject(name, config)
    if (args.action === 'list') {
      const beats = readState(name, 'beats', config) || []
      return { ok: true, beats, message: beats.length ? beats.map((b) => '· ' + b.who + '「' + b.choice + '」→ ' + (b.changed || '未写') + (b.cost ? '（代价：' + b.cost + '）' : '')).join('\n') : '还没有记录' }
    }
    const b = recordBeat(name, args, config)
    return { ok: true, beat: b, message: '已记录：' + b.who + '「' + b.choice + '」→ ' + (b.changed || '（记得补 changed）') }
  }),
}

// ── gm_check ────────────────────────────────────────────
const gmCheck = {
  name: 'gm_check',
  description: '横切自检：把世界、场景、beat 三层的问题一次扫出来（假选择、线索不足、世界缺规则）。确定性检查，不调模型。',
  parameters: { type: 'object', properties: { project: PROJ }, required: ['project'] },
  output: { schema: { type: 'object' }, render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || JSON.stringify(v)) },
  timeoutMs: 10000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    requireProject(name, config)
    const w = checkWorld(name, config)
    const s = checkAll(name, config)
    const all = [...w.issues, ...s.issues]
    const lines = [all.length ? '发现 ' + all.length + ' 个问题：' : '通过']
    for (const i of all) lines.push('· [' + i.level + '] ' + i.msg)
    if (!all.length) lines.push('（世界有规则、场景有线索、每个结束的场景都有 beat）')
    return { ok: all.filter((i) => i.level === 'blocker').length === 0, issues: all, message: lines.join('\n') }
  }),
}

export function createGmTools() {
  return [gmWorld, gmScene, gmPost, gmBeam, gmBeat, gmCheck]
}
