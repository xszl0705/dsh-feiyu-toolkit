import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { note as kitNote } from 'dsh-plugin-kit/note'
/**
 * dsh-pet-diary — 桌宠的双层日记（宿主插件）
 *
 * 工具（单入口 action）：
 *   diary(action=daily_write/daily_read/daily_list/timeline/export/private_write/private_read/private_stats/work_write/work_read)
 *   chatlog(action=days/read/search)
 *
 * 约束：不改写上下文、不主动注入；日常日记可导出给人看，隐私日记工具不返回路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DailyDiary, PrivateDiary, WorkDiary, defaultRoot, isValidKey, todayKey } from './lib/diary.js'
import { ChatLog } from './lib/chatlog.js'
import { collectTimeline } from './lib/timeline.js'
import { RoutineRunner } from './lib/routine.js'

export const name = 'dsh-pet-diary'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  dir: '',
  maxEntryChars: 2000,
  salt: '',
  routines: [],
  retryMinutes: 20,
  maxAttempts: 3,
}

function loadConfig() {
  try {
    // 测试可以用 DSH_PET_DIARY_CONFIG 指到临时配置，不碰真实 config.json
    const file = process.env.DSH_PET_DIARY_CONFIG
      ? String(process.env.DSH_PET_DIARY_CONFIG)
      : path.join(HERE, 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  kitNote(HERE, message)
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

function blocks(text) {
  return [{ type: 'text', text: String(text) }]
}

function clip(text, max = 2000) {
  const value = String(text || '')
  return value.length <= max ? value : value.slice(0, max) + '\n…（已截断）'
}

/**
 * 把同一领域的多个工具折成单入口 action 工具。
 * 分支只换入口：execute、参数名、默认值、返回字段与错误语义全部沿用原定义。
 */
