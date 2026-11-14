/** 六个工具定义。判断由模型做，这里只负责收编、打包、记账、计算、出报告。 */
import {
  ALL_KINDS,
  addSource,
  cleanName,
  createProject,
  getProject,
  listProjects,
  listSources,
  loadConfig,
  readSources,
  upsertIssue,
  readIssues,
  loadIndex,
} from './store.js'
import { CHECKLISTS, listChecklists, loadChecklist } from './checklists.js'
import { extractTerms } from './terms.js'
import { simulate } from './sim.js'
import { writeReport } from './report.js'

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

const PROJECT = { type: 'string', description: '项目名（字母/数字/中文/_-），先 rp_open 建' }
const KIND = { type: 'string', enum: Object.keys(CHECKLISTS), description: '内容类别' }
const SEVERITY = { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'], description: 'blocker=开不了团 major=会崩或吵 minor=体验 nit=文字' }

function guard(fn) {
  return async (args) => {
    try {
      return await fn(args)
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }
}

// ── rp_open ─────────────────────────────────────────────
const rpOpen = {
  name: 'rp_open',
  description: '跑团工坊入口：建项目 / 登记规则书·设定·大纲·数值内容 / 列项目 / 看项目状态。把用户贴的文本或文件内容交给它，它按标题切章存进工作区项目库。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'add', 'list', 'status'], description: 'create 建项目；add 登记内容；list 列项目；status 看某项目' },
      project: PROJECT,
      title: { type: 'string', description: 'create 时的项目标题；add 时给这次内容的来源标题' },
      content: { type: 'string', description: 'add 的正文（markdown，按 # 标题切章）' },
      kind: KIND,
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, error: { type: 'string' } } },
    render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.message || JSON.stringify(v)),
  },
  timeoutMs: 15000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const action = String(args?.action || '')
    if (action === 'list') {
      const projects = listProjects(config)
      if (!projects.length) return { ok: true, projects: [], message: '还没有项目，先 rp_open(action=create)' }
      return {
        ok: true,
        projects,
        message: projects.map((p) => '· ' + p.name + '（' + p.title + '）源文 ' + Object.entries(p.kinds).map(([k, n]) => k + ':' + n).join(' ') + '，问题 ' + p.open + '/' + p.issues + ' 未处理').join('\n'),
      }
    }
    if (action === 'create') {
      const { created, project } = createProject(args.project, args.title, config)
      return { ok: true, project, message: (created ? '已建项目：' : '项目已存在：') + project.name + '（' + project.title + '）' }
    }
    const name = cleanName(args?.project)
    if (action === 'status') {
      const project = getProject(name, config)
      const issues = readIssues(name, config)
      const open = issues.filter((i) => i.status === 'open')
      const parts = ['项目 ' + name + '（' + project.title + '）']
      for (const kind of ALL_KINDS) {
        const n = listSources(name, kind, config).length
        if (n) parts.push('· ' + kind + ' 源文 ' + n + ' 章')
      }
      parts.push('· 问题 ' + issues.length + ' 条，未处理 ' + open.length)
      return { ok: true, project, issues: issues.length, open: open.length, message: parts.join('\n') }
    }
    if (action === 'add') {
      const result = addSource(name, args.kind, args.title, args.content, config)
      return {
        ok: true,
        ...result,
        message: '已登记 ' + result.added + ' 章（' + result.kind + '）：\n' + result.chapters.map((c) => '· ' + c.title + '（' + c.chars + ' 字）').join('\n'),
      }
    }
    throw new Error('未知 action：' + action)
  }),
}

