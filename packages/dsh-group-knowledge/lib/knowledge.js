/**
 * 本地群知识库：SQLite + FTS5。
 * 只收群聊公开内容；与私有记忆库分开。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { publicDownload } from './public-download.js'

const BASE = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_DB = path.join(BASE, 'dafeiyu', 'knowledge', 'knowledge.db')

function hashOf(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function trimText(value, limit = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

// 中文切二字 + 拉丁词原样保留。写入与查询必须用同一套切分，否则对不上。
function bigramOf(value, max = 8000) {
  const text = String(value || '')
  const out = []
  for (const word of text.toLowerCase().match(/[a-z0-9_\-]{2,}/g) || []) out.push(word)
  for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return [...new Set(out)].slice(0, max)
}

export class KnowledgeStore {
  constructor(file = DEFAULT_DB) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        source_channel TEXT NOT NULL DEFAULT '',
        group_id TEXT NOT NULL DEFAULT '',
        media_path TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        entities TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        hash TEXT NOT NULL UNIQUE,
        tokens TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL DEFAULT '',
        use_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
      CREATE INDEX IF NOT EXISTS idx_items_channel ON items(source_channel);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        title, summary, content, tags,
        content='items', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
        INSERT INTO items_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;
      CREATE TABLE IF NOT EXISTS audit (
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        item_id TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );
    `)
    this.migrateTokens()
  }

  // 中文二字索引（bigram）。unicode61 会把整段中文当成一个 token，
  // 2 字查询永远 0 命中；trigram 又要求 MATCH ≥3 字符。bigram 两边的坑都躲开。
  migrateTokens() {
    const cols = this.db.prepare("SELECT name FROM pragma_table_info('items')").all().map((r) => r.name)
    if (!cols.includes('tokens')) {
      this.db.exec("ALTER TABLE items ADD COLUMN tokens TEXT NOT NULL DEFAULT ''")
    }
    // 先补 tokens 再建触发器：否则 UPDATE 会去删一条还没进索引的行，FTS5 会坏
    const pending = this.db.prepare("SELECT rowid, title, summary, content, tags FROM items WHERE tokens = ''").all()
    if (pending.length) {
      const upd = this.db.prepare('UPDATE items SET tokens = ? WHERE rowid = ?')
      for (const row of pending) {
        upd.run(bigramOf([row.title, row.summary, row.content, row.tags].join(' ')).join(' '), row.rowid)
      }
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts_b USING fts5(
        tokens, content='items', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS items_b_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts_b(rowid, tokens) VALUES (new.rowid, new.tokens);
      END;
      CREATE TRIGGER IF NOT EXISTS items_b_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts_b(items_fts_b, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
      END;
      CREATE TRIGGER IF NOT EXISTS items_b_au AFTER UPDATE ON items BEGIN
        INSERT INTO items_fts_b(items_fts_b, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
        INSERT INTO items_fts_b(rowid, tokens) VALUES (new.rowid, new.tokens);
      END;
    `)
    try {
      this.db.exec("INSERT INTO items_fts_b(items_fts_b) VALUES('rebuild')")
    } catch {
      // 外部内容表重建失败不影响主表；查询会回退到老索引 / LIKE
    }
  }

  add({ kind = 'note', title = '', summary = '', content = '', sourceUrl = '', sourceChannel = 'qq-group', groupId = '', mediaPath = '', tags = '', entities = '', confidence = 0.5 } = {}) {
    const hash = hashOf([sourceChannel, groupId, kind, sourceUrl, title, summary, content].join('\n'))
    const existing = this.db.prepare('SELECT id FROM items WHERE hash = ?').get(hash)
    if (existing?.id) return { id: String(existing.id), inserted: false }
    const id = `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO items (id, kind, title, summary, content, source_url, source_channel, group_id, media_path, tags, entities, confidence, hash, tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(kind || 'note'),
      trimText(title, 200),
      trimText(summary, 600),
      trimText(content, 8000),
      String(sourceUrl || ''),
      String(sourceChannel || ''),
      String(groupId || ''),
      String(mediaPath || ''),
      trimText(tags, 300),
      trimText(entities, 300),
      Math.max(0, Math.min(1, Number(confidence) || 0.5)),
      hash,
      bigramOf([title, summary, content, tags, entities].join(' ')).join(' '),
      now,
    )
    this.db.prepare('INSERT INTO audit (at, action, item_id, detail) VALUES (?, ?, ?, ?)').run(now, 'add', id, `${kind}:${title.slice(0, 80)}`)
    return { id, inserted: true }
  }

  search(query, { limit = 5, channel = '', groupId = '' } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const max = Math.max(1, Math.min(20, Number(limit) || 5))
    // Fail closed: group knowledge always requires a concrete group scope.
    if (channel === 'qq-group' && !String(groupId)) return []
    const channelSql = (channel ? ' AND i.source_channel = ?' : '') + ' AND i.group_id = ?'
    const channelArg = [...(channel ? [channel] : []), String(groupId)]
    const terms = (q.match(/[\p{L}\p{N}_-]{1,}/gu) || []).slice(0, 8)
    const tokens = bigramOf(q, 12)
    let rows = []
    // 先走二字索引：先 AND（精度优先），不够再 OR（召回优先）
    const matchBigram = (joiner) => this.db.prepare(`
      SELECT i.* FROM items_fts_b f JOIN items i ON i.rowid = f.rowid
      WHERE items_fts_b MATCH ?${channelSql}
      ORDER BY rank LIMIT ?
    `).all(tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(joiner), ...channelArg, max)
    if (tokens.length) {
      try {
        rows = matchBigram(' AND ')
      } catch {
        rows = []
      }
      if (!rows.length) {
        try {
          rows = matchBigram(' OR ')
        } catch {
          rows = []
        }
      }
    }
    // 老索引兜底（英文/代码词仍然好用）
    if (!rows.length && terms.length) {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
      try {
        rows = this.db.prepare(`
          SELECT i.* FROM items_fts f JOIN items i ON i.rowid = f.rowid
          WHERE items_fts MATCH ?${channelSql}
          ORDER BY rank LIMIT ?
        `).all(ftsQuery, ...channelArg, max)
      } catch {
        rows = []
      }
    }
    if (!rows.length) {
      rows = this.db.prepare(`
        SELECT i.* FROM items i
        WHERE (i.title LIKE ? OR i.summary LIKE ? OR i.content LIKE ? OR i.tags LIKE ?)${channelSql}
        ORDER BY i.created_at DESC LIMIT ?
      `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, ...channelArg, max)
    }
    for (const row of rows) {
      try {
        this.db.prepare('UPDATE items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?').run(new Date().toISOString(), row.id)
      } catch {
        // ignore
      }
    }
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      text: trimText([row.title, row.summary, row.content].filter(Boolean).join(' / '), 300),
      source_url: row.source_url,
      confidence: row.confidence,
    }))
  }

  async ingestLink(url, { groupId = '', sourceChannel = 'qq-group' } = {}) {
    const rawUrl = String(url || '').trim()
    if (!/^https?:\/\//i.test(rawUrl)) return { inserted: false, reason: 'bad-url' }
    try {
      const res = await publicDownload(rawUrl, { maxBytes: 500000, timeoutMs: 15000 })
      const html = res.bytes.toString('utf8')
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').trim()
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || '').trim()
      return this.add({
        kind: 'web',
        title: title || rawUrl,
        summary: desc || title || rawUrl,
        content: desc,
        sourceUrl: rawUrl,
        sourceChannel,
        groupId,
        confidence: title || desc ? 0.7 : 0.35,
      })
    } catch (error) {
      return this.add({
        kind: 'web',
        title: rawUrl,
        summary: '抓取失败，仅保留链接',
        sourceUrl: rawUrl,
        sourceChannel,
        groupId,
        confidence: 0.2,
      })
    }
  }

  ingestImage({ url = '', caption = '', groupId = '', mediaPath = '', sourceChannel = 'qq-group' } = {}) {
    if (!url && !caption) return { inserted: false, reason: 'empty-image' }
    return this.add({
      kind: 'image',
      title: caption ? trimText(caption, 80) : '群图片',
      summary: trimText(caption, 600),
      content: trimText(caption, 4000),
      sourceUrl: String(url || ''),
      sourceChannel,
      groupId,
      mediaPath,
      confidence: caption ? 0.65 : 0.3,
    })
  }

  stats() {
    const items = this.db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n || 0
    const byKind = this.db.prepare('SELECT kind, COUNT(*) AS n FROM items GROUP BY kind').all()
    return { file: this.file, items, byKind }
  }

  close() {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

export function extractUrls(text) {
  const out = []
  const value = String(text || '')
  const re = /https?:\/\/[^\s<>"'）)】。，；、！？]+/gi
  let match
  while ((match = re.exec(value))) {
    const url = match[0].replace(/[.,;!?]+$/, '')
    if (!out.includes(url)) out.push(url)
  }
  return out.slice(0, 3)
}
