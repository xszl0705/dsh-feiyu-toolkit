/** 世界问卷：把 templates/world-questionnaire.md 解析成 18 组问题，按需出题。 */
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_ROOT } from './store.js'

let cache = null

export function loadGroups() {
  if (cache) return cache
  const file = path.join(PLUGIN_ROOT, 'templates', 'world-questionnaire.md')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const groups = []
  for (const block of text.split(/\n(?=##\s)/)) {
    const head = /^##\s+(\d+)\.\s+(.+)$/m.exec(block)
    if (!head) continue
    const questions = []
    for (const line of block.split('\n')) {
      const q = /^(\d+)\.\s+(.+)$/.exec(line.trim())
      if (q) questions.push({ no: Number(q[1]), text: q[2].trim() })
    }
    if (questions.length) groups.push({ id: Number(head[1]), title: head[2].trim(), questions })
  }
  cache = groups
  return groups
}

export function listGroups() {
  return loadGroups().map((g) => ({ id: g.id, title: g.title, count: g.questions.length }))
}

/** 出一组题：limit 控制数量，避免一次砸 300 个问题。 */
export function pickQuestions(groupId, limit = 5, offset = 0) {
  const groups = loadGroups()
  const group = groups.find((g) => g.id === Number(groupId))
  if (!group) throw new Error('没有第 ' + groupId + ' 组（可用 1-' + groups.length + '）')
  const start = Math.max(0, Number(offset) || 0)
  const n = Math.max(1, Math.min(20, Number(limit) || 5))
  return { id: group.id, title: group.title, total: group.questions.length, questions: group.questions.slice(start, start + n) }
}
