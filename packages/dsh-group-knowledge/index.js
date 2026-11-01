/**
 * dsh-group-knowledge — 群知识库（从 dsh-qq-adapter 抽出来）。
 *
 * 为什么单独成插件：
 *  - 群知识是 L2 世界模型，不是「QQ 渠道」的一部分；
 *  - 抽出来以后，客户端、桌宠、以后的其它渠道都能复用同一份知识；
 *  - qq 变回纯渠道，只管收发。
 *
 * 兼容策略：
 *  - 默认读同一份数据库（`~/.dsh/dafeiyu/knowledge/knowledge.db`），不搬数据；
 *  - qq 侧优先用这里的服务，拿不到再回退自己开库，不会丢功能。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from './lib/lifecycle.js'
import { KnowledgeStore } from './lib/knowledge.js'

export const name = 'dsh-group-knowledge'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_KEY = Symbol.for('dsh-group-knowledge.service')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_DB = path.join(DSH_HOME, 'dafeiyu', 'knowledge', 'knowledge.db')

const DEFAULTS = {
  enabled: true,
  dbFile: '',
  maxPerQuery: 3,
  ingestLinks: true,
  allowShared: false,
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  try {
    fs.mkdirSync(HERE, { recursive: true })
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了不影响知识库
  }
}

function state(ctx) {
  return lifecycle(ctx, () => ({
    started: false,
    store: null,
    config: null,
    lastError: '',
  }))
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const st = state(ctx)
    st.lastError = String((error && error.message) || error)
    note('apply 抛错：' + st.lastError)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  if (st.started) return
  const config = loadConfig()
  if (config.enabled === false) {
    note('配置关闭，跳过')
    return
  }
  st.started = true
  st.config = config

  const dbFile = String(config.dbFile || '').trim() || DEFAULT_DB
  try {
    st.store = new KnowledgeStore(dbFile)
  } catch (error) {
    st.lastError = String((error && error.message) || error)
    note('数据库打不开：' + st.lastError)
    return
  }
  st.own(() => {
    try {
      st.store?.close?.()
    } catch {
      // 关库失败不抛
    }
  })

  const api = {
    id: 'knowledge',
    search: (query, { limit = config.maxPerQuery, channel = '', groupId = '' } = {}) =>
      st.store.search(query, { limit, channel, groupId }),
    ingestLink: (url, { groupId = '', sourceChannel = 'qq-group' } = {}) =>
      config.ingestLinks === false ? Promise.resolve({ skipped: 'ingest-disabled' }) : st.store.ingestLink(url, { groupId, sourceChannel }),
    ingestImage: (payload = {}) => st.store.ingestImage(payload),
    stats: () => {
      try {
        const row = st.store.db.prepare('SELECT COUNT(*) AS n FROM items').get()
        return { items: Number(row?.n) || 0, dbFile }
      } catch {
        return { items: 0, dbFile }
      }
    },
    close: () => st.store?.close?.(),
  }

  try {
    if (typeof ctx.provide === 'function') ctx.provide('knowledge', api)
  } catch {
    // 宿主可能不认这个服务名
  }
  globalThis[SERVICE_KEY] = api
  st.own(() => {
    if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY]
  })

  // 把状态报给 self：条目数（不暴露路径以外的敏感信息）
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.declare?.({
      id: 'knowledge',
      package: 'dsh-group-knowledge',
      intent: '群知识库：按群作用域存储与检索群聊公开内容',
      limits: ['只收群聊公开内容', '查询必须带 groupId', '跨群共享默认关闭'],
      failureModes: [
        { code: 'KNOWLEDGE_DB_UNAVAILABLE', meaning: '数据库打不开', retry: '下次 apply 重建' },
        { code: 'NON_PUBLIC_ADDRESS', meaning: '链接指向内网/回环', retry: '拒绝' },
      ],
      scope: ['group'],
      state: () => api.stats(),
    })
  } catch {
    // self 没装也不影响知识库
  }

  note(`dsh-group-knowledge 就绪（${dbFile}）`)
  return api
}