// ── rp_pack ─────────────────────────────────────────────
const rpPack = {
  name: 'rp_pack',
  description: '出评审工作包：把某类检查清单 + 对应源文 + 尚未关闭的历史问题 + 输出格式要求打包，交给模型逐条审。评审前必须先调这个，不要自己凭记忆列标准。',
  parameters: {
    type: 'object',
    properties: {
      project: PROJECT,
      kind: KIND,
      focus: { type: 'string', description: '可选：本次重点（如「判定与战斗」「术语」「第 3 章」）' },
      maxChars: { type: 'number', description: '源文最多带多少字，默认取 config.maxPacketChars' },
    },
    required: ['project', 'kind'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, packet: { type: 'string' }, error: { type: 'string' } } },
    render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.packet || ''),
  },
  timeoutMs: 15000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    getProject(name, config)
    const kind = String(args.kind || '')
    const cl = loadChecklist(kind)
    const sources = readSources(name, kind, config)
    if (!sources.length) {
      return { ok: false, error: '项目 ' + name + ' 里还没有 ' + kind + ' 的源文，先 rp_open(action=add)' }
    }
    const cap = Math.max(2000, Number(args.maxChars) || config.maxPacketChars || 24000)
    const openIssues = readIssues(name, config).filter((i) => i.status !== 'fixed' && i.status !== 'rejected')
    const lines = []
    lines.push('# 评审工作包 · ' + name + ' · ' + cl.title)
    if (args.focus) lines.push('重点：' + args.focus)
    lines.push('')
    lines.push('## 一、检查清单（逐条判定 pass / fail / na）')
    for (const item of cl.items) {
      lines.push('- **' + item.id + ' ' + item.title + '**：' + item.criteria)
      if (item.common) lines.push('  - 常见病：' + item.common)
      if (item.ask) lines.push('  - 自检：' + item.ask)
    }
    lines.push('')
    lines.push('## 二、历史未关问题（不要重复提，除非确认没改）')
    if (!openIssues.length) lines.push('（无）')
    for (const issue of openIssues) lines.push('- ' + issue.id + ' [' + issue.severity + '] ' + issue.problem + (issue.location ? '（' + issue.location + '）' : ''))
    lines.push('')
    lines.push('## 三、源文（共 ' + sources.length + ' 章）')
    let budget = cap
    let used = 0
    for (const src of sources) {
      if (budget <= 0) {
        lines.push('（还有 ' + (sources.length - used) + ' 章未展开，按需再取）')
        break
      }
      const body = src.text.slice(0, budget)
      lines.push('')
      lines.push('### ' + src.title)
      lines.push(body)
      if (src.text.length > body.length) lines.push('…（截断，全文 ' + src.text.length + ' 字）')
      budget -= body.length
      used += 1
    }
    lines.push('')
    lines.push('## 四、输出要求')
    lines.push('1. 对每条清单项给结论：pass / fail / na（附一句理由）。')
    lines.push('2. fail 时按下面的结构逐条登记：')
    lines.push('```json')
    lines.push('{"severity":"blocker|major|minor|nit","category":"' + kind + '","check":"R3","location":"第几章/哪句话","quote":"原文摘录","problem":"问题是什么","suggestion":"怎么改"}')
    lines.push('```')
    lines.push('3. 用 rp_issue(action=add) 逐条写入台账；不要只在回复里说。')
    lines.push('4. 只提真实问题，不要凑数；没问题就明确说通过。')
    const packet = lines.join('\n')
    return { ok: true, kind, checklist: cl.items.length, sources: sources.length, openIssues: openIssues.length, chars: packet.length, packet }
  }),
}

// ── rp_issue ────────────────────────────────────────────
const rpIssue = {
  name: 'rp_issue',
  description: '问题台账：把评审发现写成一条带 id / 严重度 / 位置 / 依据 / 建议的记录，或改状态。同一问题只记一次，改稿后标 fixed。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'list'], description: 'add 新增/按 id 覆盖；update 改状态；list 看台账' },
      project: PROJECT,
      id: { type: 'string', description: 'update 时必填，如 I003' },
      severity: SEVERITY,
      category: { type: 'string', description: '规则/设定/大纲/数值，默认取 kind' },
      check: { type: 'string', description: '对应清单编号，如 R3 / O2' },
      location: { type: 'string', description: '位置（章节/段落）' },
      quote: { type: 'string', description: '原文摘录，≤400 字' },
      problem: { type: 'string', description: '问题是什么' },
      suggestion: { type: 'string', description: '建议怎么改' },
      status: { type: 'string', enum: ['open', 'accepted', 'rejected', 'fixed'], description: '默认 open' },
    },
    required: ['action', 'project'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, issue: { type: 'object' }, error: { type: 'string' } } },
    render: (_a, v) => text(v?.error ? '失败：' + v.error : JSON.stringify(v?.issue || v)),
  },
  timeoutMs: 10000,
  isConcurrencySafe: () => false,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    getProject(name, config)
    const action = String(args.action || '')
    if (action === 'list') {
      const issues = readIssues(name, config)
      if (!issues.length) return { ok: true, issues: [], message: '台账是空的' }
      const open = issues.filter((i) => i.status === 'open')
      return {
        ok: true,
        total: issues.length,
        open: open.length,
        issues,
        message: issues.map((i) => '· ' + i.id + ' [' + i.severity + '·' + i.status + '] ' + i.problem).join('\n'),
      }
    }
    if (action === 'update') {
      if (!args.id) throw new Error('update 需要 id')
      const record = upsertIssue(name, { id: args.id, status: args.status || 'fixed', problem: args.problem }, config)
      return { ok: true, issue: record, message: '已更新 ' + record.id + ' → ' + record.status }
    }
    if (!args.problem) throw new Error('add 需要 problem')
    const record = upsertIssue(name, {
      id: args.id,
      severity: args.severity,
      category: args.category || 'rules',
      check: args.check,
      location: args.location,
      quote: args.quote,
      problem: args.problem,
      suggestion: args.suggestion,
      status: args.status,
    }, config)
    return { ok: true, issue: record, message: '已记 ' + record.id + '（' + record.severity + '）' + record.problem }
  }),
}

