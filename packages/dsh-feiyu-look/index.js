/**
 * dsh-feiyu-look — 宿主半侧
 *
 * 只做一件事：把「我现在什么状态」聚合成一个只读 JSON，供页面上方那条状态条用。
 * 不注册工具、不改提示词、不碰会话；任何一项读不到就给 null，绝不让宿主崩。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export const name = 'dsh-feiyu-look'

const require = createRequire(import.meta.url)
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const ROUTE = '/dsh-feiyu-look/state'
const CACHE_MS = 5000
const STATE_KEY = Symbol.for('dsh-feiyu-look.state')

const MEMORY_DB = path.join(DSH_HOME, 'dsh-memory-unified', 'memory.db')
const KNOWLEDGE_DB = path.join(DSH_HOME, 'dafeiyu', 'knowledge', 'knowledge.db')
const MOOD_FILE = path.join(DSH_HOME, 'feiyu-mood', 'state.json')
const PET_FILE = path.join(DSH_HOME, 'pet-hub-status.json')
const SKILL_ROOT = path.join(DSH_HOME, 'skills')

let cache = { at: 0, body: null }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 只读打开一次 SQLite 拿个计数；失败返回 null（不猜、不补 0）。 */
function sqliteCount(file, sql) {
  if (!fs.existsSync(file)) return null
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare(sql).get()
      return row === undefined ? null : Number(row.c)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function moodState() {
  const raw = readJson(MOOD_FILE)
  const one = raw && raw.moods ? raw.moods.__default__ : null
  if (!one) return null
  return {
    value: Math.round(Number(one.mood ?? 0)),
    reason: String(one.lastReason || ''),
    at: Number(one.updatedAt || 0),
  }
}

function petState() {
  const raw = readJson(PET_FILE)
  const pet = raw && raw.pet ? raw.pet : null
  if (!pet) return null
  return { running: Boolean(pet.running), pid: pet.pid ?? null, form: pet.form || null }
}

function skillCount() {
  try {
    if (!fs.existsSync(SKILL_ROOT)) return 0
    let n = 0
    for (const entry of fs.readdirSync(SKILL_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(SKILL_ROOT, entry.name, 'SKILL.md'))) n += 1
      else if (entry.isFile() && entry.name.endsWith('.md')) n += 1
    }
    return n
  } catch {
    return null
  }
}

/** 聚合当前状态（5 秒缓存）。导出给测试直接用。 */
export function collectState() {
  const now = Date.now()
  if (cache.body && now - cache.at < CACHE_MS) return cache.body
  const memory = sqliteCount(MEMORY_DB, "SELECT count(*) AS c FROM memories WHERE status = 'active'")
  const knowledge = sqliteCount(KNOWLEDGE_DB, 'SELECT count(*) AS c FROM items')
  const body = {
    at: new Date().toISOString(),
    mood: moodState(),
    memory: memory === null ? null : { items: memory },
    knowledge: knowledge === null ? null : { items: knowledge },
    skills: skillCount(),
    pet: petState(),
  }
  cache = { at: now, body }
  return body
}

function handler(req, res) {
  let body
  try {
    body = JSON.stringify(collectState())
  } catch (error) {
    body = JSON.stringify({ ok: false, error: String((error && error.message) || error) })
  }
  try {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    // 响应对象不可用时什么都不做：状态条拉不到数据就会自己隐藏
  }
}

/** 插件入口：等 webServer 就绪后挂一条只读路由。任何异常都在这里吃掉。 */
export function apply(ctx) {
  const st = (globalThis[STATE_KEY] ||= { registered: false, since: 0, waiting: false })
  if (st.registered) return

  const tryRegister = () => {
    try {
      const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
      if (!webServer || typeof webServer.register !== 'function') {
        if (!st.since) st.since = Date.now()
        if (st.waiting) return
        if (Date.now() - st.since > 60000) return
        st.waiting = true
        setTimeout(() => {
          st.waiting = false
          tryRegister()
        }, 250)
        return
      }
      webServer.register({ kind: 'exact', path: ROUTE, handler })
      st.registered = true
    } catch {
      // 注册失败就当没有这条路由，宿主照常跑
    }
  }

  tryRegister()
}
