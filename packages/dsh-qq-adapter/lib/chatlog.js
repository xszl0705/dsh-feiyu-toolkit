/**
 * 渠道对话留痕：与桌宠共用 ~/.dsh/pet-diary/chats/YYYY-MM-DD.jsonl，
 * 只多一个 channel 值与目标信息，方便 chatlog_read 统一回看。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function pad(n) {
  return String(n).padStart(2, '0')
}

export function appendChat({ channel = 'qq', moment = '', text, model = '', target = '' }) {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(base, 'pet-diary', 'chats')
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date()
  const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const line = JSON.stringify({
    at: now.toISOString(),
    channel,
    moment,
    text,
    model,
    target: String(target || ''),
  })
  fs.appendFileSync(path.join(dir, `${key}.jsonl`), line + '\n', 'utf8')
  return { key }
}