// ── rp_report ───────────────────────────────────────────
const rpReport = {
  name: 'rp_report',
  description: '把问题台账渲染成体检报告（markdown），落盘到项目 reports/ 并返回全文，可直接发给群友或存档。',
  parameters: {
    type: 'object',
    properties: { project: PROJECT },
    required: ['project'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' }, text: { type: 'string' }, error: { type: 'string' } } },
    render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.text || ''),
  },
  timeoutMs: 15000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    getProject(name, config)
    const { file, text: body } = writeReport(name, config)
    return { ok: true, file, chars: body.length, text: body }
  }),
}

// ── rp_sim ──────────────────────────────────────────────
const rpSim = {
  name: 'rp_sim',
  description: '数值模拟：给定命中判定、伤害骰、暴击、目标 HP/DR，跑蒙特卡洛，返回命中率、击杀所需轮次分布与判定结论。用于验算规则书的战斗数值，不要靠感觉估。',
  parameters: {
    type: 'object',
    properties: {
      project: PROJECT,
      name: { type: 'string', description: '这次模拟的名字' },
      trials: { type: 'number', description: '试验次数，默认 10000，上限 50000' },
      maxRounds: { type: 'number', description: '最多几轮，默认 20' },
      hit: {
        type: 'object',
        description: '命中判定，省略=必中',
        properties: { dice: { type: 'string', description: '默认 d100' }, lte: { type: 'number', description: '掷出 ≤ 这个数算命中，如 65' } },
      },
      damage: { type: 'string', description: '伤害骰，如 1d10+3' },
      crit: {
        type: 'object',
        description: '暴击，省略=无',
        properties: { lte: { type: 'number', description: 'd100 ≤ 此值暴击，如 5' }, extra: { type: 'string', description: '额外伤害骰，如 1d10' } },
      },
      defender: {
        type: 'object',
        description: '防守方',
        properties: { hp: { type: 'number' }, dr: { type: 'number', description: '每次减伤，默认 0' } },
        required: ['hp'],
      },
    },
    required: ['damage', 'defender'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } } },
    render: (_a, v) => {
      if (v?.error) return text('失败：' + v.error)
      const r = v.result || {}
      const lines = [
        '【' + (r.name || '模拟') + '】' + r.trials + ' 次 × 最多 ' + r.maxRounds + ' 轮',
        '命中率 ' + (r.hitRate * 100).toFixed(1) + '%' + (r.critRate ? ' · 暴击率 ' + (r.critRate * 100).toFixed(1) + '%' : ''),
        '平均每轮伤害（含减伤）' + r.avgDamagePerRound,
        r.roundsToKill ? '击杀轮次 P10/P50/P90 = ' + r.roundsToKill.p10 + ' / ' + r.roundsToKill.p50 + ' / ' + r.roundsToKill.p90 + '，均值 ' + r.roundsToKill.mean : '击杀轮次：无',
        '结论：' + r.verdict,
      ]
      return text(lines.join('\n'))
    },
  },
  timeoutMs: 30000,
  isConcurrencySafe: () => false,
  execute: guard(async (args) => {
    const config = loadConfig()
    const spec = {
      name: args.name,
      trials: args.trials,
      maxRounds: args.maxRounds,
      hit: args.hit,
      damage: args.damage,
      crit: args.crit,
      defender: args.defender,
    }
    const result = simulate(spec, config)
    if (args.project) {
      try {
        upsertIssue(cleanName(args.project), {
          severity: 'nit',
          category: 'numbers',
          check: 'N2',
          problem: '数值模拟：' + (result.name || '') + ' → ' + result.verdict,
          suggestion: '命中率 ' + (result.hitRate * 100).toFixed(1) + '%，P50 击杀 ' + (result.roundsToKill?.p50 ?? '—') + ' 轮',
          status: 'fixed',
        }, config)
      } catch {
        // 项目不存在时不阻断模拟
      }
    }
    return { ok: true, result }
  }),
}

