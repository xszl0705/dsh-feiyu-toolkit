/**
 * 一次性清理：把已落盘的扮演记忆 / 当前角色里的 HTML 痕迹折成纯文本。
 *
 * 为什么需要：`htmlToText` 只作用于**新加载的卡**。在它之前 cast 进记忆的条目、
 * `current.json` 里的开场白与设定，都已经带着 `<details><div style=…>` 写进盘了；
 * 提示词段每轮注入的正是这些内容，模型照样会模仿。
 *
 * 安全策略：
 *   - 默认 **dry-run**，只打印「哪个文件、多少字符含 HTML、折完什么样」；
 *   - `--apply` 才写，且先整份备份到 <记忆根>/../rp-memory-htmlfix-<时间戳>/；
 *   - 只动 `.md`、`current.json`、`session-locks.json` 之外的文件；
 *   - 折完内容不变的文件跳过（mtime 不动）。
 *
 * 用法：
 *   node tools/clean-rp-html.mjs [--root <目录>] [--apply] [--limit 5]
 */
import fs from 'node:fs'
import path from 'node:path'
import { htmlToText, hasHtmlTags } from '../lib/html-text.js'

const args = process.argv.slice(2)
const get = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const ROOT = get('--root', path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'rp-memory'))
const APPLY = args.includes('--apply')
const LIMIT = Number(get('--limit', '3')) || 3

function walk(dir, acc = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.trash') continue
      walk(p, acc)
    } else if (/\.(md|json)$/.test(entry.name)) acc.push(p)
  }
  return acc
}

const files = walk(ROOT)
const report = []
const backupDir = path.join(ROOT, '..', `rp-memory-htmlfix-${Date.now()}`)
let touched = 0
let scanned = 0

for (const file of files) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  if (!hasHtmlTags(text)) continue
  const next = file.endsWith('.json') ? cleanJson(text) : cleanMarkdown(text)
  if (next === text) continue
  touched += 1
  report.push({
    file: path.relative(ROOT, file),
    before: text.length,
    after: next.length,
    sample: htmlToText(text).slice(0, LIMIT === 0 ? 0 : 160).replace(/\n+/g, ' ⏎ '),
  })
  if (APPLY) {
    fs.mkdirSync(backupDir, { recursive: true })
    const dst = path.join(backupDir, path.relative(ROOT, file).replace(/[\\/:]/g, '_'))
    fs.writeFileSync(dst, text, 'utf8')
    fs.writeFileSync(file, next, 'utf8')
  }
}

function cleanMarkdown(text) {
  return htmlToText(text)
}

/** JSON 只清字符串值，保留结构与键名。 */
function cleanJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return htmlToText(text)
  }
  const walkValue = (value) => {
    if (typeof value === 'string') return htmlToText(value)
    if (Array.isArray(value)) return value.map(walkValue)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = walkValue(v)
      return out
    }
    return value
  }
  return JSON.stringify(walkValue(data), null, 2)
}

const lines = [
  `root=${ROOT}`,
  `mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`,
  `scanned=${scanned} 含HTML=${touched}`,
  APPLY && touched ? `backup=${backupDir}` : '',
  ...report
    .slice(0, 40)
    .map((r) => ` - ${r.file}  ${r.before} → ${r.after} 字\n   ${r.sample}`),
  report.length > 40 ? ` …还有 ${report.length - 40} 个` : '',
]
const out = lines.filter(Boolean).join('\n')
const outFile = path.join(process.cwd(), '_tmp', 'clean-rp-html.txt')
try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, out, 'utf8')
} catch {}
console.log(out)
