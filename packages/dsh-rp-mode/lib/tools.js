/**
 * 扮演记忆工具：单入口 rp_memory(action)。
 *
 * 与工作记忆（memory_* / auto-memory）完全隔离：不读也不写它们。
 * 描述刻意压短——工具定义每轮都要发给模型，扮演模式不该被工具说明吃掉上下文。
 */
import { KINDS, KIND_LABEL, defaultRoot, digest, forgetEntry, listEntries, readEntry, recallEntries, saveEntry } from './store.js'
import { bookIndex, DEFAULT_CARD_ROOT, DOWNLOAD_CARD_ROOT, buildStageKit, fillPlaceholders, findCards, loadCard, loadTagIndex, openingsOf, pickBookEntries, readCurrent, renderBookIndex, renderCardMemory, renderCardView, scanCards, scenarioForSession, searchCards, searchTagIndex, tagRowsToIndex, writeCurrent } from './card.js'
import path from 'node:path'
import { MAX_CARDS, addCard, getLock, removeCard, sessionIdOf, setLock, setScenario } from './session.js'

const KINDS_LIST = Object.keys(KINDS)

function line(...parts) {
  return parts.filter((p) => p !== undefined && p !== '').join(' ')
}

function fmtDate(iso) {
  const text = String(iso || '')
  if (!text) return '-'
  return text.slice(0, 16).replace('T', ' ')
}