// ── rp_outline ──────────────────────────────────────────
const rpOutline = {
  name: 'rp_outline',
  description: '副本大纲结构校验：检查大纲是否含三要素、四段结构、进度钟、威胁倒计时、伏笔回收、分支与奖励；或生成一份空模板。只做结构缺口检查，内容好坏仍需模型评审。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['check', 'template'], description: 'check 检查现有大纲；template 生成模板' },
      project: PROJECT,
      title: { type: 'string', description: 'template 时副本名' },
    },
    required: ['action', 'project'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, missing: { type: 'array' }, text: { type: 'string' }, error: { type: 'string' } } },
    render: (_a, v) => text(v?.error ? '失败：' + v.error : v?.text || ''),
  },
  timeoutMs: 15000,
  isConcurrencySafe: () => true,
  execute: guard(async (args) => {
    const config = loadConfig()
    const name = cleanName(args.project)
    getProject(name, config)
    if (args.action === 'template') {
      return { ok: true, text: outlineTemplate(args.title || '副本名') }
    }
    const sources = readSources(name, 'outline', config)
    if (!sources.length) return { ok: false, error: '项目里还没有 outline 源文，先 rp_open(action=add, kind=outline)' }
    const body = sources.map((s) => s.text).join('\n')
    const checks = [
      ['背景设定', /背景|设定|世界/],
      ['通关条件', /通关|胜利条件|目标/],
      ['死亡条件', /死亡|淘汰|失败条件|违规/],
      ['进入段', /进入|开场|传送/],
      ['探索段', /探索|调查|线索/],
      ['破局段', /破局|漏洞|反击|解决/],
      ['结算段', /结算|奖励|返回/],
      ['进度钟', /进度|倒计时|钟|阶段/],
      ['伏笔', /伏笔|埋点|回收/],
      ['分支', /分支|路线|选择/],
      ['团灭预案', /团灭|全灭|失败之后/],
      ['奖励', /奖励|积分|道具/],
    ]
    const missing = checks.filter(([, re]) => !re.test(body)).map(([label]) => label)
    const lines = ['【大纲结构校验】' + name, '', '已有：', ...checks.filter(([, re]) => re.test(body)).map(([l]) => '· ' + l), '', '缺失：']
    lines.push(...(missing.length ? missing.map((m) => '· ' + m) : ['（无，结构完整）']))
    lines.push('', '缺失项用 rp_issue 登记，不要只在这里说。')
    return { ok: true, missing, text: lines.join('\n') }
  }),
}

function outlineTemplate(title) {
  return [
    '# 副本：' + title,
    '',
    '## 背景设定',
    '（世界规则、时代、地点、玩家从哪来）',
    '',
    '## 通关条件',
    '（明确可判定的胜利目标，几条）',
    '',
    '## 死亡条件',
    '（什么行为/状态会导致死亡或淘汰）',
    '',
    '## 一、进入 10%',
    '- 玩家如何进入、初始信息',
    '- 初始敌友关系',
    '',
    '## 二、探索 30%',
    '- 线索 1 / 2 / 3，各自在哪给',
    '- 第一次规则展示（死一个 NPC 或玩家）',
    '',
    '## 三、破局 40%',
    '- 预设漏洞是什么',
    '- 玩家可能的三种解法',
    '- 意外：执行中会出什么岔子',
    '',
    '## 四、结算 20%',
    '- 通关判定',
    '- 奖励：积分 / 能力 / 情报',
    '- 返回主空间',
    '',
    '## 进度钟',
    '6 格：每完成一步填一格，填满触发破局',
    '',
    '## 威胁倒计时（GM 私有）',
    '玩家每停留一气，威胁推进一格：1 → 2 → 3 → 触发',
    '',
    '## 伏笔台账',
    '| 埋点 | 在哪埋 | 在哪回收 | 状态 |',
    '|---|---|---|---|',
    '',
    '## 分支节点',
    'A → B / C；B、C 都汇合到 D',
    '',
    '## 团灭预案',
    '（全队失败后故事怎么继续）',
  ].join('\n')
}

export function createRpTools() {
  return [rpOpen, rpPack, rpIssue, rpReport, rpSim, rpOutline]
}