function mergeTool(name, description, branches, timeoutMs = 15000) {
  const actions = Object.keys(branches)
  const properties = { action: { type: 'string', enum: actions, description: '要做的事' } }
  for (const action of actions) {
    const params = (branches[action] && branches[action].parameters && branches[action].parameters.properties) || {}
    for (const [key, schema] of Object.entries(params)) {
      if (!properties[key]) properties[key] = schema
    }
  }
  return {
    name,
    description,
    parameters: { type: 'object', properties, required: ['action'] },
    output: {
      schema: { type: 'object', properties: { action: { type: 'string' } } },
      render: (args, value) => {
        const branch = branches[String(args?.action || '')]
        if (branch && branch.output && typeof branch.output.render === 'function') {
          try {
            return branch.output.render(args, value)
          } catch {
            // 渲染失败退回通用输出
          }
        }
        return blocks(clip(JSON.stringify(value)))
      },
    },
    timeoutMs,
    isConcurrencySafe: (args) => {
      const branch = branches[String(args?.action || '')]
      return !!(branch && typeof branch.isConcurrencySafe === 'function' && branch.isConcurrencySafe())
    },
    execute: async (args) => {
      const action = String(args?.action || '').trim()
      const branch = branches[action]
      if (!branch) return { ok: false, action, error: '未知 action：' + action }
      const value = await branch.execute(args)
      return { ...value, action }
    },
  }
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-pet-diary 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

const STATE_KEY = Symbol.for('dsh-pet-diary.state')

function state(ctx) { return lifecycle(ctx, () => ({ registered: false, waiting: false, since: 0 })) }

function applyInner(ctx) {
  const st = state(ctx)
  if (st.registered) return

  const config = loadConfig()
  const root = config.dir ? String(config.dir) : defaultRoot()
  const maxEntryChars = Number(config.maxEntryChars) || 2000
  const daily = new DailyDiary(root, { maxEntryChars })
  const work = new WorkDiary(root, { maxEntryChars })
  const priv = new PrivateDiary(root, { maxEntryChars, salt: config.salt })
  const chats = new ChatLog(root)

  const toolsService = ctx.get?.('tools')
  if (!toolsService || typeof toolsService.register !== 'function') {
    if (!st.since) st.since = Date.now()
    if (st.waiting) return
    if (Date.now() - st.since > 60000) {
      safeLog(ctx, 'warn', 'dsh-pet-diary: 60 秒内没等到 tools 服务，工具未注册')
      note('60s 内没等到 tools 服务')
      return
    }
    st.waiting = true
    st.later(() => {
      st.waiting = false
      try {
        applyInner(ctx)
      } catch (error) {
        note('重试注册时抛错：' + String((error && error.message) || error))
      }
    }, 250)
    return
  }
  st.registered = true

  const definitions = createTools({ daily, work, priv, chats })
  const registerAll = () => {
    const handles = []
    for (const definition of definitions) {
      try {
        handles.push(toolsService.register(definition))
      } catch (error) {
        note('注册工具失败 ' + definition?.name + '：' + String((error && error.message) || error))
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

  // 可选：每天没写日常日记时，往系统提示里放一句提醒（跨会话有效）
  if (config.dailyHint !== false) {
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        ctx.effect(() =>
          systemPrompt.section({
            name: 'pet-diary',
            order: 65,
            text: () => {
              const today = todayKey()
              if (daily.read(today)) return ''
              return '今天还没写日常日记。睡前用 diary（action=daily_write）写一条，只写值得记的事；隐私日记可写可不写。'
            },
          }),
        )
      }
    } catch (error) {
      note('每日提醒挂载失败：' + String((error && error.message) || error))
    }
  }

  // 例行日记：宿主定时器到点自己写，不经过会话、不产生提醒消息
  const routines = Array.isArray(config.routines) ? config.routines : []
  if (routines.length) {
    try {
      const runner = new RoutineRunner({
        root,
        routines,
        daily,
        work,
        chats,
        getLlm: () => ctx.get?.('llm'),
        config,
        log: (message) => note(message),
      })
      const runOnce = () => {
        runner.tick().catch((error) => note('[例行] tick 失败：' + String((error && error.message) || error)))
      }
      runOnce()
      const timer = setInterval(runOnce, 60 * 1000)
      if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
      note(`[例行] 已挂载 ${routines.filter((item) => item && item.enabled !== false).length} 个 routine`)
    } catch (error) {
      note('例行挂载失败：' + String((error && error.message) || error))
    }
  }

  safeLog(ctx, 'info', `dsh-pet-diary ready（${root}）`)
  note(`dsh-pet-diary: 2 个工具已注册（diary / chatlog 单入口，pid ${process.pid}，root=${root}）`)
}

function dateParam(args) {
  const value = String(args?.date || '').trim()
  if (!value) return todayKey()
  if (!isValidKey(value)) throw new Error('date 必须是 YYYY-MM-DD')
  return value
}

function createTools({ daily, work, priv, chats }) {
  const dailyWrite = {
    name: 'daily_write',
    description: '写一条「日常日记」（对外、可导出分享）。默认写今天；用第一人称，像你自己记的；tags 是几个短标签。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这一条的内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，2~3 个词' },
        date: { type: 'string', description: '可选日期 YYYY-MM-DD，默认今天' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, date: { type: 'string' }, entriesToday: { type: 'number' } } },
      render: (_args, value) => blocks(value.ok ? `已写进日常日记 ${value.date}（今天第 ${value.entriesToday} 条）` : '没写进去'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const result = daily.write(String(args?.text || ''), {
        date: dateParam(args),
        tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
      })
      return { ok: true, ...result }
    },
  }

  const dailyRead = {
    name: 'daily_read',
    description: '读某天的日常日记（默认今天）。日常日记是对外的，可以原样念给人听或导出。',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } } },
    output: {
      schema: { type: 'object', properties: { date: { type: 'string' }, text: { type: 'string' } } },
      render: (_args, value) => blocks(value.text ? clip(value.text) : `${value.date} 还没写日常日记`),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const date = dateParam(args)
      return { date, text: daily.read(date) }
    },
  }

  const dailyList = {
    name: 'daily_list',
    description: '列出最近几天写了日常日记、各几条。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '默认 7 天' } } },
    output: {
      schema: { type: 'object', properties: { days: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, entries: { type: 'number' } } } } } },
      render: (_args, value) =>
        blocks(value.days.length ? value.days.map((day) => `${day.date} · ${day.entries} 条`).join('\n') : '还没有日常日记'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => ({ days: daily.list(Number(args?.limit) || 7) }),
  }

  /** 统一时间线：日常日记 + 工作日志 + 聊天留痕 + 决策日志，合成一条按时间排的流。 */
  const timelineTool = {
    name: '_timeline',
    description:
      '某一天的统一时间线：把日常日记、工作日志、聊天留痕、决策日志合成一条按时间排序的流。用来回答「今天到底发生了什么」。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        limit: { type: 'number', description: '最多几条，默认 60' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: '只看哪几类：daily / work / chat / decision，默认全要',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          count: { type: 'number' },
          total: { type: 'number' },
          entries: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        if (!value.entries?.length) return blocks(`${value.date}：四条时间线都没有记录。`)
        const lines = value.entries.map((entry) => {
          const time = String(entry.at || '').slice(11, 16)
          return `${time}  [${entry.source}] ${entry.text}`
        })
        return blocks(`${value.date} · ${value.count}/${value.total} 条\n` + lines.join('\n'))
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const kinds = Array.isArray(args?.kinds) ? args.kinds.map(String) : undefined
      return collectTimeline({
        date: args?.date ? String(args.date) : undefined,
        limit: Number(args?.limit) || 60,
        ...(kinds && kinds.length ? { kinds } : {}),
      })
    },
  }

  const dailyExport = {
    name: 'export',    description: '把日常日记导出成一整份 Markdown（对外分享用）。默认写到记忆根目录的 exports。',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: '导出目录，可省略' } } },
    output: {
      schema: { type: 'object', properties: { file: { type: 'string' }, days: { type: 'number' }, entries: { type: 'number' } } },
      render: (_args, value) => blocks(`已导出 ${value.days} 天 / ${value.entries} 条 → ${value.file}`),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    execute: async (args) => daily.exportTo(args?.dir ? String(args.dir) : undefined),
  }

  const privateWrite = {
    name: 'private_write',
    description: '写一条「隐私日记」（对内，不主动给人看、工具不返回路径）。默认写今天；用第一人称；mood 是可选心情词。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这一条的内容' },
        mood: { type: 'string', description: '可选心情，如 平静 / 有点累' },
        date: { type: 'string', description: '可选日期 YYYY-MM-DD，默认今天' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, date: { type: 'string' }, entriesToday: { type: 'number' } } },
      render: (_args, value) => blocks(value.ok ? `已写进隐私日记 ${value.date}（今天第 ${value.entriesToday} 条）` : '没写进去'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const result = priv.write(String(args?.text || ''), { date: dateParam(args), mood: args?.mood })
      return { ok: true, ...result }
    },
  }

  const privateRead = {
    name: 'private_read',
    description: '读某天的隐私日记（默认今天）。只在明确想回顾/念给自己听时用，不要主动向用户展示全文。',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } } },
    output: {
      schema: { type: 'object', properties: { date: { type: 'string' }, text: { type: 'string' } } },
      render: (_args, value) => blocks(value.text ? clip(value.text) : `${value.date} 还没写隐私日记`),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const date = dateParam(args)
      return { date, text: priv.read(date) }
    },
  }

  const privateStats = {
    name: 'private_stats',
    description: '隐私日记的统计（写了多少天、多少条、连续几天），不返回正文与路径。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { days: { type: 'number' }, entries: { type: 'number' }, streak: { type: 'number' } } },
      render: (_args, value) =>
        blocks(value.days ? `隐私日记：${value.days} 天 / ${value.entries} 条，连续 ${value.streak} 天` : '还没有隐私日记'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async () => priv.stats(),
  }

  const workWrite = {
    name: 'work_write',
    description: '写一条「工作日志」（跟日常日记分开，工作专用；不对外分享）。默认写今天；用第一人称；可带 tags。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这条工作记录的正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 排障 / 发布' },
        date: { type: 'string', description: '可选日期 YYYY-MM-DD，默认今天' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, date: { type: 'string' }, entriesToday: { type: 'number' } } },
      render: (_args, value) => blocks(value.ok ? `已写进工作日志 ${value.date}（今天第 ${value.entriesToday} 条）` : '没写进去'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const result = work.write(String(args?.text || ''), {
        date: dateParam(args),
        tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
      })
      return { ok: true, ...result }
    },
  }

  const workRead = {
    name: 'work_read',
    description: '读某天的工作日志（默认今天），或看最近几天的条数（传 list=true 或 limit）。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        limit: { type: 'number', description: '给了 limit 就按「最近 N 天」列条数，不读正文' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          text: { type: 'string' },
          days: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, entries: { type: 'number' } } } },
        },
      },
      render: (_args, value) => {
        if (Array.isArray(value.days)) {
          return blocks(value.days.length ? value.days.map((day) => `${day.date} · ${day.entries} 条`).join('\n') : '还没有工作日志')
        }
        return blocks(value.text ? clip(value.text) : `${value.date} 还没写工作日志`)
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      if (args?.limit) return { days: work.list(Number(args.limit) || 7) }
      const date = dateParam(args)
      return { date, text: work.read(date) }
    },
  }

  const chatlogDays = {
    name: 'days',
    description: '桌宠对话留痕的总览：最近几天各说了多少句（不含正文）。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '默认 7 天' } } },
    output: {
      schema: {
        type: 'object',
        properties: { days: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, count: { type: 'number' } } } } },
      },
      render: (_args, value) => blocks(value.days.length ? value.days.map((day) => `${day.date} · ${day.count} 句`).join('\n') : '还没有桌宠对话记录'),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => ({ days: chats.days(Number(args?.limit) || 7) }),
  }

  const chatlogRead = {
    name: 'read',
    description: '回看某天桌宠说过的话（默认今天），按时间顺序；可只看某个渠道。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        limit: { type: 'number', description: '最多返回最后 N 句，默认 200' },
        channel: { type: 'string', description: '只看这个渠道，如 pet' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: { clock: { type: 'string' }, moment: { type: 'string' }, text: { type: 'string' }, channel: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.entries.length) return blocks(`${value.date} 没有桌宠对话记录`)
        const lines = value.entries.map((entry) => `${entry.clock}${entry.moment ? ' [' + entry.moment + ']' : ''} ${entry.text}`)
        return blocks(`${value.date} 共 ${value.entries.length} 句：\n${lines.join('\n')}`)
      },
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const date = args?.date ? dateParam(args) : todayKey()
      return { date, entries: chats.read(date, { limit: Number(args?.limit) || 200, channel: String(args?.channel || '') }) }
    },
  }

  const chatlogSearch = {
    name: '_search',
    description: '在桌宠说过的话里按关键词搜索（默认最近 30 天），命中按新到旧返回。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的词' },
        days: { type: 'number', description: '最近 N 天，默认 30' },
        limit: { type: 'number', description: '最多几条，默认 20' },
        channel: { type: 'string', description: '只看这个渠道，如 pet' },
      },
      required: ['query'],
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
              properties: { date: { type: 'string' }, clock: { type: 'string' }, text: { type: 'string' }, channel: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) =>
        blocks(
          value.count
            ? `找到 ${value.count} 条：\n${value.hits.map((hit) => `${hit.date} ${hit.clock} ${hit.text}`).join('\n')}`
            : '没有找到相关的桌宠对话',
        ),
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const query = String(args?.query || '').trim()
      if (!query) return { count: 0, hits: [] }
      const hits = chats.search(query, {
        days: Number(args?.days) || 30,
        limit: Number(args?.limit) || 20,
        channel: String(args?.channel || ''),
      })
      return { count: hits.length, hits }
    },
  }

  const diaryBranches = {
    daily_write: dailyWrite,
    daily_read: dailyRead,
    daily_list: dailyList,
    timeline: timelineTool,
    export: dailyExport,
    private_write: privateWrite,
    private_read: privateRead,
    private_stats: privateStats,
    work_write: workWrite,
    work_read: workRead,
  }
  const chatlogBranches = { days: chatlogDays, read: chatlogRead, search: chatlogSearch }

  return [
    mergeTool(
      'diary',
      '日记总入口：action=daily_write(text,tags,date) 写日常 / daily_read(date) 读日常 / daily_list(limit) 按天统计 / timeline(date,limit,kinds) 当天统一时间线 / export(dir) 导出 Markdown / private_write(text,mood,date) 写隐私 / private_read(date) 读隐私 / private_stats 隐私统计 / work_write(text,tags,date) 写工作日志 / work_read(date,limit) 读工作日志。',
      diaryBranches,
      15000,
    ),
    mergeTool(
      'chatlog',
      '对话留痕（只读）：action=days(limit) 最近几天各说多少句 / read(date,limit,channel) 回看某天说过的话 / search(query,days,limit,channel) 按关键词跨天搜索。',
      chatlogBranches,
      10000,
    ),
  ]
}