export function createTools(config = {}) {
  const root = config.root && String(config.root).trim() ? String(config.root) : defaultRoot()
  const perKind = Math.max(1, Number(config.digestPerKind) || 8)
  const recallLimit = Math.max(1, Number(config.recallLimit) || 8)

  const rpMemory = {
    name: 'rp_memory',
    description:
      `扮演记忆（独立于工作记忆，Markdown 落 ${root}）。digest 总览 / save 写 / append 续写 / read 读 / recall 搜 / list 列 / forget 删。kind: character 角色·world 世界·scene 剧情·bond 关系·note 杂记。写事实不写感想，一条一件事。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['digest', 'save', 'append', 'read', 'recall', 'list', 'forget'],
          description: 'digest|save|append|read|recall|list|forget',
        },
        kind: { type: 'string', enum: KINDS_LIST, description: '条目类别' },
        name: { type: 'string', description: '条目名' },
        body: { type: 'string', description: '正文（save/append 必填）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        query: { type: 'string', description: 'recall 关键词' },
        id: { type: 'string', description: '条目 id' },
        limit: { type: 'number', description: '条数，默认 8' },
      },
      required: ['action'],
    },
    // ★2026-11-08 修：`tools.register()` 强制要求 `output.render` 是函数（dsh-tools
    //   `register()` 的 TypeError 校验），catalog 只给了 schema ⇒ 两个工具**从未注册成功**
    //   （`apply 完成：注册 2 个工具` 只统计"尝试次数"，不看结果）。扮演会话里因此没有
    //   rp_card / rp_memory —— 不是通道砍掉的。
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }] },
    execute: async (args = {}) => {
      const action = String(args.action || 'digest')
      try {
        if (action === 'digest') {
          const result = digest(root, { perKind })
          const lines = [`扮演记忆：${result.total} 条（${root}）`]
          for (const kind of KINDS_LIST) lines.push(`- ${KIND_LABEL[kind]} ${result.byKind[kind] || 0} 条`)
          if (result.recent.length) {
            lines.push('', '最近的条目：')
            for (const entry of result.recent.slice(0, perKind * 2)) {
              lines.push(`- [${KIND_LABEL[entry.kind]}] ${entry.name}（${fmtDate(entry.updated)}，${entry.chars} 字）`)
            }
            lines.push('', '细节用 rp_memory(action=read, kind=…, name=…) 或 action=recall。')
          } else {
            lines.push('', '还没有任何记录。这一局开始写第一条。')
          }
          return { ok: true, action, total: result.total, byKind: result.byKind, lines }
        }

        if (action === 'save' || action === 'append') {
          const saved = saveEntry(root, { kind: args.kind, name: args.name, body: args.body, tags: args.tags, mode: action })
          return {
            ok: true,
            action,
            id: saved.id,
            lines: [`${action === 'append' ? '已续写' : '已写入'}「${saved.name}」（${KIND_LABEL[saved.kind]}，${saved.chars} 字，${saved.id}）`],
          }
        }

        if (action === 'read') {
          const entry = readEntry(root, { id: args.id, name: args.name, kind: args.kind })
          if (!entry) return { ok: false, action, lines: [`没找到「${args.name || args.id}」`] }
          return {
            ok: true,
            action,
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            tags: entry.tags,
            updated: entry.updated,
            lines: [`[${KIND_LABEL[entry.kind]}] ${entry.name}（更新 ${fmtDate(entry.updated)}${entry.tags.length ? '，标签 ' + entry.tags.join('/') : ''}）`, '', entry.body],
          }
        }

        if (action === 'recall') {
          const hits = recallEntries(root, { query: args.query, kind: args.kind, limit: Math.min(30, Number(args.limit) || recallLimit) })
          const lines = hits.length ? [`命中 ${hits.length} 条：`] : [`没有「${args.query}」的记录`]
          for (const hit of hits) {
            lines.push(`- [${KIND_LABEL[hit.kind]}] ${hit.name}（${fmtDate(hit.updated)}）：${hit.snippet}`)
          }
          return { ok: true, action, count: hits.length, hits, lines }
        }

        if (action === 'list') {
          const rows = listEntries(root, { kind: args.kind, limit: Math.min(200, Number(args.limit) || 50) })
          const lines = rows.length ? [`${args.kind ? KIND_LABEL[args.kind] : '全部'} ${rows.length} 条：`] : ['空的']
          for (const row of rows) lines.push(`- ${row.name}（${fmtDate(row.updated)}，${row.chars} 字，${row.id}）`)
          return { ok: true, action, count: rows.length, rows, lines }
        }

        if (action === 'forget') {
          const removed = forgetEntry(root, { id: args.id, name: args.name, kind: args.kind })
          if (!removed) return { ok: false, action, lines: [`没找到「${args.name || args.id}」`] }
          return { ok: true, action, lines: [`已归档「${removed.name}」（文件进 .trash，没真删）`] }
        }

        return { ok: false, action, lines: [`未知 action「${action}」`] }
      } catch (error) {
        return { ok: false, action, lines: [String((error && error.message) || error)] }
      }
    },
  }

  /* ---------------- 角色卡库 ---------------- */
  const cardRoots = Array.isArray(config.cardRoots) && config.cardRoots.length
    ? config.cardRoots
    : config.cardRoot && String(config.cardRoot).trim()
      ? [{ path: String(config.cardRoot), label: '自定义', recursive: true }]
      : undefined
  const indexFile = config.indexFile && String(config.indexFile).trim() ? String(config.indexFile) : undefined
  const currentFile = config.currentFile && String(config.currentFile).trim() ? String(config.currentFile) : undefined
  /** 标签索引：默认探测下载库下的 _cardindex/cards.jsonl，存在就走快速通道。 */
  const tagIndexFile = config.tagIndexFile && String(config.tagIndexFile).trim()
    ? String(config.tagIndexFile)
    : path.join(DOWNLOAD_CARD_ROOT, '_cardindex', 'cards.jsonl')

  const rpCard = {
    name: 'rp_card',
    description:
      '角色卡库（带三级标签索引）。search 搜卡（自由不限次）/ list 列卡 / pick 选定并锁定本会话 / read 读卡 / book 取世界书 / ' +
      'cast 存进记忆 / current 看当前 / background 换背景。选定后本会话不能换角色，要换只能新建会话。' +
      '省步数：用户点名了卡就直接 pick（name 吃卡名或文件名片段），不用先 search；' +
      'pick 的返回已经带卡设定、世界书目录与 #1 开场原文，不需要再 read 或 opening；只有要换备选开场才 opening(index=N)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['current', 'list', 'search', 'read', 'book', 'pick', 'cast', 'switch', 'leave', 'background', 'opening'],
          description: 'list 列卡；search 找卡（自由）；pick 选卡进本会话卡组（最多 4 张，多人同场就是群聊）；leave 移出一张；read 读卡；book 取世界书；cast 落进扮演记忆；opening 看/取卡自带开场',
        },
        query: { type: 'string', description: 'search 关键词 / book 条目词（book 可一次写多个词，空格或顿号分隔）' },
        queries: { type: 'array', items: { type: 'string' }, description: 'book 用：一次取多个话题（等价于把多个词写进 query）' },
        name: { type: 'string', description: '卡名或文件名片段' },
        group: { type: 'string', description: 'list 分组' },
        full: { type: 'boolean', description: 'read 展开全文' },
        limit: { type: 'number', description: '条数，默认 10' },
        index: { type: 'number', description: 'opening 用：第几个开场（从 1 起，省略则列出全部）' },
        tags: { type: 'string', description: '标签，逗号分隔，全满足' },
        l1: { type: 'string', description: 'character|cast|system|scenario' },
        l2: { type: 'string', description: '题材 id，逗号分隔' },
      },
      required: ['action'],
    },
    // ★2026-11-08 修：`tools.register()` 强制要求 `output.render` 是函数（dsh-tools
    //   `register()` 的 TypeError 校验），catalog 只给了 schema ⇒ 两个工具**从未注册成功**
    //   （`apply 完成：注册 2 个工具` 只统计"尝试次数"，不看结果）。扮演会话里因此没有
    //   rp_card / rp_memory —— 不是通道砍掉的。
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }] },
    execute: async (args = {}, exec = {}) => {
      const action = String(args.action || 'list')
      const sessionId = sessionIdOf(exec)
      const lock = getLock(root, sessionId)
      const lockNames = () => (lock ? lock.cards.map((c) => '《' + c.name + '》').join('') : '')
      /**
       * 卡组门：已在组里 → 幂等放行；没满 → 允许追加（这就是群聊）；
       * 满了 → 拒绝，让用户先 leave 一张或新建会话。
       */
      const lockGate = (target) => {
        if (!lock) return null
        if (lock.cards.some((c) => c.file === target)) return null
        if (lock.cards.length < MAX_CARDS) return null
        return {
          ok: false,
          action,
          locked: true,
          lines: [
            `本会话卡组已满（${MAX_CARDS} 张）：${lockNames()}`,
            '要换人先用 rp_card(action=leave, name=…) 移出一张，或直接新建会话。',
            '（卡组按会话记：搜卡 / 看卡 / 取世界书不受影响）',
          ],
        }
      }
      try {
        if (action === 'current') {
          // ★2026-11-10：先答「本会话」的卡组，再提全局「上次用过」。
          //   以前这里只读全局 current.json，别的会话选过的卡会被当成本会话角色，
          //   模型据此以为已经锁定，于是不再 pick —— 新会话切卡因此看起来失效。
          const cur = readCurrent(currentFile)
          const mine = lock ? lock.cards.filter((c) => c && (c.name || c.file)) : []
          if (mine.length) {
            const names = mine.map((c) => c.name || c.file)
            const lines = [
              names.length > 1 ? `本局角色（群聊 ${names.length} 位）：${names.join('、')}` : `当前角色：${names[0]}`,
            ]
            const ownScenario = scenarioForSession(lock, mine, cur)
            if (ownScenario) lines.push('背景：' + ownScenario)
            lines.push(`本会话卡组上限 ${MAX_CARDS} 张，还能再留 ${Math.max(0, MAX_CARDS - mine.length)} 个空位（要换角色请新建会话）。`)
            return { ok: true, action, lines }
          }
          const lines = [
            '本会话还没挑卡。开局可自由 search / list，选定后用 rp_card(action=pick, name=…) 锁定；锁定后本会话不再换角色。',
          ]
          const last = cur && Array.isArray(cur.cards) && cur.cards.length
            ? cur.cards.map((c) => c.name).filter(Boolean)
            : cur && cur.character
              ? [cur.character]
              : []
          if (last.length) {
            lines.push(`（上次用过的卡：${last.join('、')} —— 不属于本会话，仅供快速找到，选定后仍需 pick）`)
          }
          return { ok: true, action, lines }
        }

        const tagIndex = loadTagIndex(tagIndexFile)
        let index = null
        const ensureIndex = () => {
          if (index) return index
          index = tagIndex ? tagRowsToIndex(tagIndex) : scanCards({ cardRoots }, { indexFile }).index
          if (!index.length) {
            throw new Error(`卡库为空或路径不对：${cardRoots ? cardRoots.map((r) => r.path).join(' / ') : '默认根'}`)
          }
          return index
        }

        if (action === 'list') {
          const group = String(args.group || '').trim()
          let pool = group ? ensureIndex().filter((entry) => entry.group === group || entry.group.includes(group)) : ensureIndex()
          if (args.l1) pool = pool.filter((entry) => entry.tagRow && entry.tagRow.l1 === args.l1)
          if (args.l2) {
            const want = String(args.l2).split(/[,，]/).map((x) => x.trim()).filter(Boolean)
            pool = pool.filter((entry) => entry.tagRow && want.every((x) => (entry.tagRow.l2 || []).includes(x)))
          }
          if (args.tags) {
            const want = String(args.tags).split(/[,，]/).map((x) => x.trim()).filter(Boolean)
            pool = pool.filter((entry) => entry.tagRow && want.every((t) => [
              ...(entry.tagRow.traits || []), ...(entry.tagRow.relation || []), ...(entry.tagRow.kink || []), ...(entry.tagRow.ctags || []),
            ].includes(t)))
          }
          const limit = Math.min(200, Number(args.limit) || 50)
          const byGroup = {}
          for (const entry of pool) {
            if (!byGroup[entry.group]) byGroup[entry.group] = []
            byGroup[entry.group].push(entry)
          }
          const rootLabel = cardRoots ? cardRoots.map((r) => `${r.label}:${r.path}`).join(' / ') : '默认根（自建 + 下载库）'
          const lines = [`卡库 ${pool.length} 张（${rootLabel}）`]
          for (const name of Object.keys(byGroup)) {
            const list = byGroup[name]
            lines.push(`【${name}】${list.length} 张`)
            for (const entry of list.slice(0, limit)) {
              lines.push(`- ${entry.title}（${(entry.bytes / 1024).toFixed(0)}KB）`)
            }
          }
          if (!lock) lines.push('', '选好后用 rp_card(action=pick, name=…) 锁定；本会话只选一次。')
          return { ok: true, action, count: pool.length, lines }
        }

        if (action === 'search' && tagIndex) {
          const hits = searchTagIndex(tagIndex, {
            query: String(args.query || ''),
            tags: args.tags,
            l1: args.l1,
            l2: args.l2,
            limit: Math.min(30, Number(args.limit) || 8),
          })
          const lines = hits.length
            ? [`「${args.query || args.tags || args.l1 || ''}」命中 ${hits.length} 张（标签索引）：`]
            : [`没有匹配「${args.query || args.tags || ''}」的卡`]
          for (const { row } of hits) {
            const bits = [row.l1, ...(row.l2 || []).slice(0, 2), ...(row.body || []).slice(0, 2), ...(row.persona || []).slice(0, 2), ...(row.role || []).slice(0, 2), ...(row.kink || []).slice(0, 3), ...(row.scene || []).slice(0, 1)].filter(Boolean).join('/')
            lines.push(`- ${row.name}  (${bits} · ${row.rating} · ${row.words}字 · ${row.size_class})`)
            lines.push(`  路径：${row.rel}`)
          }
          if (!lock) lines.push('', '选好后用 rp_card(action=pick, name=…) 锁定；本会话只选一次。')
          return { ok: true, action, count: hits.length, source: 'tag-index', lines }
        }

        if (action === 'search') {
          const hits = searchCards(ensureIndex(), args.query, Math.min(30, Number(args.limit) || 8))
          const lines = hits.length ? [`「${args.query}」命中 ${hits.length} 张：`] : [`没有匹配「${args.query}」的卡`]
          for (const hit of hits) {
            const entry = hit.entry
            const tags = (entry.tags || []).length ? '  #' + entry.tags.slice(0, 4).join(' #') : ''
            const extra = entry.bookCount ? `  世界书${entry.bookCount}` : ''
            lines.push(`- ${entry.cardName || entry.title}  [${entry.group}]  ${(entry.bytes / 1024).toFixed(0)}KB${tags}${extra}`)
          }
          return { ok: true, action, count: hits.length, lines }
        }

        if (action === 'read' || action === 'book' || action === 'cast') {
          const keyword = String(args.name || args.query || '').trim()
          if (!keyword) return { ok: false, action, lines: ['需要 name（卡名或文件名片段）'] }
          const found = findCards(ensureIndex(), keyword, 3)
          if (!found.length) return { ok: false, action, lines: [`卡库里没有「${keyword}」`] }
          const entry = found[0]
          const card = loadCard(entry.file)
          if (!card) return { ok: false, action, lines: [`卡读不出来：${path.basename(entry.file)}`] }

          if (action === 'read') {
            const lines = [`[${entry.group}] ${path.basename(entry.file)}`, '']
            lines.push(...renderCardView(card, { full: Boolean(args.full) }))
            if (found.length > 1) {
              lines.push('', `另有 ${found.length - 1} 张同名卡：` + found.slice(1).map((e) => e.title).join(' / '))
            }
            return { ok: true, action, name: card.name, group: entry.group, lines }
          }

          if (action === 'book') {
            // 一次问多个话题：queries 数组，或 query 里用空格 / 顿号 / 逗号分隔。
            // 起因（2026-11-08 实测）：同一场景模型换了两种措辞分两次问，命中同一批条目，白跑一步。
            const words = []
            const push = (value) => {
              if (value == null) return
              for (const part of String(value).split(/[\s,，、;；/|]+/)) {
                const word = part.trim()
                if (word && !words.includes(word)) words.push(word)
              }
            }
            if (Array.isArray(args.queries)) args.queries.forEach(push)
            else push(args.queries)
            push(args.query)
            const limit = Math.min(30, Number(args.limit) || 10)
            let entries
            if (words.length <= 1) {
              entries = pickBookEntries(card, words[0] || '', limit)
            } else {
              // 多个词：各查一遍，按「命中几个词」排序，同一条只留一份
              const merged = new Map()
              for (const word of words) {
                for (const item of pickBookEntries(card, word, limit)) {
                  const key = item.keys.join('|') + '|' + item.content.slice(0, 60)
                  const hit = merged.get(key)
                  if (hit) hit.hits.push(word)
                  else merged.set(key, { ...item, hits: [word] })
                }
              }
              entries = [...merged.values()].sort((a, b) => b.hits.length - a.hits.length || b.order - a.order).slice(0, limit)
            }
            const scope = words.length > 1 ? `（关键词：${words.join(' / ')}）` : ''
            const lines = entries.length
              ? [`【${card.name}】世界书 ${card.book.length} 条，取到 ${entries.length} 条${scope}：`]
              : [`【${card.name}】没有匹配的世界书条目（共 ${card.book.length} 条）${words.length > 1 ? `，问过：${words.join(' / ')}` : ''}`]
            for (const item of entries) {
              const hit = Array.isArray(item.hits) && item.hits.length > 1 ? `（命中：${item.hits.join('、')}）` : ''
              lines.push(`- [${item.keys.join('/') || '无关键词'}]${hit} ${item.content.replace(/\s+/g, ' ').slice(0, 300)}`)
            }
            return { ok: true, action, count: entries.length, words, lines }
          }

          // cast：写进扮演记忆，之后不再依赖 JSON 文件（会话锁：开局一次）
          const blockedCast = lockGate(entry.file)
          if (blockedCast) return blockedCast
          // ★2026-11-10：写记忆条目**不能拖垮 cast/pick**（同一处修了两遍，因为两分支各有一份）。
          //   以前 body 为空直接抛「body 不能为空」，整次调用失败，模型只能反复重试。
          let castName = card.name || entry.title
          let castNote = ''
          let castSaved = null
          try {
            castSaved = saveEntry(root, {
              kind: 'character',
              name: card.name || entry.title,
              body: renderCardMemory(card) || card.description,
              tags: ['角色卡', ...card.tags],
            })
            if (castSaved && castSaved.name) castName = castSaved.name
          } catch (error) {
            castNote = `（角色记忆条目没写成：${String((error && error.message) || error)}；本局照常，不影响演出）`
          }
          const addedC = addCard(root, sessionId, { file: entry.file, name: castName, rel: entry.rel || '' })
          if (!addedC.ok && addedC.reason === 'full') {
            return {
              ok: false,
              action,
              locked: true,
              lines: [`卡组已满（${MAX_CARDS} 张）：${(addedC.cards || []).map((c) => '《' + c.name + '》').join('')}`, '先用 rp_card(action=leave, name=…) 移出一张。'],
            }
          }
          const lines = [castSaved ? `已落进扮演记忆：${castSaved.name}（${castSaved.chars} 字，${castSaved.id}）` : castNote]
          if (sessionId) lines.push('本会话已锁定这张卡 —— 换角色请新建会话。')
          for (const [title, body] of buildStageKit(card)) {
            lines.push('', `【${title}】`, body)
          }
          // 开场：first_mes + alternate_greetings 合成候选池，随机抽一个（避免每局开头都一样）
          const openings = openingsOf(card)
          if (openings.length) {
            const chosen = openings[0]
            lines.push('', `本卡自带 ${openings.length} 个开场（作者写的，优先复用它，不要自己另起）：`)
            openings.forEach((one, i) => lines.push(`  ${i + 1}. 【${one.tag}】${one.text.slice(0, 80).replace(/\s+/g, ' ')}…`))
            lines.push('', `默认开场 #1【${chosen.tag}】原文（先别演；开场介绍之后照它复现，不要改写、不要缩写、不要换视角）：`)
            lines.push(chosen.text.slice(0, 8000))
            if (openings.length > 1) lines.push('', `要换别的开场才用 rp_card(action=opening, index=2..${openings.length})。**不要为了取开场再调 opening / read —— #1 原文就在上面。**`)
            lines.push('', '下一步：先做开场介绍，不要进主剧情——① 一句话说清这个角色是谁、在哪、与你什么关系（说明开场讲的是哪个场景）；② 列 3-5 条开戏前该知道的事（身份/脾气/忌讳/当前局势/时间地点）；③ 说一句「本卡自带 N 个开场，默认从 #1 开始」，让用户挑或直接说开始；④ 问一句从哪开始就停。用户回应之后再照开场原文起戏：先原文复现，末尾只补必要的礼仪（场景锚点 + 一个玩家能接住的着力点），不改写作者的文字。')
          }
          if (card.book.length) {
            const index = bookIndex(card, 20)
            lines.push('', `世界书 ${index.total} 条，目录（只给关键词与开头，正文用 book 取）：`)
            lines.push(...renderBookIndex(index, 20))
            lines.push('取正文：rp_card(action=book, name=当前卡, query="词1 词2 词3") —— 要问几件事就写进同一个 query。')
          }
          return { ok: true, action, name: card.name, id: castSaved ? castSaved.id : undefined, lines }
        }

        // opening：看/取卡自带开场（实测 96% 的卡有 first_mes、约一半还有 3 个备选）
        if (action === 'opening') {
          const keyword = String(args.name || args.query || '').trim()
          const cur = readCurrent(currentFile) || {}
          let card = null
          if (keyword) {
            const found = findCards(ensureIndex(), keyword, 3)
            if (found.length) card = loadCard(found[0].file)
          } else if (cur.file) {
            card = loadCard(cur.file)
          }
          if (!card) {
            return { ok: false, action, lines: ['给 name（卡名片段），或先 pick 一张卡再用 action=opening。'] }
          }
          const list = openingsOf(card)
          if (!list.length) {
            return {
              ok: true,
              action,
              name: card.name,
              total: 0,
              lines: ['本卡没有自带开场 —— 按开场礼仪自己写：先锚定场景（时间/地点/在场者），再给一个感官细节，最后留一个玩家能接住的着力点，写完就停。'],
            }
          }
          const want = Number(args.index)
          if (!Number.isFinite(want) || want < 1 || want > list.length) {
            return {
              ok: true,
              action,
              name: card.name,
              total: list.length,
              lines: [
                `「${card.name}」自带 ${list.length} 个开场：`,
                ...list.map((one, i) => `${i + 1}. 【${one.tag}】${one.text.slice(0, 80).replace(/\s+/g, ' ')}…`),
                '',
                `要哪个就 rp_card(action=opening, index=N) 取全文；不选默认第 1 个。`,
              ],
            }
          }
          const chosen = list[want - 1]
          return {
            ok: true,
            action,
            name: card.name,
            index: want,
            lines: [
              `开场 #${want}【${chosen.tag}】（作者原文：照它复现，不要改写、不要缩写、不要换视角；复现完只在末尾补必要的礼仪，然后停在玩家能接住的地方）：`,
              chosen.text.slice(0, 8000),
            ],
          }
        }

        // switch：换角色，并把它记成「当前角色」，之后每轮注入都带着
        if (action === 'switch' || action === 'pick') {
          const keyword = String(args.name || args.query || '').trim()
          if (!keyword) return { ok: false, action, lines: ['需要 name（卡名或文件名片段）'] }
          const found = findCards(ensureIndex(), keyword, 3)
          if (!found.length) return { ok: false, action, lines: [`卡库里没有「${keyword}」`] }
          const entry = found[0]
          const card = loadCard(entry.file)
          if (!card) return { ok: false, action, lines: [`卡读不出来：${path.basename(entry.file)}`] }
          const blockedPick = lockGate(entry.file)
          if (blockedPick) return blockedPick
          // ★2026-11-10：写记忆条目**不能拖垮 pick**（cast 分支同样处理过）。
          //   以前 body 为空会直接抛「body 不能为空」，整次 pick 失败，模型只能反复重试同一个调用。
          //   现在记忆写失败只记一行提示，卡照锁 —— 用户要的是能开戏，不是记忆完美。
          let memoryNote = ''
          try {
            saveEntry(root, {
              kind: 'character',
              name: card.name || entry.title,
              body: renderCardMemory(card) || card.description,
              tags: ['角色卡', ...card.tags],
            })
          } catch (error) {
            memoryNote = `（角色记忆条目没写成：${String((error && error.message) || error)}；本局照常，不影响演出）`
          }
          const prevCur = readCurrent(currentFile) || {}
          const prevCards = Array.isArray(prevCur.cards) ? prevCur.cards : prevCur.character ? [{ name: prevCur.character, file: prevCur.file }] : []
          const nextCards = prevCards.some((c) => c.file === entry.file)
            ? prevCards
            : [...prevCards, { name: card.name || entry.title, file: entry.file }]
          writeCurrent(
            {
              character: nextCards[0] ? nextCards[0].name : card.name || entry.title,
              cards: nextCards,
              count: nextCards.length,
              // ★2026-11-10：只写**这张卡自己的** scenario，不再 `|| prevCur.scenario`。
              //   以前没背景时会沿用上一个会话留下的背景，current.json 于是出现
              //   「character=莉安娜、file=特异点99、scenario 讲莉安娜」这种半更新状态，
              //   提示词把它当本会话背景读进去 —— 用户看到的就是「记忆混乱」。
              scenario: card.scenario || '',
              source: `${entry.root || ''}/${entry.group || ''}`.replace(/^\/|\/$/g, ''),
              file: entry.file,
            },
            currentFile,
          )
          const added = addCard(root, sessionId, { file: entry.file, name: card.name || entry.title, rel: entry.rel || '' })
          // 背景按会话记：锁上这张卡时把它自带的 scenario 一并落到本会话，跨会话不互相污染。
          // 只在卡组真加进去之后写（卡组满了要用户先 leave，否则会把没进卡组的卡背景覆盖上去）。
          if (sessionId && card.scenario && added.ok) setScenario(root, sessionId, card.scenario.slice(0, 800))
          if (!added.ok && added.reason === 'full') {
            return {
              ok: false,
              action,
              locked: true,
              lines: [`卡组已满（${MAX_CARDS} 张）：${(added.cards || []).map((c) => '《' + c.name + '》').join('')}`, '先用 rp_card(action=leave, name=…) 移出一张。'],
            }
          }
          const grew = added.added !== false
          const lines = [
            grew
              ? `已把「${card.name || entry.title}」加进本局卡组（现在 ${(added.cards || []).length} 位）`
              : `「${card.name || entry.title}」已经在本局卡组里了`,
            memoryNote || '记忆条目已更新，之后每轮摘要都带着它。',
          ]
          const alts = Array.isArray(card.alternateGreetings) ? card.alternateGreetings : []
          if (alts.length) {
            lines.push(`另有 ${alts.length} 个备用开场，要换开局就说一声。`)
          }
          if (sessionId) lines.push('本会话已锁定这张卡 —— 换角色请新建会话。')
          if (card.scenario) lines.push('背景：' + card.scenario.slice(0, 400))
          for (const [title, body] of buildStageKit(card)) {
            lines.push('', `【${title}】`, body)
          }
          // 开场：first_mes + alternate_greetings 合成候选池，随机抽一个（避免每局开头都一样）
          const openings = openingsOf(card)
          if (openings.length) {
            const chosen = openings[0]
            lines.push('', `本卡自带 ${openings.length} 个开场（作者写的，优先复用它，不要自己另起）：`)
            openings.forEach((one, i) => lines.push(`  ${i + 1}. 【${one.tag}】${one.text.slice(0, 80).replace(/\s+/g, ' ')}…`))
            lines.push('', `默认开场 #1【${chosen.tag}】原文（先别演；开场介绍之后照它复现，不要改写、不要缩写、不要换视角）：`)
            lines.push(chosen.text.slice(0, 8000))
            if (openings.length > 1) lines.push('', `要换别的开场才用 rp_card(action=opening, index=2..${openings.length})。**不要为了取开场再调 opening / read —— #1 原文就在上面。**`)
            lines.push('', '下一步：先做开场介绍，不要进主剧情——① 一句话说清这个角色是谁、在哪、与你什么关系（说明开场讲的是哪个场景）；② 列 3-5 条开戏前该知道的事（身份/脾气/忌讳/当前局势/时间地点）；③ 说一句「本卡自带 N 个开场，默认从 #1 开始」，让用户挑或直接说开始；④ 问一句从哪开始就停。用户回应之后再照开场原文起戏：先原文复现，末尾只补必要的礼仪（场景锚点 + 一个玩家能接住的着力点），不改写作者的文字。')
          }
          if (card.book.length) {
            // 目录（不含正文）：先看清有哪些条目，再一次性取要用的几条 —— 别逐条试探。
            const index = bookIndex(card, 20)
            lines.push('', `世界书 ${index.total} 条，目录（只给关键词与开头，正文用 book 取）：`)
            lines.push(...renderBookIndex(index, 20))
            lines.push('取正文：rp_card(action=book, name=当前卡, query="词1 词2 词3") —— 要问几件事就写进同一个 query，别为同一场景换措辞重复取；演到目录里的词出现前先取，别自己编设定。')
          }
          if (found.length > 1) lines.push('', `另有 ${found.length - 1} 张相似卡：` + found.slice(1).map((e) => e.title).join(' / '))
          return { ok: true, action, name: card.name, lines }
        }

        // leave：把一张卡移出本局卡组（群聊里换人用）
        if (action === 'leave') {
          const keyword = String(args.name || args.query || '').trim()
          if (!keyword) return { ok: false, action, lines: ['需要 name（要移出的卡名）'] }
          const cur = getLock(root, sessionId)
          if (!cur) return { ok: false, action, lines: ['本会话还没有卡组'] }
          const hit = cur.cards.find((c) => c.name.includes(keyword) || keyword.includes(c.name) || c.file.includes(keyword))
          if (!hit) return { ok: false, action, lines: [`卡组里没有「${keyword}」`] }
          const res = removeCard(root, sessionId, hit.file)
          const rest = (res.cards || []).map((c) => '《' + c.name + '》').join('')
          const lines = [res.cleared ? `已移出《${hit.name}》，卡组清空（回到未锁定状态）` : `已移出《${hit.name}》，还剩 ${rest}`]
          return { ok: true, action, name: hit.name, lines }
        }

        // background：换背景/设定。既可以拿另一张卡的场景设定当背景，也可以直接给文本。
        if (action === 'background') {
          const keyword = String(args.name || '').trim()
          const given = String(args.query || '').trim()
          let label = '自定义背景'
          let scenario = given
          let extra = ''
          if (keyword) {
            const found = findCards(ensureIndex(), keyword, 1)
            if (found.length) {
              const card = loadCard(found[0].file)
              if (card) {
                label = card.name || found[0].title
                scenario = [card.scenario, card.description].filter(Boolean).join('\n\n') || given
                if (card.book.length) extra = `，带世界书 ${card.book.length} 条（rp_card(action=book) 取）`
              }
            }
          }
          if (!scenario) return { ok: false, action, lines: ['需要 name（拿某张卡当背景）或 query（直接给背景文本）'] }
          saveEntry(root, { kind: 'world', name: label, body: scenario, tags: ['背景', keyword ? '取自卡' : '自定义'] })
          // ★2026-11-10：背景写**本会话的锁**（按会话隔离）。全局 current.json 只保留
          //   「上次用过的卡」，不再承载 scenario —— 以前写全局会导致下一个会话换了卡
          //   以后，提示词还在讲上一个会话的背景（用户看到的「记忆混乱」）。
          const scoped = setScenario(root, sessionId, scenario.slice(0, 800))
          if (!scoped) {
            const cur = readCurrent(currentFile) || {}
            writeCurrent({ ...cur, scenario: scenario.slice(0, 800) }, currentFile)
          }
          return {
            ok: true,
            action,
            lines: [`背景已换成「${label}」${extra}${scoped ? '（只在本会话生效）' : '（本会话尚未锁卡，已记为全局背景）'}`, '', scenario.slice(0, 900)],
          }
        }

        return { ok: false, action, lines: [`未知 action「${action}」`] }
      } catch (error) {
        return { ok: false, action, lines: [String((error && error.message) || error)] }
      }
    },
  }

  return [rpMemory, rpCard]
}

