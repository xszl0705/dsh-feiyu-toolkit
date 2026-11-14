/**
 * dsh-rp-mode · 卡库浏览器后端（宿主侧）
 *
 * 给界面上的「选卡面板」供数据：只读列表 / 封面图 / 标签体系。
 * 三条路由，全部挂在 webServer 上，注册失败就当没有，不影响扮演模式本身。
 *
 *   GET /dsh-rp-mode/cards?q=&l1=&l2=&tag=&rating=&limit=&offset=
 *   GET /dsh-rp-mode/cover?rel=<相对路径>
 *   GET /dsh-rp-mode/meta
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOWNLOAD_CARD_ROOT, loadTagIndex } from './card.js'
import { pickerHandler } from './picker.js'

export const ROUTE_BASE = '/dsh-rp-mode'
const STATE_KEY = Symbol.for('dsh-rp-mode.webui')
const RATING_ORDER = ['sfw', 'light', 'nsfw', 'hard']

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    // 响应对象不可用就算了：面板自己会显示空态
  }
}

function toItem(row) {
  const rel = String(row.rel || '')
  const ext = path.extname(rel).toLowerCase()
  return {
    id: row.id,
    name: row.name,
    rel,
    l1: row.l1,
    l2: row.l2 || [],
    traits: row.traits || [],
    relation: row.relation || [],
    kink: row.kink || [],
    body: row.body || [],
    persona: row.persona || [],
    role: row.role || [],
    scene: row.scene || [],
    rating: row.rating,
    words: row.words,
    size_class: row.size_class,
    book: row.book,
    creator: row.creator || '',
    preview: row.preview || '',
    cover: MIME[ext] ? `${ROUTE_BASE}/cover?rel=${encodeURIComponent(rel)}` : '',
    thumb: MIME[ext] ? `${ROUTE_BASE}/cover?rel=${encodeURIComponent(rel)}&w=thumb&id=${row.id}` : '',
  }
}

/** 与命令行同一套打分：名字 > 标签 > 摘要。 */
function scoreRow(row, terms) {
  const name = String(row.name || '').toLowerCase()
  const tags = [
    ...(row.traits || []), ...(row.relation || []), ...(row.kink || []), ...(row.l2 || []), ...(row.ctags || []),
    ...(row.body || []), ...(row.persona || []), ...(row.role || []), ...(row.scene || []),
  ].join(' ').toLowerCase()
  const prev = String(row.preview || '').toLowerCase()
  let score = 0
  let hit = 0
  for (const t of terms) {
    let s = 0
    if (name.includes(t)) s += 6
    if (tags.includes(t)) s += 3
    if (prev.includes(t)) s += 1
    if (s) hit += 1
    score += s
  }
  return hit ? score : -1
}

export function queryRows(rows, params = {}) {
  const q = String(params.q || '').trim().toLowerCase()
  const terms = q.split(/[\s,，]+/).filter(Boolean)
  const l1 = String(params.l1 || '').trim()
  const wantL2 = String(params.l2 || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const wantTag = String(params.tag || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const minRating = String(params.rating || '').trim()
  const pathFilter = String(params.path || '').trim().toLowerCase()
  const limit = Math.max(1, Math.min(120, Number(params.limit) || 30))
  const offset = Math.max(0, Number(params.offset) || 0)

  const hits = []
  for (const row of rows) {
    if (l1 && row.l1 !== l1) continue
    if (wantL2.length && !wantL2.every((x) => (row.l2 || []).includes(x))) continue
    if (wantTag.length) {
      const have = new Set([
        ...(row.traits || []), ...(row.relation || []), ...(row.kink || []), ...(row.ctags || []),
        ...(row.body || []), ...(row.persona || []), ...(row.role || []), ...(row.scene || []),
      ])
      if (!wantTag.every((t) => have.has(t))) continue
    }
    if (pathFilter && !String(row.rel || '').toLowerCase().includes(pathFilter)) continue
    if (minRating) {
      const need = RATING_ORDER.indexOf(minRating)
      const got = RATING_ORDER.indexOf(String(row.rating || 'sfw'))
      if (need >= 0 && got >= 0 && got < need) continue
    }
    const score = terms.length ? scoreRow(row, terms) : 0
    if (score < 0) continue
    hits.push({ row, score })
  }

  hits.sort((a, b) => b.score - a.score || (b.row.words || 0) - (a.row.words || 0) || String(a.row.name).localeCompare(String(b.row.name)))
  return { total: hits.length, items: hits.slice(offset, offset + limit).map((h) => toItem(h.row)) }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 面板脚本：注入版，不需要 client 模块系统。 */
function panelHandler() {
  const file = path.join(HERE, 'panel.js')
  return (req, res) => {
    let body
    try {
      body = fs.readFileSync(file)
    } catch {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('panel.js missing')
      } catch {
        // ignore
      }
      return
    }
    try {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      // ignore
    }
  }
}

function cardsHandler(getIndex) {
  return (req, res) => {
    const idx = getIndex()
    if (!idx) return sendJson(res, 200, { ok: false, error: '标签索引不可用（先跑 build_index.py）', total: 0, items: [] })
    const url = new URL(req.url || '/', 'http://localhost')
    const params = Object.fromEntries(url.searchParams.entries())
    try {
      const result = queryRows(idx.rows, params)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String((error && error.message) || error), total: 0, items: [] })
    }
  }
}

