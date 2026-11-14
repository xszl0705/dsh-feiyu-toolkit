/**
 * dsh-step-saver 的五个工具 —— 全部为「少一步、少一万字符」服务。
 *
 * 依据（本机 7 天实测 11,878 次调用）：
 *   · pwsh 4,103 次，其中约 1,300 次在拼固定前缀（powershell 438 / Get-ChildItem 288 /
 *     ELECTRON_RUN_AS_NODE 217 / PYTHONIOENCODING 122）→ run_node + ls_tree 直接吃掉这类调用
 *   · read 1,773 次吐 5,546 KB（单次 3.1 KB），重复率 35.3% → file_outline 先给骨架
 *   · grep 1,008 次，命中后往往再 read 两次 → smart_grep 把「命中 + 所在块」一次给全
 *   · 工具面 72 个、22 个零调用 → toolbox 让低频组按需挂载
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { addToScope, loadSlim, slimLog } from './slim.js'

const DEFAULT_ROOT = process.env.DSH_WORKSPACE || process.cwd()
const TMP_ROOT = path.join(DEFAULT_ROOT, '_tmp')
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-cache', '__pycache__', '.venv', 'dist', 'build'])

const text = (t) => [{ type: 'text', text: String(t) }]
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + `\n…（截断，原 ${String(s).length} 字符）` : String(s))

/* ============================== run_node ============================== */

