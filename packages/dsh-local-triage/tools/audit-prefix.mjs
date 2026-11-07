/**
 * 前缀缓存审计：静态扫描插件源码，找出会摧毁 prompt 前缀缓存的写法。
 *
 * 缓存只认"从第 0 个 token 起的相同前缀"。所以任何在稳定段里塞
 * 时间戳 / UUID / 随机序 / 每轮变化内容的写法，都会让整段缓存失效。
 *
 * 这是**静态启发式**，输出的是"候选清单"，需要人看一眼确认；
 * 目的不是全自动判定，而是把容易漏的地方一次性列出来。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "E:\dsh\DeepSeek Harness.exe" tools\audit-prefix.mjs
 * 输出：reports/prefix-audit.json + reports/prefix-audit.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')          // dsh-plugins/
const OUT_DIR = path.join(HERE, '..', 'reports')

const SKIP_DIRS = new Set([
  'node_modules', '_backups', '_backup', '_debug', '_tmp', '_thirdparty',
  '_refs', '_pets', '_voice', '_acl-recovery', 'reports', 'dist', 'build',
])
const EXT = new Set(['.js', '.mjs', '.cjs'])

// 看起来在组装提示词的文件/行
const PROMPT_HINT = /(systemPrompt|SYSTEM_PROMPT|system_prompt|人设|persona|instructions?|messages\s*[:=])/i
// 每次调用都会变的信号
const VOLATILE = /(Date\.now\(\)|new Date\(|toISOString\(\)|Math\.random\(\)|randomUUID\(\)|uuid\(\)|crypto\.randomUUID)/

const RULES = [
  {
    id: 'timestamp-in-prompt',
    level: 'high',
    title: '时间戳/UUID 出现在提示词附近',
    test: (line) => VOLATILE.test(line),
    near: (ctx) => ctx.some((l) => PROMPT_HINT.test(l)),
    advice: '挪到 user 消息或工具结果里；系统提示一旦含时间戳，每次请求都 miss。',
  },
  {
    id: 'random-shuffle',
    level: 'high',
    title: '随机打乱顺序',
    test: (line) => /Math\.random\(\)/.test(line) && /(sort|shuffle|reverse)/i.test(line),
    advice: '顺序必须是确定的，否则前缀不稳定。改成按固定 key 排序。',
  },
  {
    id: 'volatile-into-system',
    level: 'high',
    title: '每轮变化的内容拼进了 system',
    test: (line) => /(system|SYSTEM)/.test(line) && /\$\{?(mem|memory|context|retrieved|history|time|now)/i.test(line),
    advice: '把动态段（记忆/检索/历史）放到 system 之后，进 user 段。',
  },
  {
    id: 'memory-in-persona',
    level: 'medium',
    title: '记忆块拼在人设/系统提示里',
    test: (line) => /(persona|人设|IDENTITY|identity)/i.test(line) && /(memory|记忆|recall|notes)/i.test(line),
    advice: '人设要稳定；记忆另起一段放在后面。人设里混记忆 = 每轮前缀都变。',
  },
  {
    id: 'dynamic-tool-order',
    level: 'medium',
    title: '工具列表可能顺序不固定',
    test: (line) => /(Object\.keys|Object\.entries|new Set\()/.test(line) && /(tools?|工具)/i.test(line),
    advice: '工具定义顺序必须固定（不要依赖对象遍历序或 Set 插入序）。',
  },
  {
    id: 'per-request-greeting',
    level: 'low',
    title: '时间相关问候可能进提示词',
    test: (line) => /(早上好|凌晨|上午|下午|晚上好|今天是)/.test(line),
    advice: '问候语若含当前时间，会随分钟变化；确认它是否在稳定段。',
  },
]

function walk(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out)
    } else if (EXT.has(path.extname(e.name))) {
      // 测试与文档里的时间戳不会进生产提示词，扫描时排除，避免刷屏
      const rel = path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, '/')
      if (/(^|\/)(tests?|docs|tools|eval|scripts)\//.test(rel)) continue
      if (/\.test\.mjs$|\.test\.js$|\.spec\.js$/.test(rel)) continue
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

function main() {
  const files = walk(ROOT)
  const findings = []
  let scanned = 0

  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scanned += 1
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.length > 500) continue        // 压缩过的一行代码，跳过
      for (const rule of RULES) {
        if (!rule.test(line)) continue
        if (rule.near) {
          const ctx = lines.slice(Math.max(0, i - 6), i + 7)
          if (!rule.near(ctx)) continue
        }
        findings.push({
          rule: rule.id,
          level: rule.level,
          title: rule.title,
          advice: rule.advice,
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        })
      }
    }
  }

  // 同一规则同一文件只留前 3 条，避免刷屏
  const perFileRule = new Map()
  const kept = findings.filter((f) => {
    const key = `${f.file}::${f.rule}`
    const n = (perFileRule.get(key) || 0) + 1
    perFileRule.set(key, n)
    return n <= 3
  })

  const byRule = {}
  const byLevel = { high: 0, medium: 0, low: 0 }
  for (const f of kept) {
    byRule[f.rule] = (byRule[f.rule] || 0) + 1
    byLevel[f.level] = (byLevel[f.level] || 0) + 1
  }

  const md = []
  md.push('# 前缀缓存审计报告')
  md.push('')
  md.push(`扫描：${scanned} 个文件，命中 ${kept.length} 条（去重前 ${findings.length} 条）`)
  md.push(`分布：high ${byLevel.high} / medium ${byLevel.medium} / low ${byLevel.low}`)
  md.push('')
  if (!kept.length) {
    md.push('没有发现高危写法。')
  } else {
    md.push('| 级别 | 规则 | 位置 | 片段 |')
    md.push('|---|---|---|---|')
    for (const f of kept.sort((a, b) => a.level.localeCompare(b.level))) {
      md.push(`| ${f.level} | ${f.title} | ${f.file}:${f.line} | \`${f.snippet.replace(/\|/g, '\\|')}\` |`)
    }
    md.push('')
    md.push('## 处置建议')
    const seen = new Set()
    for (const f of kept) {
      if (seen.has(f.rule)) continue
      seen.add(f.rule)
      md.push(`- **${f.title}**（${f.rule}）：${f.advice}`)
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'prefix-audit.json'), JSON.stringify({ scanned, kept, raw: findings.length }, null, 2), 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'prefix-audit.md'), md.join('\n') + '\n', 'utf8')
  process.exit(0)
}

main()
