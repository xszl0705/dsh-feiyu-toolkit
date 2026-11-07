import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { toolsOrRetry } from 'dsh-plugin-kit/wait-for-tools'
import { note as kitNote } from 'dsh-plugin-kit/note'
/**
 * dsh-memory-unified — 宿主入口
 *
 * 一句话：工具优先、存储自理、绝不改写你的上下文。
 *   - 5 个工具：remember / search / related / digest / judge
 *   - 存储：~/.dsh/dsh-memory-unified（纯 JSON，可备份、可 diff）
 *   - 自动召回：config.autoRecall=true 且宿主暴露 systemPrompt 服务时才挂，否则静默跳过
 *
 * 为什么和旧版（fork dsh-rofm 的 0.1）不一样：
 *   0.1 把「存档 + 压缩 + 自动注入」全做了，和 engram / graph-memory 抢同一个上下文写入口；
 *   这次只保留显式工具，先把「记得住、搜得到」跑稳，自动注入等有宿主 API 再谈。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MemoryStore, defaultStoreDir } from './lib/store.js'
import { SqliteStore, sqliteReady } from './lib/sqlite-store.js'
import { createMemoryTools } from './lib/tools.js'
import { installMemoryService } from './lib/service.js'

export const name = 'dsh-memory-unified'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  storeDir: '',
  store: 'sqlite',
  autoRecall: false,
  recallLimit: 3,
  maxItemsPerFolder: 200,
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 选后端：优先 SQLite，初始化失败或无 node:sqlite 时回退 JSON（插件绝不能因此加载失败）。 */
function createStore(config) {
  const dir = config.storeDir || undefined
  const kind = String(config.store || 'sqlite').toLowerCase()
  if (kind === 'sqlite') {
    if (!sqliteReady()) {
      note('当前 Node 无 node:sqlite，回退 JSON 存储')
    } else {
      try {
        const target = dir || defaultStoreDir()
        const store = new SqliteStore(target)
        store.open()
        // 增量补齐：只补 JSON 里有、库里没有的 id（已删除/已失效的 id 不会被复活）
        const migration = store.migrateFromJson({ force: true })
        if (!migration.skipped && migration.migrated > 0) {
          note(`已从 JSON 导入 ${migration.migrated} 条到 SQLite`)
        }
        note(`存储后端 sqlite（${target}）`)
        return store
      } catch (error) {
        note('SQLite 初始化失败，回退 JSON：' + String((error && error.message) || error))
      }
    }
  }
  note('存储后端 json')
  return new MemoryStore(dir)
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

function note(message) {
  kitNote(HERE, message)
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-memory-unified 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

const STATE_KEY = Symbol.for('dsh-memory-unified.state')

function state(ctx) { return lifecycle(ctx, () => ({ registered: false, waiting: false, autoStarted: false, since: 0 })) }

/** 把运行时状态报给 self：只给条数，不暴露存储路径。 */
function declareSelf(ctx, memoryApi) {
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare !== 'function') return
    self.declare({
      id: 'memory',
      package: 'dsh-memory-unified',
      intent: '长期记忆：写入、检索、去重、软删除、体检、导入导出',
      limits: ['敏感内容在写入边界直接拒绝', '没有任何词面命中时返回空，不硬凑', '只记录明确交代的事实'],
      failureModes: [
        { code: 'MEMORY_SENSITIVE', meaning: '命中敏感规则被拒', retry: '不重试' },
        { code: 'MEMORY_EMPTY', meaning: '文本为空', retry: '不重试' },
      ],
      scope: ['owner'],
      state: () => {
        const stats = memoryApi.stats() || {}
        return { folders: stats.folders || 0, items: stats.items || 0, archived: stats.archived || 0 }
      },
    })
  } catch {
    // self 没装也不影响记忆
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  if (st.registered) return
  const config = loadConfig()
  const store = st.store ||= createStore(config)
  if (!st.storeOwned) { st.storeOwned = true; st.own(() => store.close?.()) }

  // 服务化：其它插件通过 ctx.get('memory') 或全局 symbol 拿同一份 store。
  const memoryApi = {
    search: (query, options = {}) => store.search(query, { limit: 5, ...options }),
    remember: (item = {}) =>
      store.addItem({
        folderName: item.folder || '未命名',
        text: item.text,
        keywords: item.keywords || [],
        importance: item.importance ?? 0.5,
        category: item.category || 'general',
        visibility: item.visibility || 'private',
        maxItems: config.maxItemsPerFolder || 200,
      }),
    digest: (limit = 3) => {
      const folders = store.allFolders()
      return folders.map((folder) => ({
        folder: folder.name,
        count: folder.items?.length || 0,
        items: (folder.items || []).slice(0, limit),
      }))
    },
    stats: () => store.stats(),
    allFolders: () => store.allFolders(),
    source: 'dsh-memory-unified',
  }
  if (!st.serviceInstalled) {
    st.serviceInstalled = true
    installMemoryService(ctx, memoryApi)
    st.own(() => { if (globalThis[Symbol.for('dsh-memory-unified.service')] === memoryApi) delete globalThis[Symbol.for('dsh-memory-unified.service')] })
    declareSelf(ctx, memoryApi)
  }

  // —— 本机读取口鉴权 ——
  // 同源校验挡浏览器跨站；route-token 挡本机其它进程（桌宠读同一个 token 文件后带 header）。
  const tokenFile = () =>
    process.env.DSH_ROUTE_TOKEN_FILE || path.join(os.homedir(), '.dsh', 'dafeiyu', 'route-token')
  const routeToken = () => {
    const file = tokenFile()
    try {
      const tok = fs.readFileSync(file, 'utf8').trim()
      if (tok) return tok
    } catch {}
    try {
      const tok = crypto.randomBytes(24).toString('hex')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, tok, { mode: 0o600 })
      return tok
    } catch {
      return ''
    }
  }
  const routeAuthorized = (req) => {
    const host = String(req.headers?.host || '')
    const origin = String(req.headers?.origin || '')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return false
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false
    const expected = routeToken()
    return !!expected && String(req.headers?.['x-dafeiyu-token'] || '') === expected
  }

  // 给非 JS 渠道（桌宠 Python）用的只读检索口。
  // 鉴权：只放行本机同源 + 带 route-token 的调用（token 落在 ~/.dsh/dafeiyu/route-token）。
  const routeHandler = (req, res) => {
    if (!routeAuthorized(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
      return
    }
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const query = url.searchParams.get('q') || ''
      const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 5))
      // 默认只返回公开档：这个口给桌宠/QQ 这类外部消费方读，私密档要显式要（?visibility=private|all）
      const want = String(url.searchParams.get('visibility') || 'public').toLowerCase()
      const visibility = want === 'all' ? '' : want === 'private' ? 'private' : 'public'
      const hits = query ? memoryApi.search(query, { limit, visibility }) : []
      const body = JSON.stringify({
        ok: true,
        hits: hits.map((hit) => ({
          text: hit.text,
          folder: hit.folder,
          score: hit.score,
          importance: hit.importance,
        })),
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
    }
  }
  const mountRoute = () => {
    try {
      const webServer = ctx.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        if (!st.routeSince) st.routeSince = Date.now()
        if (Date.now() - st.routeSince < 60000 && !st.routeWaiting) { st.routeWaiting = true; st.later(() => { st.routeWaiting = false; mountRoute() }, 250) }
        return
      }
      if (st.webServer === webServer) return
      st.own(webServer.register({ kind: 'exact', path: '/dsh-memory/search', handler: routeHandler }))
      st.webServer = webServer
    } catch {
      // 路由挂不上不影响工具
    }
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(mountRoute)
    } catch {
      mountRoute()
    }
  } else {
    mountRoute()
  }

  // 可选：自动召回（宿主有 systemPrompt 服务才挂；不认识就安静跳过）
  if (!st.autoStarted && config.autoRecall) {
    st.autoStarted = true
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        ctx.effect(() =>
          systemPrompt.section({
            name: 'dsh-memory-unified',
            order: 60,
            text: () => {
              const stats = store.stats()
              return stats.items > 0
                ? `记忆库里有 ${stats.items} 条长期记忆（${stats.folders} 个主题）。需要时用 memory(action=search) 或 memory(action=digest) 查，不要凭空猜。`
                : ''
            },
          }),
        )
      }
    } catch (error) {
      safeLog(ctx, 'warn', 'dsh-memory-unified: 自动召回挂载失败，已跳过：' + String((error && error.message) || error))
    }
  }

  const tools = toolsOrRetry(ctx, st, () => applyInner(ctx), {
    warn: (seconds) => {
      safeLog(ctx, 'warn', `dsh-memory-unified: ${seconds} 秒内没等到 tools 服务，工具未注册`)
      note(`${seconds}s 内没等到 tools 服务，5 个工具均未注册`)
    },
    log: (message) => note(message),
  })
  if (!tools) return
  st.registered = true

  const definitions = createMemoryTools({ store, config })
  const registerAll = () => {
    const handles = []
    for (const definition of definitions) {
      try {
        handles.push(tools.register(definition))
      } catch (error) {
        note('注册工具失败 ' + String((definition && definition.name) || '?') + '：' + String((error && error.message) || error))
      }
    }
    return () => {
      for (const handle of handles) {
        try {
          handle?.dispose?.()
        } catch {
          // ignore
        }
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(registerAll)
  else registerAll()

  safeLog(ctx, 'info', `dsh-memory-unified ready（${store.stats().items} 条记忆）`)
  note(`dsh-memory-unified: ${definitions.length} 个工具已注册（pid ${process.pid}）`)
}