function coverHandler() {
  return (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const rel = String(url.searchParams.get('rel') || '')
    const base = path.resolve(DOWNLOAD_CARD_ROOT)
    const target = path.resolve(base, rel)
    const bad = () => {
      try {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
      } catch {
        // ignore
      }
    }
    // 列表用缩略图：thumbs/<id>.webp 存在就发它，缺失回退原图
    if (url.searchParams.get('w') === 'thumb') {
      const id = String(url.searchParams.get('id') || '').replace(/[^a-f0-9]/gi, '')
      const thumbPath = path.join(base, '_cardindex', 'thumbs', id + '.webp')
      if (id && fs.existsSync(thumbPath)) {
        try {
          const st2 = fs.statSync(thumbPath)
          res.writeHead(200, {
            'content-type': 'image/webp',
            'content-length': String(st2.size),
            'cache-control': 'private, max-age=604800',
          })
          fs.createReadStream(thumbPath).pipe(res)
          return
        } catch {
          // 落到下面走原图
        }
      }
    }
    if (!rel || !target.startsWith(base + path.sep)) return bad()
    if (!MIME[path.extname(target).toLowerCase()]) return bad()
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      try {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      } catch {
        // ignore
      }
      return
    }
    try {
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()],
        'content-length': String(stat.size),
        'cache-control': 'private, max-age=86400',
      })
      fs.createReadStream(target).pipe(res)
    } catch {
      // 读取失败就让连接自己断
    }
  }
}

let metaCache = { at: 0, body: null }

/** 读某个会话的角色锁（面板用来显示「本会话已锁定《X》」）。 */
export function readLockOf(stateRoot, sessionId) {
  if (!sessionId) return null
  try {
    const file = path.join(stateRoot || path.join(os.homedir(), '.dsh', 'rp-memory'), 'session-locks.json')
    const all = JSON.parse(fs.readFileSync(file, 'utf8'))
    const one = all && all[sessionId]
    if (!one) return null
    // 兼容单卡（v1）与卡组（v2）
    const cards = Array.isArray(one.cards)
      ? one.cards.map((c) => ({ name: String(c?.name || ''), file: String(c?.file || ''), rel: String(c?.rel || '') }))
      : one.file || one.name
        ? [{ name: String(one.name || ''), file: String(one.file || ''), rel: String(one.rel || '') }]
        : []
    if (!cards.length) return null
    return { cards, name: cards[0].name, rel: cards[0].rel, file: cards[0].file, since: one.since || '' }
  } catch {
    return null
  }
}

