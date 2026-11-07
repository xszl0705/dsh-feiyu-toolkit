/**
 * dsh-finance-learn — 金融分析 + 经济与社会知识学习。
 *
 * 两组能力共用一个底座：
 *   采集层：腾讯行情/K线/指数（插件进程可直连）、世界银行宏观（年频）
 *   知识层：概念卡 + 间隔重复（P0 用 SM-2）
 *
 * 东财 push2 系列在插件进程里 TLS 指纹被拒，本插件不碰（方案见 docs/金融分析与社科学习方案-2026-11-01.md）。
 */
import fs from 'node:fs'
import { note as kitNote } from 'dsh-plugin-kit/note'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { FinanceStore, DEFAULT_DB } from './lib/store.js'
import { createTools } from './lib/tools.js'

export const name = 'dsh-finance-learn'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SERVICE_KEY = Symbol.for('dsh-finance-learn.state')

const DEFAULTS = {
  enabled: true,
  dbFile: '',
  dueLimit: 30,
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  kitNote(HERE, message, { mkdir: true })
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

function state(ctx) {
  return lifecycle(ctx, () => ({ store: null, config: null, registered: false, waiting: false, lastError: '' }))
}

/**
 * 冷启动时 tools 服务可能还没就绪。照 dsh-naga-tools 的做法自己轮询，
 * 但同一进程只注册一次——cordis 会多次调用 apply，两路注册会撞同名工具。
 */
function registerWhenToolsReady(ctx, st, callback) {
  if (st.registered || st.waiting) return
  const started = Date.now()
  st.waiting = true
  const tick = () => {
    let tools
    try {
      tools = ctx.get?.('tools')
    } catch {
      tools = undefined
    }
    if (tools && typeof tools.register === 'function') {
      if (st.registered) return
      st.registered = true
      st.waiting = false
      try {
        callback(tools)
      } catch (error) {
        note('注册工具时抛错：' + String((error && error.message) || error))
      }
      return
    }
    if (Date.now() - started > 60000) {
      st.waiting = false
      note('60s 内没等到 tools 服务，工具未注册')
      return
    }
    st.later(tick, 250)
  }
  tick()
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const st = state(ctx)
    st.lastError = String((error && error.message) || error)
    note('apply 抛错：' + st.lastError)
    safeLog(ctx, 'warn', 'dsh-finance-learn 加载失败：' + st.lastError)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  const config = loadConfig()
  if (config.enabled === false) {
    note('配置关闭，跳过')
    return undefined
  }
  st.config = config

  const dbFile = String(config.dbFile || '').trim() || DEFAULT_DB
  try {
    st.store = new FinanceStore(dbFile)
  } catch (error) {
    st.lastError = String((error && error.message) || error)
    note('数据库打不开：' + st.lastError)
    return undefined
  }
  st.own(() => st.store?.close?.())

  registerWhenToolsReady(ctx, st, (tools) => {
    const definitions = createTools(st.store)
    const registerAll = () => {
      const handles = []
      for (const definition of definitions) {
        try {
          handles.push(tools.register(definition))
        } catch (error) {
          note('注册工具失败 ' + definition.name + '：' + String((error && error.message) || error))
        }
      }
      return () => {
        for (const handle of handles) {
          try {
            handle?.dispose?.()
          } catch {
            // 卸载失败不影响禁用
          }
        }
      }
    }
    if (typeof ctx.effect === 'function') ctx.effect(registerAll)
    else registerAll()
    note(`dsh-finance-learn: ${definitions.length} 个工具已注册（pid ${process.pid}，db ${dbFile}）`)
    safeLog(ctx, 'info', `dsh-finance-learn ready（${definitions.length} 个工具）`)
  })

  const api = {
    id: 'finance-learn',
    stats: () => {
      try {
        return { ...st.store.reviewStats(), dbFile }
      } catch {
        return { total: 0, due: 0, learned: 0, dbFile }
      }
    },
    close: () => st.store?.close?.(),
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('finance-learn', api)
  } catch {
    // 宿主可能不认这个服务名
  }
  globalThis[SERVICE_KEY] = api
  st.own(() => {
    if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY]
  })

  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.declare?.({
      id: 'finance-learn',
      package: 'dsh-finance-learn',
      intent: '行情/K线/指数/宏观查询，以及概念卡的间隔重复复习',
      inputs: ['symbol', 'period', 'card-title', 'rating'],
      outputs: ['quote', 'kline', 'index', 'macro', 'card', 'review-schedule'],
      limits: ['不提供投资建议', '不预测价格', '数据来自腾讯财经/世界银行，可能延迟', '宏观数据为世界银行年频，滞后约一年'],
      failureModes: [
        { code: 'UPSTREAM_TIMEOUT', meaning: '8s 内没返回', retry: '回退上次缓存并标注可能过期' },
        { code: 'NO_BARS', meaning: '代码有误或该市场无数据', retry: '不重试，报错' },
      ],
      scope: ['owner'],
      state: () => api.stats(),
    })
  } catch {
    // self 没装不影响工具
  }

  note('dsh-finance-learn 就绪（' + dbFile + '）')
  return api
}
