/** 体检报告渲染：问题台账 + 覆盖情况 + 下一步。 */
import fs from 'node:fs'
import path from 'node:path'
import { ALL_KINDS, listSources, projectDir, readIssues } from './store.js'
import { CHECKLISTS, loadChecklist } from './checklists.js'

const SEVERITY_ORDER = ['blocker', 'major', 'minor', 'nit']
const SEVERITY_LABEL = { blocker: '阻断', major: '重要', minor: '次要', nit: '文字' }
const STATUS_LABEL = { open: '未处理', accepted: '已采纳', rejected: '已驳回', fixed: '已修复' }

function ymd(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate())
}

export function buildReport(name, config) {
  const issues = readIssues(name, config)
  const bySeverity = SEVERITY_ORDER.map((s) => ({ s, list: issues.filter((i) => i.severity === s) }))
  const open = issues.filter((i) => i.status === 'open')
  const lines = []
  lines.push('# ' + name + ' 体检报告 · ' + ymd())
  lines.push('')
  lines.push('## 概览')
  lines.push('')
  lines.push('| 项 | 数量 |')
  lines.push('|---|---|')
  for (const kind of ALL_KINDS) {
    const n = listSources(name, kind, config).length
    if (n) lines.push('| ' + (CHECKLISTS[kind]?.title || kind) + ' 源文 | ' + n + ' 章 |')
  }
  lines.push('| 问题合计 | ' + issues.length + ' 条（未处理 ' + open.length + '） |')
  for (const { s, list } of bySeverity) if (list.length) lines.push('| ' + SEVERITY_LABEL[s] + ' | ' + list.length + ' |')
  lines.push('')

  lines.push('## 待处理问题')
  lines.push('')
  const shown = open.length ? open : issues
  if (!shown.length) lines.push('（还没有记录任何问题）')
  const grouped = {}
  for (const issue of shown) (grouped[issue.category] || (grouped[issue.category] = [])).push(issue)
  for (const [category, list] of Object.entries(grouped)) {
    lines.push('### ' + category)
    lines.push('')
    for (const issue of list) {
      lines.push('- **' + issue.id + '** [' + SEVERITY_LABEL[issue.severity] + '·' + STATUS_LABEL[issue.status] + '] ' + issue.problem)
      if (issue.location) lines.push('  - 位置：' + issue.location)
      if (issue.quote) lines.push('  - 原文：' + issue.quote.replace(/\n/g, ' '))
      if (issue.suggestion) lines.push('  - 建议：' + issue.suggestion)
    }
    lines.push('')
  }

  lines.push('## 清单覆盖')
  lines.push('')
  for (const kind of Object.keys(CHECKLISTS)) {
    const cl = loadChecklist(kind)
    const touched = new Set(issues.filter((i) => i.category === kind || i.category === cl.title).map((i) => i.check))
    lines.push('- ' + cl.title + '：' + (touched.size ? touched.size + '/' + cl.items.length + ' 项已审' : cl.items.length + ' 项，尚未开审'))
  }
  lines.push('')
  lines.push('## 下一步')
  lines.push('')
  if (bySeverity[0].list.filter((i) => i.status === 'open').length) {
    lines.push('1. 先处理阻断项，它们会导致开不了团。')
  }
  if (open.length) lines.push('2. 按「重要 → 次要」顺序改，改完用 rp_issue 标 fixed。')
  lines.push('3. 改完重新 rp_pack 复审，只关注未关闭项。')
  return lines.join('\n')
}

export function writeReport(name, config) {
  const text = buildReport(name, config)
  const dir = path.join(projectDir(name, config), 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, ymd() + '.md')
  fs.writeFileSync(file, text, 'utf8')
  return { file, text }
}

export function summarize(issues) {
  const counts = {}
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] || 0) + 1
  return counts
}