/** 给 systemPrompt 段用的一行摘要，尽量短。 */
export function digestOneLiner(config = {}) {
  const root = config.root && String(config.root).trim() ? String(config.root) : defaultRoot()
  try {
    const result = digest(root, { perKind: 3 })
    if (!result.total) return '扮演记忆（rp_memory）目前是空的。这一局开头写几条：角色、世界、以及当下场景。'
    const parts = KINDS_LIST.map((kind) => `${KIND_LABEL[kind]}${result.byKind[kind] || 0}`).join(' / ')
    const names = result.recent.slice(0, 6).map((entry) => `${KIND_LABEL[entry.kind]}:${entry.name}`).join('、')
    return `扮演记忆 ${result.total} 条（${parts}）。近期：${names || '无'}。细节用 rp_memory(action=read|recall)。`
  } catch {
    return '扮演记忆暂不可读；本局照常演，收尾时再补写。'
  }
}

/**
 * 工具结果的模型可见文本（output.render 用）。
 *
 * DSH 的 `tools.register()` 要求每个工具声明 `output.render(args, value)`，返回值是
 * 内容块数组。本包的 execute 返回结构化对象（lines / hits / rows / total …），
 * 这里统一折成文本：优先 lines（rp_memory 与多数分支已经排好版），其次 hits/rows，
 * 最后 JSON 兜底（截断 8000 字，避免把整张卡倒进上下文）。
 */
export function renderToolValue(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return String(value ?? '')
  if (Array.isArray(value.lines) && value.lines.length) return value.lines.join('\n')
  if (typeof value.text === 'string') return value.text
  const parts = []
  if (value.ok === false) parts.push('失败：' + String(value.reason || value.message || '未知原因'))
  if (value.total !== undefined) parts.push('共 ' + value.total + ' 条')
  const listOf = (items) =>
    items
      .map((item) => {
        if (typeof item === 'string') return item
        if (!item || typeof item !== 'object') return String(item)
        return String(item.name || item.title || item.file || JSON.stringify(item))
      })
      .slice(0, 40)
      .join('\n')
  if (Array.isArray(value.hits) && value.hits.length) parts.push(listOf(value.hits))
  if (Array.isArray(value.rows) && value.rows.length) parts.push(listOf(value.rows))
  return parts.filter(Boolean).join('\n') || JSON.stringify(value, null, 2).slice(0, 8000)
}