function buildMeta() {
  {
    const body = { ok: true, root: DOWNLOAD_CARD_ROOT, levels: {}, counts: {} }
    try {
      const taxo = JSON.parse(fs.readFileSync(path.join(DOWNLOAD_CARD_ROOT, '_cardindex', 'taxonomy.json'), 'utf8'))
      body.levels = {
        l1: (taxo.l1 || []).map((x) => ({ id: x.id, label: x.label })),
        l2: (taxo.l2 || []).map((x) => ({ id: x.id, label: x.label })),
        traits: (taxo.traits || []).map((x) => x.label),
        relation: (taxo.relation || []).map((x) => x.label),
        kink: (taxo.kink || []).map((x) => x.label),
        // 六组细分标签补齐：queryRows 的 tag 参数早就按这 8 个字段匹配
        // （traits/relation/kink/ctags/body/persona/role/scene），
        // 但 meta 以前只吐 3 组，面板连渲染材料都没有 → 只能筛形态/分级/题材。
        body: (taxo.body || []).map((x) => x.label),
        persona: (taxo.persona || []).map((x) => x.label),
        role: (taxo.role || []).map((x) => x.label),
        scene: (taxo.scene || []).map((x) => x.label),
      }
    } catch {
      // 没有标签体系就只给空对象，面板会退回纯搜索
    }
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(DOWNLOAD_CARD_ROOT, '_cardindex', 'meta.json'), 'utf8'))
      body.counts = { cards: meta.cards, l1: meta.l1, rating: meta.rating, built_at: meta.built_at }
    } catch {
      // 同上
    }
    return body
  }
}

function metaHandler(lockReader) {
  return (req, res) => {
    const now = Date.now()
    const url = new URL(req.url || '/', 'http://localhost')
    const sid = String(url.searchParams.get('session') || '')
    if (!metaCache.body || now - metaCache.at >= 30000) metaCache = { at: now, body: buildMeta() }
    const body = { ...metaCache.body }
    const lock = lockReader ? lockReader(sid) : null
    if (lock) body.lock = lock
    sendJson(res, 200, body)
  }
}

/**
 * 挂路由。webServer 可能比本插件晚就绪，所以轮询等待；同进程只注册一次。
 */
export function mountRoutes(ctx, config = {}) {
  const state = (globalThis[STATE_KEY] ||= { registered: false, waiting: false, since: 0 })
  if (state.registered) return

  const tagIndexFile =
    config.tagIndexFile && String(config.tagIndexFile).trim()
      ? String(config.tagIndexFile)
      : path.join(DOWNLOAD_CARD_ROOT, '_cardindex', 'cards.jsonl')

  const getIndex = () => loadTagIndex(tagIndexFile)

  const tryRegister = () => {
    try {
      const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
      if (!webServer || typeof webServer.register !== 'function') {
        if (!state.since) state.since = Date.now()
        if (state.waiting || Date.now() - state.since > 60000) return
        state.waiting = true
        setTimeout(() => {
          state.waiting = false
          tryRegister()
        }, 250)
        return
      }
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/panel.js`, handler: panelHandler() })
      // 独立卡库页：给不加载网页版宿主的前端用（DSH Go 这类原生客户端）。
      // 纯静态 + 两条只读路由，不依赖 WebSocket，手机浏览器直接开就行。
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/picker`, handler: pickerHandler() })
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/cards`, handler: cardsHandler(getIndex) })
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/cover`, handler: coverHandler() })
      webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/meta`, handler: metaHandler((sid) => readLockOf(config.root, sid)) })
      // 页面注入：直接把面板脚本塞进 index.html，绕开 client 模块系统（那条路在 desktop 上没生效）
      try {
        if (ctx && typeof ctx.on === 'function') {
          ctx.on('webserver/index-inject', (table) => {
            table.push({ kind: 'script-src', src: `${ROUTE_BASE}/panel.js`, placement: 'body' })
          })
        }
      } catch {
        // 注入通道不可用就算了，面板会退化成只能用命令行
      }
      state.registered = true
    } catch {
      // 注册失败就当没有面板后端，宿主与扮演模式照常
    }
  }

  tryRegister()
}

/** 给测试用：直接拿一个请求处理器。 */
export const __handlers = { cardsHandler, coverHandler, metaHandler, queryRows, toItem, panelHandler, pickerHandler, readLockOf }
