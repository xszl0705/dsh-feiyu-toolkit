/**
 * 会话级角色锁 —— 支持**卡组**（群聊）：一个会话可以同时挂多张卡，最多 MAX_CARDS 张。
 *
 * 兼容旧格式：v1 存的是 { file, name }（单卡），读到就转成 cards[0]。
 * 规则不变：卡组只能在本会话开局时建立，之后不能再换成别的卡；要换角色就新建会话。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'session-locks.json'
const TTL_MS = 30 * 864e5
/** 一个会话最多同场几张卡（群聊上限）。 */
export const MAX_CARDS = 4

/** 从工具 execute 的第二参拿会话 id；拿不到就返回空串（此时不锁，退化为旧行为）。 */
export function sessionIdOf(exec) {
  const tries = [
    exec?.agent?.session?.id,
    exec?.agent?.session?.sessionId,
    exec?.session?.id,
    exec?.agent?.id,
  ]
  for (const value of tries) {
    const id = String(value ?? '').trim()
    if (id) return id
  }
  return ''
}

function lockPath(root) {
  return path.join(root, FILE)
}

function readAll(root) {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

function writeAll(root, data) {
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(lockPath(root), JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 30 天没动过的锁自动清掉。 */
function prune(data) {
  const cut = Date.now() - TTL_MS
  const out = {}
  for (const [key, value] of Object.entries(data)) {
    const at = Number(value && value.at ? value.at : 0)
    if (!at || at >= cut) out[key] = value
  }
  return out
}

/** 把任意旧格式归一化成 { cards: [{file,name,rel}], scenario, at, since }。 */
function normalizeLock(raw) {
  if (!raw) return null
  const scenario = typeof raw.scenario === 'string' ? raw.scenario : ''
  if (Array.isArray(raw.cards) && raw.cards.length) {
    return { cards: raw.cards.map((c) => ({ file: String(c.file || ''), name: String(c.name || ''), rel: String(c.rel || '') })), scenario, at: raw.at, since: raw.since }
  }
  // v1：{ file, name, rel }
  if (raw.file || raw.name) {
    return { cards: [{ file: String(raw.file || ''), name: String(raw.name || ''), rel: String(raw.rel || '') }], scenario, at: raw.at, since: raw.since }
  }
  return null
}

export function getLock(root, sessionId) {
  if (!sessionId) return null
  return normalizeLock(readAll(root)[sessionId])
}

/** 往卡组里加一张；已存在返回 { ok: true, added: false }。 */
export function addCard(root, sessionId, card) {
  if (!sessionId) return { ok: false, added: false, reason: 'no-session' }
  const all = prune(readAll(root))
  const prev = normalizeLock(all[sessionId]) || { cards: [], since: new Date().toISOString() }
  const file = String(card.file || '')
  if (prev.cards.some((c) => c.file === file)) {
    return { ok: true, added: false, cards: prev.cards }
  }
  if (prev.cards.length >= MAX_CARDS) {
    return { ok: false, added: false, reason: 'full', cards: prev.cards }
  }
  prev.cards.push({ file, name: String(card.name || ''), rel: String(card.rel || '') })
  all[sessionId] = { cards: prev.cards, scenario: prev.scenario || '', at: Date.now(), since: prev.since }
  writeAll(root, all)
  return { ok: true, added: true, cards: prev.cards }
}

/** 从卡组里移除一张；卡组空了就整条删掉。 */
export function removeCard(root, sessionId, file) {
  if (!sessionId) return { ok: false, cards: [] }
  const all = prune(readAll(root))
  const prev = normalizeLock(all[sessionId])
  if (!prev) return { ok: false, cards: [] }
  const next = prev.cards.filter((c) => c.file !== String(file || ''))
  if (!next.length) {
    delete all[sessionId]
    writeAll(root, all)
    return { ok: true, cards: [], cleared: true }
  }
  all[sessionId] = { cards: next, scenario: prev.scenario || '', at: Date.now(), since: prev.since }
  writeAll(root, all)
  return { ok: true, cards: next }
}

/** 旧接口保留：整体设置成单卡（内部转成 addCard 的语义）。 */
export function setLock(root, sessionId, payload) {
  if (!sessionId) return false
  const all = prune(readAll(root))
  const prev = normalizeLock(all[sessionId])
  const card = { file: String(payload.file || ''), name: String(payload.name || ''), rel: String(payload.rel || '') }
  const cards = prev ? [...prev.cards.filter((c) => c.file !== card.file), card] : [card]
  all[sessionId] = { cards, scenario: (prev && prev.scenario) || '', at: Date.now(), since: (prev && prev.since) || new Date().toISOString() }
  return writeAll(root, all)
}

export function clearLock(root, sessionId) {
  if (!sessionId) return false
  const all = readAll(root)
  delete all[sessionId]
  return writeAll(root, all)
}

export function locksFile(root) {
  return lockPath(root)
}

/**
 * 从 agent 对象取会话 id —— 提示词段求值时宿主传进来的是 `context.agent`，
 * 不是工具 execute 的 exec，所以第一条取值链不通用。
 */
export function agentSessionId(agent) {
  const tries = [agent?.session?.id, agent?.session?.sessionId, agent?.sessionId, agent?.id]
  for (const value of tries) {
    const id = String(value ?? '').trim()
    if (id) return id
  }
  return ''
}

/**
 * 本会话的卡组（会话维度）。
 *
 * ★ 2026-11-10：提示词**不再回退全局 current.json**。以前「有没有卡」看的是
 *   全局 current，新建会话会继承上一局的卡，提示词直接说「本会话角色已定」，
 *   模型于是不挑卡、也切不动卡 —— 用户看到的就是「新会话切卡不生效」。
 *   现在：有锁 = 有卡（返回卡组），无锁 = 没卡（返回 null，走「开局先挑卡」）。
 */
export function resolveCardsFor(root, sessionId) {
  const lock = getLock(root, sessionId)
  return lock ? lock.cards : null
}

/**
 * 把背景（scenario）记到**本会话**的锁上。
 *
 * ★ 2026-11-10 修「记忆串卡」：以前 `rp_card(action=background)` 只写全局
 *   `current.json` 的 scenario 字段，下一个会话换了卡以后 scenario 还被沿用，
 *   于是提示词里出现「本会话是 A 卡，背景讲的是 B 卡」。现在背景按会话存。
 *   返回 false 表示本会话还没锁卡（调用方据此回退旧行为）。
 */
export function setScenario(root, sessionId, text) {
  if (!sessionId) return false
  const all = prune(readAll(root))
  const prev = normalizeLock(all[sessionId])
  if (!prev) return false
  all[sessionId] = { cards: prev.cards, scenario: String(text || ''), at: Date.now(), since: prev.since }
  return writeAll(root, all)
}

/** 本会话记住的背景；没有则返回 ''。 */
export function scenarioOfLock(lock) {
  return lock && typeof lock.scenario === 'string' ? lock.scenario : ''
}
