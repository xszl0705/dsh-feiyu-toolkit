/**
 * dsh-memory-unified — 五个工具的定义（纯数据 + 执行函数，注册在 index.js）
 *
 * 设计取舍：
 *   - 只做「显式工具」，不做自动改写上下文（那正是旧版三个 memory 插件互相打架的地方）。
 *   - 自动召回做成可选（config.autoRecall），默认关，且走 feature detection，不认识就静默跳过。
 */

import { assertMemorySafe, judgeWorthiness, relatedItems } from './engine.js'

function blocks(text) {
  return [{ type: 'text', text: String(text) }]
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ms)
  }
}

function text(value, max = 160) {
  const s = String(value || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max) + '…'
}

export function createMemoryTools({ store, config }) {
  const maxItems = config.maxItemsPerFolder ?? 200
  const activeOf = (folder) => (folder.items || []).filter((item) => !item.status || item.status === 'active')

  /** 把一次写入决策记到 self 的决策日志；失败静默，不影响记忆写入。 */
  function logDecision(entry) {
    try {
      const self = globalThis[Symbol.for('dsh-feiyu-self.service')]
      self?.record?.({ kind: 'memory', scope: 'owner', channel: 'memory', ...entry })
    } catch {
      // 决策日志不可用不影响记忆本身
    }
  }

  const remember = {
    name: 'memory_remember',
    description:
      '把一条值得长期记住的事写进记忆库。folder 是主题（如「桌宠」「插件配置」），keywords 便于以后检索；记不记由你判断，拿不准先用 memory_judge。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，尽量一句话说完整' },
        folder: { type: 'string', description: '主题文件夹名，省略则按关键词自动归入「未命名」' },
        keywords: { type: 'array', items: { type: 'string' }, description: '3~6 个检索关键词' },
        importance: { type: 'number', description: '0~1，默认 0.5；长期规则给 0.9' },
        category: { type: 'string', description: 'stable_profile / preference / decision / fact，默认 general' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          folder: { type: 'string' },
          total: { type: 'number' },
          action: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return blocks('写入失败')
        const label = value.action === 'duplicate' ? '已存在，合并关键词' : value.action === 'updated' ? '已更新，旧版本失效' : '已记住'
        return blocks(`${label}（${value.folder} · ${value.id}），该主题现有 ${value.total} 条`)
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const draft = String(args?.text || '').trim()
      if (!draft) {
        logDecision({ choice: 'rejected', reason: 'empty' })
        return { ok: false, id: '', folder: '', total: 0, action: 'rejected' }
      }
      try {
        assertMemorySafe(draft)
      } catch {
        logDecision({ choice: 'rejected', reason: 'sensitive' })
        return { ok: false, id: '', folder: '', total: 0, action: 'rejected' }
      }
      const folderName = String(args?.folder || '未命名')
      const { item, folder, action } = store.addItem({
        folderName,
        text: draft,
        keywords: Array.isArray(args?.keywords) ? args.keywords.map(String) : [],
        importance: args?.importance,
        category: String(args?.category || 'general'),
        maxItems,
        dedupe: config.dedupe !== false,
      })
      const active =
        typeof folder.activeCount === 'number'
          ? folder.activeCount
          : (folder.items || []).filter((entry) => !entry.status || entry.status === 'active').length
      logDecision({ choice: action, reason: `folder:${folder.name}`, outcome: 'persisted' })
      return { ok: true, id: item.id, folder: folder.name, total: active, action }
    },
  }

  const search = {
    name: 'memory_search',
    description: '按语义关键词在记忆库里搜（中文用二字切分，整句也能搜到）。可用 folder 限定只搜某个主题。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的内容，可以是整句' },
        limit: { type: 'number', description: '返回条数，默认 8' },
        folder: { type: 'string', description: '只搜这个主题（如「工作」「日常」），省略则全库' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'number' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                folder: { type: 'string' },
                id: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
                createdAt: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.count) return blocks(`没有找到和「${value.query}」相关的记忆（无词面命中，宁可说不知道）`)
        const lines = (value.hits || []).map((hit, i) => `${i + 1}. [${hit.folder}] ${text(hit.text)}（${hit.score}）`)
        return blocks(`找到 ${value.count} 条：\n${lines.join('\n')}`)
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const query = String(args?.query || '').trim()
      const hits = store.search(query, {
        limit: Number(args?.limit) || 8,
        folder: String(args?.folder || '').trim(),
      })
      return { query, count: hits.length, hits }
    },
  }

  const related = {
    name: 'memory_related',
    description: '给一条记忆（id）或一段文本，找关键词重叠的其它记忆，用来补上下文的来龙去脉。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（memory_search 返回的那个）' },
        text: { type: 'string', description: '没有 id 时用一段文本' },
        limit: { type: 'number', description: '返回条数，默认 6' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                folder: { type: 'string' },
                id: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) =>
        blocks(value.count ? (value.hits || []).map((hit) => `· [${hit.folder}] ${text(hit.text)}（${hit.score}）`).join('\n') : '没有相关记忆'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const hits = relatedItems(store.allFolders(), { id: String(args?.id || ''), text: String(args?.text || '') }, {
        limit: Number(args?.limit) || 6,
      })
      return { count: hits.length, hits }
    },
  }

  const digest = {
    name: 'memory_digest',
    description: '看记忆库总览：有哪些主题、各多少条、最近更新的是什么。用来在长会话开头快速接上上下文。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '每个主题最多列几条，默认 3' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          folders: { type: 'number' },
          items: { type: 'number' },
          storeDir: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) =>
        blocks(`记忆库：${value.folders} 个主题 / ${value.items} 条（${value.storeDir}）\n${(value.lines || []).join('\n')}`),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = Number(args?.limit) || 3
      const folders = store.allFolders()
      const stats = store.stats()
      const lines = folders
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map((folder) => {
          const items = activeOf(folder)
          const recent = items
            .slice(-limit)
            .reverse()
            .map((item) => `${text(item.text, 60)}（${formatTime(item.createdAt)}）`)
          return `· ${folder.name}（${items.length} 条）\n  ${recent.join('\n  ')}`
        })
      return { folders: stats.folders, items: stats.items, storeDir: stats.storeDir, lines }
    },
  }

  const judge = {
    name: 'memory_judge',
    description: '判断一段话值不值得长期记住（0~1 分 + 理由）。拿不准要不要 memory_remember 时先问它。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待判断的原文' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          keep: { type: 'boolean' },
          blocked: { type: 'boolean' },
          score: { type: 'number' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.blocked) return blocks(`不记（${value.score}）：${(value.reasons || []).join('；')}`)
        return blocks(`${value.keep ? '值得记' : '可以不记'}（${value.score}）：${(value.reasons || []).join('；')}`)
      },
    },
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async (args) => judgeWorthiness(args?.text),
  }

  const forget = {
    name: 'memory_forget',
    description:
      '删除记忆（软删除：保留历史、不再参与检索）。给 id 精确删；或给 folder + query 按关键词批量删；三者都不给时不做任何事。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的记忆 id（memory_search 返回的那个）' },
        folder: { type: 'string', description: '限定主题，缩小删除范围' },
        query: { type: 'string', description: '按关键词匹配要删除的条目' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          ids: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) =>
        blocks(value.count ? `已删除 ${value.count} 条：${(value.ids || []).join(', ')}` : '没有匹配到可删除的记忆'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const id = String(args?.id || '').trim()
      const folderName = String(args?.folder || '').trim()
      const query = String(args?.query || '').trim()
      if (!id && !query) return { count: 0, ids: [] } // 不许「什么都不给」把库清空
      return store.forget({ id, folderName, query })
    },
  }

  const doctor = {
    name: 'memory_doctor',
    description: '记忆库体检：后端、主题/条目数、重复组、FTS 漂移、体积、时间范围。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          backend: { type: 'string' },
          storeDir: { type: 'string' },
          folders: { type: 'number' },
          items: { type: 'number' },
          archived: { type: 'number' },
          duplicateGroups: { type: 'number' },
          ftsDrift: { type: 'number' },
          dbBytes: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const kb = Math.round((value.dbBytes || 0) / 1024)
        return blocks(
          [
            `记忆库体检（${value.backend}）：${value.storeDir}`,
            `· 主题 ${value.folders} / 活跃 ${value.items} / 归档 ${value.archived}`,
            `· 重复组 ${value.duplicateGroups} / FTS 漂移 ${value.ftsDrift} / 体积 ${kb}KB`,
          ].join('\n'),
        )
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async () => store.doctor(),
  }

  const exportTool = {
    name: 'memory_export',
    description: '把整个记忆库导出成可 diff 的 JSON 文件（含已失效/已删除条目，便于审计）。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '导出目录，省略则用 <记忆库>/exports' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          folders: { type: 'number' },
          items: { type: 'number' },
        },
      },
      render: (_args, value) => blocks(`已导出 ${value.items} 条（${value.folders} 个主题）→ ${value.file}`),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: async (args) => store.exportToFile(args?.dir ? String(args.dir) : undefined),
  }

  const importTool = {
    name: 'memory_import',
    description: '从 JSON 文件导入记忆（导出格式或 v1 格式都行）。按 id 去重，只导入活跃条目。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要导入的 JSON 文件路径' },
      },
      required: ['file'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          imported: { type: 'number' },
          skipped: { type: 'number' },
        },
      },
      render: (_args, value) => blocks(`导入 ${value.imported} 条，跳过 ${value.skipped} 条（已存在/已失效）`),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const file = String(args?.file || '').trim()
      if (!file) return { imported: 0, skipped: 0 }
      return store.importFromFile(file)
    },
  }

  // 2026-11-01：九个工具合并为单入口 memory（action 分发），压工具定义 token。
  // 各工具实现保持原样，合并层只做路由与结果包装：{ ok, action, result }。
  const ACTIONS = {
    remember,
    search,
    related,
    digest,
    judge,
    forget,
    doctor,
    export: exportTool,
    import: importTool,
  }

  const memoryTool = {
    name: 'memory',
    description:
      '语义记忆库（sqlite 现学现用库，与 .dsh-memory 的日志/笔记/白板是两套）。action：remember 记一条 / search 整句检索 / related 找关联 / digest 看总览 / judge 判断值不值得记 / forget 软删除 / doctor 体检 / export 导出 JSON / import 导入 JSON。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'search', 'related', 'digest', 'judge', 'forget', 'doctor', 'export', 'import'],
          description: '要做的事',
        },
        text: { type: 'string', description: 'remember/judge 的正文；related 用它代替 id' },
        query: { type: 'string', description: 'search 的查询词；forget 用它做关键词批量删' },
        folder: { type: 'string', description: '主题名（remember 写入 / search 限定 / forget 缩小范围）' },
        id: { type: 'string', description: '记忆 id（related / forget 用）' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'remember 的 3~6 个检索关键词' },
        importance: { type: 'number', description: 'remember 的重要度 0~1，默认 0.5；长期规则给 0.9' },
        category: { type: 'string', description: 'remember 的分类：stable_profile / preference / decision / fact' },
        limit: { type: 'number', description: 'search / related / digest 的条数上限' },
        dir: { type: 'string', description: 'export 的导出目录，省略用 <记忆库>/exports' },
        file: { type: 'string', description: 'import 的 JSON 文件路径' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          result: { type: 'object' },
        },
      },
      render: (args, value) => {
        const sub = ACTIONS[value?.action]
        if (sub && sub.output && typeof sub.output.render === 'function') {
          try {
            return sub.output.render(args, value.result)
          } catch {
            // 渲染失败就退回 JSON，不影响调用结果
          }
        }
        return blocks(JSON.stringify(value?.result ?? null))
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const action = String(args?.action || '').trim()
      const sub = ACTIONS[action]
      if (!sub) return { ok: false, action, result: { error: 'unknown action: ' + action } }
      try {
        const result = await sub.execute(args)
        return { ok: result && result.ok === false ? false : true, action, result: result ?? null }
      } catch (error) {
        return { ok: false, action, result: { error: String((error && error.message) || error) } }
      }
    },
  }

  return [memoryTool]
}
