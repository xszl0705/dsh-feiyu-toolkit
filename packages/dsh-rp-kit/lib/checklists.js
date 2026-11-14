/** 清单加载：把 checklists/*.md 解析成结构化条目，供 rp_pack 打包。 */
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_ROOT } from './store.js'

export const CHECKLISTS = {
  rules: { file: 'rules.md', title: '规则书体检' },
  setting: { file: 'setting.md', title: '世界观体检' },
  outline: { file: 'outline.md', title: '副本大纲体检' },
  numbers: { file: 'numbers.md', title: '数值体检' },
}

export function loadChecklist(kind) {
  const meta = CHECKLISTS[kind]
  if (!meta) throw new Error('没有这类清单：' + kind + '（可选：' + Object.keys(CHECKLISTS).join('/') + '）')
  const full = path.join(PLUGIN_ROOT, 'checklists', meta.file)
  let text = ''
  try {
    text = fs.readFileSync(full, 'utf8')
  } catch {
    return { kind, title: meta.title, items: [], missing: true }
  }
  const items = []
  const blocks = text.split(/\n(?=##\s)/)
  for (const block of blocks) {
    const head = /^##\s+([A-Z]\d+)\s+(.+)$/m.exec(block)
    if (!head) continue
    const criteria = /\*\*判据\*\*：(.+)/.exec(block)
    const extra = /\*\*(常见病|做法|追问)\*\*：(.+)/g
    const notes = {}
    let m
    while ((m = extra.exec(block))) notes[m[1]] = m[2].trim()
    items.push({
      id: head[1],
      title: head[2].trim(),
      criteria: criteria ? criteria[1].trim() : '',
      common: notes['常见病'] || notes['做法'] || '',
      ask: notes['追问'] || '',
    })
  }
  return { kind, title: meta.title, items }
}

export function listChecklists() {
  return Object.keys(CHECKLISTS).map((kind) => {
    const cl = loadChecklist(kind)
    return { kind, title: cl.title, count: cl.items.length }
  })
}