function runChild(file, args, options) {
  return new Promise((resolve) => {
    const child = spawn(file, args, options)
    const chunks = []
    let size = 0
    const push = (buf) => {
      if (size > 400 * 1024) return
      chunks.push(buf)
      size += buf.length
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, options.__timeoutMs || 120000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, output: String(error && error.message ? error.message : error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: Number(code ?? -1), output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

export async function runNodeTool(args = {}) {
  const script = String(args.script || '').trim()
  if (!script) return { ok: false, error: '缺 script（.mjs / .js 脚本绝对路径）' }
  const abs = path.isAbsolute(script) ? script : path.resolve(DEFAULT_ROOT, script)
  if (!fs.existsSync(abs)) return { ok: false, error: '脚本不存在：' + abs }
  const extra = Array.isArray(args.args) ? args.args.map(String) : []
  const timeoutMs = Math.max(1000, Math.min(600000, Number(args.timeoutMs) || 120000))
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const outPath = args.out ? path.resolve(String(args.out)) : path.join(TMP_ROOT, `run-node-${stamp}.txt`)
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : path.dirname(abs)
  const exe = process.execPath
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
  if (process.env.PYTHONPATH) env.PYTHONPATH = process.env.PYTHONPATH

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const started = Date.now()
  const result = await runChild(exe, [abs, ...extra], { cwd, env, windowsHide: true, __timeoutMs: timeoutMs })
  const ms = Date.now() - started
  try {
    fs.writeFileSync(outPath, result.output, 'utf8')
  } catch {
    // 落盘失败仍然把尾部回给模型
  }
  const tail = result.output.slice(-1500)
  return {
    ok: result.code === 0,
    exitCode: result.code,
    durationMs: ms,
    outPath,
    tail: tail.trim(),
    note: 'stdout 已落盘；判读请看 tail 或 outPath。',
  }
}

/* ============================== ls_tree ============================== */

function walkTree(dir, depth, opts, acc) {
  if (depth < 0 || acc.count >= opts.limit) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (acc.count >= opts.limit) return
    const name = entry.name
    if (!opts.all && SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (opts.filter && !opts.filter.test(name) && !entry.isDirectory()) continue
    let size = ''
    if (entry.isDirectory()) size = '/'
    else {
      try {
        size = fs.statSync(full).size
      } catch {
        size = '?'
      }
    }
    acc.lines.push('  '.repeat(opts.base + (opts.depthMax - depth)) + (entry.isDirectory() ? '▸ ' + name + '/' : '· ' + name) + (entry.isDirectory() ? '' : '  ' + size + 'B'))
    acc.count += 1
    if (entry.isDirectory()) walkTree(full, depth - 1, opts, acc)
  }
}

export function lsTreeTool(args = {}) {
  const target = args.path ? path.resolve(String(args.path)) : DEFAULT_ROOT
  if (!fs.existsSync(target)) return { ok: false, error: '目录不存在：' + target }
  const depth = Math.max(0, Math.min(6, Number(args.depth ?? 2)))
  const limit = Math.max(1, Math.min(600, Number(args.limit ?? 200)))
  let filter = null
  if (args.filter) {
    try {
      filter = new RegExp(String(args.filter), 'i')
    } catch {
      filter = null
    }
  }
  const acc = { lines: [target], count: 0 }
  walkTree(target, depth, { limit, filter, depthMax: depth, base: 0, all: args.all === true }, acc)
  const body = acc.lines.join('\n')
  return { ok: true, path: target, count: acc.count, text: clip(body, 4000) }
}

/* ============================ file_outline ============================ */

const OUTLINE_RULES = [
  {
    ext: /\.(mjs|cjs|js|ts|jsx|tsx)$/i,
    rules: [
      [/^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)/, 'function', 3],
      [/^\s*(export\s+)?(default\s+)?class\s+([A-Za-z0-9_$]+)/, 'class', 3],
      [/^\s*export\s+(const|let|var)\s+([A-Za-z0-9_$]+)\s*=/, 'export', 2],
      [/^\s*const\s+([A-Za-z0-9_$]+)\s*=\s*(async\s*)?\(/, 'const-fn', 1],
      [/^\s{2,}(?!(?:for|if|while|switch|catch|else|return|await|function|do|try)\b)([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/, 'method', 1],
    ],
  },
  { ext: /\.md$/i, rules: [[/^(#{1,6})\s+(.*\S)/, 'heading', 2]] },
  { ext: /\.py$/i, rules: [[/^\s*class\s+([A-Za-z0-9_]+)/, 'class', 1], [/^\s*def\s+([A-Za-z0-9_]+)/, 'def', 1]] },
  { ext: /\.(yml|yaml)$/i, rules: [[/^([A-Za-z0-9_.-]+):/, 'key', 1]] },
]

export function fileOutlineTool(args = {}) {
  const raw = String(args.path || '').trim()
  if (!raw) return { ok: false, error: '缺 path' }
  const file = path.isAbsolute(raw) ? raw : path.resolve(DEFAULT_ROOT, raw)
  if (!fs.existsSync(file)) return { ok: false, error: '文件不存在：' + file }
  let content
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: '读失败：' + String((error && error.message) || error) }
  }
  const lines = content.split(/\r?\n/)
  const total = lines.length
  const ruleSet = OUTLINE_RULES.find((r) => r.ext.test(file))
  const items = []
  if (!ruleSet) {
    const head = lines.slice(0, 20).join('\n')
    return { ok: true, kind: 'raw', path: file, lines: total, items: [], text: clip(`（纯数据文件，不给骨架）共 ${total} 行，前 20 行：\n${head}`, 2500) }
  }
  for (let i = 0; i < lines.length && items.length < 120; i += 1) {
    const line = lines[i]
    if (line.length > 400) continue
    for (const [re, kind, nameIndex] of ruleSet.rules) {
      const m = re.exec(line)
      if (!m) continue
      const name = String(m[nameIndex] || '').trim()
      if (!name) continue
      items.push({ kind, name, line: i + 1 })
      break
    }
  }
  const body = items.map((it) => `L${it.line}\t${it.kind}\t${it.name}`).join('\n')
  return {
    ok: true,
    kind: ruleSet.ext.source,
    path: file,
    lines: total,
    chars: content.length,
    items,
    text: clip(`骨架 ${items.length} 条 / 共 ${total} 行 ${content.length} 字符（整读约 ${Math.ceil(content.length / 3.5)} token，骨架约 ${Math.ceil(body.length / 3.5)} token）：\n${body}`, 3500),
  }
}

/* ============================= smart_grep ============================= */

const OWNER_RULES = [
  [/^\s*(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)/, 3],
  [/^\s*(export\s+)?(default\s+)?class\s+([A-Za-z0-9_$]+)/, 3],
  [/^\s*def\s+([A-Za-z0-9_]+)/, 1],
  [/^(#{1,6})\s+(.*\S)/, 2],
]

function ownerOf(lines, index) {
  for (let i = index; i >= 0 && index - i < 200; i -= 1) {
    const line = lines[i]
    if (!line || line.length > 400) continue
    for (const [re, nameIndex] of OWNER_RULES) {
      const m = re.exec(line)
      if (m) return `${String(m[nameIndex]).trim()}@L${i + 1}`
    }
  }
  return ''
}

function collectFiles(target, include, limit) {
  const out = []
  const push = (file) => {
    if (out.length < limit) out.push(file)
  }
  const stat = fs.statSync(target)
  if (stat.isFile()) {
    push(target)
    return out
  }
  const stack = [target]
  while (stack.length && out.length < limit) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (!include || include.test(entry.name)) push(full)
    }
  }
  return out
}

export function smartGrepTool(args = {}) {
  const pattern = String(args.pattern || '')
  if (!pattern) return { ok: false, error: '缺 pattern' }
  const target = args.path ? path.resolve(String(args.path)) : DEFAULT_ROOT
  if (!fs.existsSync(target)) return { ok: false, error: '路径不存在：' + target }
  const maxHits = Math.max(1, Math.min(200, Number(args.maxHits ?? 40)))
  let include = null
  if (args.include) {
    try {
      include = new RegExp(String(args.include).replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i')
    } catch {
      include = null
    }
  }
  let re
  try {
    re = new RegExp(pattern, args.ignoreCase === false ? '' : 'i')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const files = collectFiles(target, include, Number(args.maxFiles ?? 2000))
  const hits = []
  for (const file of files) {
    if (hits.length >= maxHits) break
    let content
    try {
      const stat = fs.statSync(file)
      if (stat.size > 2 * 1024 * 1024) continue
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (content.indexOf('\u0000') >= 0) continue
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < maxHits; i += 1) {
      if (!re.test(lines[i])) continue
      hits.push({ file: path.relative(target, file) || path.basename(file), line: i + 1, text: lines[i].trim().slice(0, 200), owner: ownerOf(lines, i) })
    }
  }
  const body = hits.map((h) => `${h.file}:${h.line}\t${h.owner ? '[' + h.owner + '] ' : ''}${h.text}`).join('\n')
  return {
    ok: true,
    pattern,
    files: files.length,
    hits: hits.length,
    text: clip(hits.length ? `命中 ${hits.length} 条（扫 ${files.length} 个文件）：\n${body}` : `没命中（扫 ${files.length} 个文件）`, 3500),
  }
}

/* =============================== toolbox =============================== */

export function toolboxTool(args = {}, exec = {}) {
  const slim = loadSlim()
  if (!slim || slim.enabled !== true) {
    return { ok: true, enabled: false, text: 'slim 未启用（slim.json 的 enabled=false），当前是完整工具面，不需要挂载。' }
  }
  const groups = slim.groups && typeof slim.groups === 'object' ? slim.groups : {}
  const show = String(args.show || '').trim()
  const listGroups = () =>
    Object.entries(groups)
      .map(([name, tools]) => `· ${name}（${Array.isArray(tools) ? tools.length : 0}）：${(Array.isArray(tools) ? tools : []).join(', ')}`)
      .join('\n')
  if (!show) {
    return { ok: true, enabled: true, groups: Object.keys(groups), text: `当前工具面为瘦身集合。可挂载的分组：\n${listGroups()}\n\n用法：toolbox(show="组名")，挂载后下一轮可见。` }
  }
  if (show === 'all') {
    const all = Object.values(groups).flat().filter(Boolean)
    const keys = addToScope(exec, all)
    slimLog(`[slim/toolbox] 挂载 all=${all.length} keys=${keys.join('|') || '(空)'}`)
    return { ok: true, enabled: true, mounted: all, text: `已挂载全部 ${all.length} 个工具（按需使用，本会话有效）。` }
  }
  const names = groups[show]
  if (!Array.isArray(names) || !names.length) {
    return { ok: false, error: `没有名为 ${show} 的分组`, text: `可选分组：\n${listGroups()}` }
  }
  const keys = addToScope(exec, names)
  slimLog(`[slim/toolbox] 挂载 ${show}=${names.length} keys=${keys.join('|') || '(空)'}`)
  return { ok: true, enabled: true, mounted: names, text: `已挂载 ${show}（${names.length} 个）：${names.join(', ')}。下一轮调用可见；本会话有效。` }
}

/* ============================== 定义导出 ============================== */

export function createStepSaverTools() {
  return [
    {
      name: 'run_node',
      description:
        '跑 .mjs/.js 脚本并只回尾部与落盘路径。内部注入 ELECTRON_RUN_AS_NODE=1 / PYTHONIOENCODING=utf-8，不用再手拼 powershell 前缀。用于测试脚本、一次性分析脚本、可复用工具脚本。',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: '脚本路径（绝对，或相对工作区根）' },
          args: { type: 'array', items: { type: 'string' }, description: '传给脚本的参数' },
          out: { type: 'string', description: 'stdout 落盘路径，省略自动落 _tmp/run-node-<时间戳>.txt' },
          cwd: { type: 'string', description: '工作目录，默认脚本所在目录' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' },
        },
        required: ['script'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            exitCode: { type: 'number' },
            durationMs: { type: 'number' },
            outPath: { type: 'string' },
            tail: { type: 'string' },
            note: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_a, v) => text(v?.error ? 'run_node 失败：' + v.error : `exit=${v?.exitCode} 用时 ${v?.durationMs}ms，输出已落盘 ${v?.outPath}\n${v?.tail || '(空输出)'}`),
      },
      timeoutMs: 620000,
      isConcurrencySafe: () => true,
      execute: async (args) => runNodeTool(args),
    },
    {
      name: 'ls_tree',
      description: '按深度列出目录树，只回名称与字节数（不回内容）。替代 Get-ChildItem 递归 + 手工排版，一次看清结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录，默认工作区根' },
          depth: { type: 'number', description: '深度 0-6，默认 2' },
          filter: { type: 'string', description: '文件名正则，只留匹配项（目录始终展开）' },
          limit: { type: 'number', description: '最多条目，默认 200' },
          all: { type: 'boolean', description: 'true 时连 node_modules/.git 也列' },
        },
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, error: { type: 'string' } } },
        render: (_a, v) => text(v?.error ? 'ls_tree 失败：' + v.error : v?.text || '(空目录)'),
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      execute: async (args) => lsTreeTool(args),
    },
    {
      name: 'file_outline',
      description: '只回文件骨架（函数 / 类 / 导出 / 标题 + 行号），约 200 token/文件。读文件前先用它，避免盲读整文件后再回读；确认要看某段再用 read 带 offset/limit。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, kind: { type: 'string' }, lines: { type: 'number' }, items: { type: 'array' }, text: { type: 'string' }, error: { type: 'string' } } },
        render: (_a, v) => text(v?.error ? 'file_outline 失败：' + v.error : v?.text || '(没解析出骨架)'),
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      execute: async (args) => fileOutlineTool(args),
    },
    {
      name: 'smart_grep',
      description: '正则搜内容，每条命中附所属函数/标题（owner@行号）与文件:行号。一次拿到定位信息，省掉「grep 完再 read 两次」。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则（非法正则会按纯文本处理）' },
          path: { type: 'string', description: '文件或目录，默认工作区根' },
          include: { type: 'string', description: '文件名通配，如 *.js' },
          maxHits: { type: 'number', description: '最多命中，默认 40' },
          ignoreCase: { type: 'boolean', description: '默认 true' },
        },
        required: ['pattern'],
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, hits: { type: 'number' }, files: { type: 'number' }, text: { type: 'string' }, error: { type: 'string' } } },
        render: (_a, v) => text(v?.error ? 'smart_grep 失败：' + v.error : v?.text || '(无)'),
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      execute: async (args) => smartGrepTool(args),
    },
    {
      name: 'toolbox',
      description: '把 slim 收起的分组挂回当前会话（media / system / sched / cal / rp / fin / work）。不带参数列出所有分组与工具。',
      parameters: {
        type: 'object',
        properties: {
          show: { type: 'string', description: '组名，或 all 挂全部' },
        },
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, enabled: { type: 'boolean' }, mounted: { type: 'array' }, groups: { type: 'array' }, text: { type: 'string' }, error: { type: 'string' } } },
        render: (_a, v) => text(v?.error ? 'toolbox 失败：' + v.error : v?.text || '(无)'),
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => toolboxTool(args, exec),
    },
  ]
}
