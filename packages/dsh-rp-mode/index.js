/**
 * dsh-rp-mode — 扮演模式的 agent preset + 扮演记忆插件。
 *
 * 一个包两个角色：
 * 1. `cordis.patch.yml` 向 profile 声明一个 agent preset（id: roleplay），
 *    只挂人设、联网查找、扮演记忆、压缩——没有终端、文件、代码、子代理。
 * 2. `index.js` 自身作为 preset 里的一个插件行，注册 `rp_memory` 工具与一段
 *    系统提示词摘要（每轮注入当前扮演记忆的存量与近期条目）。
 *
 * 记忆目录与工作记忆完全分开：默认 ~/.dsh/rp-memory。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTools, digestOneLiner } from './lib/tools.js'
import { mountRoutes } from './lib/webui.js'
import { cardsSummary, readCurrent, scenarioForSession } from './lib/card.js'
import { agentSessionId, getLock, resolveCardsFor } from './lib/session.js'
import { defaultRoot } from './lib/store.js'
import {
  bindSessionSource,
  channelLog,
  channelPromptNote,
  installChannel,
  loadChannels,
  resolvePresetOf,
} from './lib/channel.js'

export const name = 'dsh-rp-mode'

/**
 * tools 依赖显式声明（2026-11-10 起）。
 *
 * 只声明 tools 一个：`ctx.get('tools')` 在 preset 隔离域里解析到的是宿主根层的
 * 实例，注册进去的工具只出现在 `view()` 的合并视图（日志「可见 72 → 17」），而
 * agent 每步真正发出去的函数表里没有它 —— 实测扮演会话模型自述「本轮函数列表里
 * 没有 rp_card」，请求体 tools 只剩 web_fetch / web_search 两个。声明 inject 后
 * 属性访问 `ctx.tools` 拿到的是当前 realm 绑定的实例，注册才落到该 agent 自己的层。
 *
 * systemPrompt 仍然走 `ctx.get`：当年 `inject = ['tools','systemPrompt']` 的事故是
 * preset scope 下 systemPrompt 不可见导致插件整个不激活，别顺手加回来。
 */
export const inject = ['tools']

/**
 * 服务访问一律走 `ctx.get(name)`（软访问，不需要声明 inject）。
 *
 * 血泪：曾经写过 `export const inject = ['tools','systemPrompt']` —— cordis 的 inject 是**硬依赖**，
 * preset scope 下任一服务不可见，整个插件就不激活，`rp_card` / `rp_memory` 会一起消失
 * （现象：扮演会话里 rp_card 没了）。`ctx.get()` 拿不到就返回 undefined，插件照常加载，
 * 各自的能力按需降级 —— 这才是扮演插件该有的姿态。
 */

/** 提示词段位置：部署 persona 后缀（10200）之后。 */
const SECTION_ORDER = 10250
const SECTION_NAME = 'roleplay:memory'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // 日志失败不影响功能
  }
}

/**
 * 工具闸门的落盘诊断 —— 桌面壳不保留插件 stdout，光靠 logger 看不到结果，
 * 所以这条线单独写到记忆目录，事后能直接 read 出「限制成没成、为什么没成」。
 */
const DIAG_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || HERE,
  '.dsh',
  'rp-memory',
  'toolguard.log',
)

function diag(line) {
  try {
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true })
    fs.appendFileSync(DIAG_FILE, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    // 诊断写不进去不影响功能
  }
}

/**
 * 冷启动时 apply() 可能早于 tools 服务就绪，轮询等；同进程只注册一次，
 * 因为 cordis 会对同一插件多次调用 apply()。
 */
const STATE_KEY = Symbol.for('dsh-rp-mode.state')

function getState(ctx) {
  const owner = (ctx && ctx.root) || ctx || globalThis
  if (!owner[STATE_KEY]) owner[STATE_KEY] = { registered: false, waiting: false }
  return owner[STATE_KEY]
}

/**
 * 取 tools 服务。
 *
 * preset 的 isolate realm 里 `ctx.get('tools')` 沿祖先链解析，可能拿到宿主根服务，
 * 于是工具被注册进宿主层、preset 会话的 view 看不见（实测 roleplay 会话请求头只剩
 * tool-web 的 2 个工具）。属性访问 `ctx.tools` 沿用当前 ctx 的 realm 绑定，优先它。
 *
 * 返回来源字符串一并落盘，避免下次又只能靠猜。
 */
export function pickTools(ctx) {
  try {
    const t = ctx && ctx.tools
    if (t && typeof t.register === 'function') return { tools: t, source: 'ctx.tools' }
  } catch {
    // 服务未就绪时属性访问会抛，正常
  }
  try {
    const t = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (t && typeof t.register === 'function') return { tools: t, source: 'ctx.get' }
  } catch {
    // 同上
  }
  return { tools: undefined, source: 'none' }
}

/**
 * 取**所有**可用的 tools 目标（0.6.2 起）。
 *
 * 实测（2026-11-10）：`sameTools=diff` —— agent.ctx 上的 tools 与插件 `ctx.tools`
 * 解析到的不是同一个对象；而工具真正进不进模型，取决于 agent 那一步 `resolve()`
 * 用的是哪一把。所以两条路径拿到的实例只要不是同一个，就**各注册一份**：
 * 名字在不同实例里互不冲突，多一份注册无副作用，但少注册一份就整批工具消失。
 *
 * @returns {{tools: any, source: string}[]} 去重后的目标，可为空
 */
export function pickToolTargets(ctx) {
  const out = []
  const push = (tools, source) => {
    if (!tools || typeof tools.register !== 'function') return
    if (out.some((t) => t.tools === tools)) return
    out.push({ tools, source })
  }
  try {
    push(ctx && ctx.tools, 'ctx.tools')
  } catch {
    // 服务未就绪时属性访问会抛，正常
  }
  try {
    push(ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null, 'ctx.get')
  } catch {
    // 同上
  }
  // ★0.6.3：再补一条**根 ctx** 路径。
  //   `register()` 内部是 `layers.effect(this.ctx, …)`，落哪一层由 `scopeOf(this.ctx)`
  //   决定；preset 子行的 ctx 带 scope 标签时，注册就落在那个 scope 层上，而 agent 的
  //   `view(scope)` 只 merge「global + agent 祖先链」，同层的兄弟 scope 看不见。
  //   根 ctx 一般无 scope 标签 ⇒ 落 global ⇒ 任何 agent 都能看见。
  try {
    const root = ctx && ctx.root
    push(root && root.tools, 'ctx.root.tools')
    push(root && typeof root.get === 'function' ? root.get('tools') : null, 'ctx.root.get')
  } catch {
    // 根 ctx 不可达时照旧
  }
  return out
}

/**
 * 多路注册里挑出「真正有效」的那一路（0.6.7）。
 *
 * 判定：某一路注册**之前** global 视图没有 rp_card、注册**之后**有了 —— 它就是
 * 把工具打进 global 层的那一路。按 targets 顺序取第一个命中的。
 * 一路都没命中返回 ''（调用方据此保留全部，不删 —— 删了可能整批不可见）。
 *
 * @param {{source: string, before: boolean, after: boolean}[]} states 每路的注册前后读数
 * @returns {string} 保留的路径名，或 ''
 */
export function pickKeeper(states) {
  for (const s of Array.isArray(states) ? states : []) {
    if (s && s.before === false && s.after === true) return String(s.source || '')
  }
  return ''
}

function registerWhenToolsReady(ctx, callback) {
  const state = getState(ctx)
  if (state.registered || state.waiting) return
  const started = Date.now()
  state.waiting = true
  const tick = () => {
    const picked = pickTools(ctx)
    const tools = picked.tools
    if (tools) state.toolSource = picked.source
    if (tools && typeof tools.register === 'function') {
      if (state.registered) return
      state.registered = true
      state.waiting = false
      try {
        callback(tools)
      } catch (error) {
        safeLog(ctx, 'warn', 'dsh-rp-mode: 注册工具抛错 ' + String((error && error.message) || error))
      }
      return
    }
    if (Date.now() - started > 60000) {
      state.waiting = false
      safeLog(ctx, 'warn', 'dsh-rp-mode: 60s 内没等到 tools 服务，工具未注册')
      return
    }
    setTimeout(tick, 250)
  }
  tick()
}

/** 摘要缓存：同一秒内多次组装只读一次盘。 */
/**
 * 提示词段缓存（2026-11-10 重写）。
 *
 * 键 = 会话 id + current.json mtime + 本会话卡组文件列表。
 * 以前是「5 秒时间窗 + 单条文本」，两个会话并发会互相串，切卡后也要等过期；
 * 现在切卡（pick / leave / current 重写）会改变键 → 立刻重算。
 */
const digestCache = new Map()
const DIGEST_TTL_MS = 5000
const DIAG_DIR = path.dirname(DIAG_FILE)
/** 卡摘要探针的去重键（单值够用：同一会话连发才需要）。 */
let lastProbe = ''
/** ★0.6.2：组装探针的去重键必须是「会话」，不然多会话会互相压掉对方的记录（实测已被混淆过）。 */
const lastAssembleProbe = new Map()

function rpRoot(config) {
  return config.root && String(config.root).trim() ? String(config.root) : defaultRoot()
}

function currentMtime(config) {
  try {
    const file = config.currentFile && String(config.currentFile).trim()
    return file ? fs.statSync(file).mtimeMs : 0
  } catch {
    return 0
  }
}

/** 会话维度摘要：背景优先读**本会话锁**，只在老会话没有会话级背景时才回退全局（且必须同源）。 */
function sessionSummary(config, cards, lock) {
  if (!cards || !cards.length) return ''
  let current = null
  try {
    current = readCurrent(config.currentFile)
  } catch {
    current = null
  }
  const scenario = scenarioForSession(lock, cards, current)
  return cardsSummary(cards, scenario)
}

/**
 * 组装期探针（2026-11-10 · 0.5.14 定位用）。
 *
 * `section.text(context)` 拿到的就是 `systemPrompt.assemble(context)` 的 context，
 * 里面既有 `agent`/`scope`，也有本步的 `toolSet`。宿主把工具 schema 交给模型走的是
 * `definitions(scope, toolSet)` —— 有 toolSet 时读的是 **toolSet.view(scope)**，不是
 * `ToolsService.view`。所以「channel 日志说 17 个、请求体只有 2 个」这段必须在
 * toolSet 上量一次，光看 view 会误判。
 */
let probeTools = null
let sharedDefinitions = []
/** 已在 agent 自己那层注册过的 agent（每个只做一次）。 */
const agentRegistered = new WeakSet()

/**
 * 把本包工具注册进 **agent 自己的注册层**（`agent.ctx`）。
 *
 * 为什么还要这条路：`view(scope)` 里 `own = layers.peek(scope)` 的注册无条件可见，
 * 而 `inherited`（其它层）要过每一层的 `admits()`。preset 隔离域里注册的工具
 * 在 agent 视角可能根本进不了 visible（回读 view(undefined) 6 个、命中 0）。
 * 这里在第一次见到 agent 时往它自己的层补一次 —— 晚一步（首轮工具表已定），
 * 但从第二轮起一定可见；首轮由提示词兜底。
 */
function registerForAgent(context) {
  const agent = context && context.agent
  if (!agent || typeof agent !== 'object' || agentRegistered.has(agent)) return
  agentRegistered.add(agent)
  try {
    const actx = agent.ctx
    let tools = actx && actx.tools
    if (!tools && actx && typeof actx.get === 'function') tools = actx.get('tools')
    if (!tools || typeof tools.register !== 'function') {
      diag('[agent-reg] agent.ctx 上没有可用的 tools.register')
      return
    }
    let ok = 0
    for (const definition of sharedDefinitions) {
      try {
        tools.register(definition)
        ok += 1
      } catch (error) {
        diag('[agent-reg] 注册失败 ' + String(definition && definition.name) + ': ' + String((error && error.message) || error).slice(0, 100))
      }
    }
    const view = typeof tools.view === 'function' ? tools.view(agent) : null
    const names = view && view.visible ? [...view.visible.keys()] : []
    diag(
      `[agent-reg] 注册 ${ok}/${sharedDefinitions.length} → agent 视角 visible=${names.length} ` +
        `rp_card=${names.includes('rp_card') ? 'yes' : 'no'} rp_memory=${names.includes('rp_memory') ? 'yes' : 'no'}`,
    )
  } catch (error) {
    diag('[agent-reg] 抛错 ' + String((error && error.message) || error))
  }
}

function probeAssemble(context) {
  if (!probeTools || typeof probeTools.view !== 'function') return
  try {
    const scope = (context && (context.agent || context.scope)) || undefined
    const view = probeTools.view(scope)
    const toolSet = context && context.toolSet
    let setSize = 'no-toolSet'
    let setHasCard = '-'
    let setNames = '-'
    if (toolSet && typeof toolSet.view === 'function') {
      try {
        const m = toolSet.view(scope)
        setSize = String(m && m.size !== undefined ? m.size : '?')
        setHasCard = m && typeof m.has === 'function' ? (m.has('rp_card') ? 'yes' : 'no') : '?'
        setNames = m && typeof m.keys === 'function' ? [...m.keys()].sort().join(',') : '?'
      } catch (error) {
        setSize = 'throw:' + String((error && error.message) || error)
      }
    }
    // ★0.5.15：把 registrations / knownNames 也量出来 —— 「visible 里没有」要分清
    //   是「没注册进去」还是「注册了但被 admits() 挡掉」。
    const regSize = view && view.registrations ? view.registrations.size : -1
    const knownSize = view && view.knownNames ? view.knownNames.size : -1
    // ★0.6.0：把「两个 tools 实例」这个假说直接量出来 ——
    //   agent 自己 ctx 上解析到的 tools 与本插件注册用的那把是不是同一个对象。
    //   same = 同一个实例（那问题在 scope/作用域）；diff = 确实是两个实例。
    let sameTools = '-'
    try {
      const actx = context && context.agent && context.agent.ctx
      const at = actx ? actx.tools : null
      sameTools = at ? (at === probeTools ? 'same' : 'diff') : 'none'
    } catch {
      sameTools = 'throw'
    }
    const line =
      `[assemble] sid=${agentSessionId(context && context.agent) || '-'} ` +
      `agent=${context && context.agent ? 'yes' : 'no'} scope=${context && context.scope ? 'yes' : 'no'} ` +
      `view=${view && view.visible ? view.visible.size : '?'} viewCard=${view && view.visible && view.visible.has('rp_card') ? 'yes' : 'no'} ` +
      `reg=${regSize} regCard=${view && view.registrations && view.registrations.has('rp_card') ? 'yes' : 'no'} known=${knownSize} ` +
      `sameTools=${sameTools} toolSet=${setSize} toolSetCard=${setHasCard} ` +
      // ★0.6.0：光比数量会漏「数量不变但内容变了」（第一轮 vs 第二轮正好是这种）。
      //   把两边名字都打出来，顺序无关地排一下，集合一变这行就会变、也就会落盘。
      `viewNames=${((view && view.visible) ? [...view.visible.keys()] : []).sort().join(',')} ` +
      `setNames=${setNames}`
    const sidKey = (context && context.agent ? agentSessionId(context.agent) : '') || '-'
    if (lastAssembleProbe.get(sidKey) === line) return
    lastAssembleProbe.set(sidKey, line)
    if (lastAssembleProbe.size > 64) lastAssembleProbe.clear()
    diag(line)
  } catch (error) {
    diag('[assemble] 抛错 ' + String((error && error.message) || error))
  }
}

/** 段落取值探针：只记变化，够判「这个会话读到哪张卡」。 */
function probeDigest(sid, preset, cards) {
  const line =
    `sid=${sid || '(空)'} preset=${preset || '(空)'} cards=${cards ? cards.length : 'none'} ` +
    `names=${(cards || []).map((c) => c.name).join('/') || '-'}`
  if (line === lastProbe) return
  lastProbe = line
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true })
    fs.appendFileSync(path.join(DIAG_DIR, 'prompt-probe.log'), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    // 诊断写不进去不影响功能
  }
}

/**
 * 中和模板变量。
 *
 * DSH 组装提示词时会**校验** section 里的 `{{name}}`，只认已注册变量（provider / model），
 * 出现别的就让整轮请求直接失败：
 *   `unknown prompt variable "{{user}}" in section "roleplay:memory"`
 * 角色卡（酒馆格式）正文里普遍带 `{{char}}` / `{{user}}`，一旦进到摘要里就会把扮演打成 500。
 * 这里把双花括号拆开——视觉上还是原文，但不再被当成变量。
 */
function neutralizePromptVars(text) {
  return String(text || '')
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
}

/**
 * 提示词出口用的工具面说明：从 channel.json 取 roleplay 通道的 prompt.note。
 * 提示词段不带 agent 上下文（section.text 无参），所以这里按本插件唯一服务的
 * preset 静态取；preset 名与 cordis.patch.yml 里的 id 一致。
 */
function presetChannelNote() {
  try {
    const channels = loadChannels()
    const cfg = channels && channels.presets ? channels.presets.roleplay : null
    return channelPromptNote({ preset: 'roleplay', cfg })
  } catch {
    return ''
  }
}

function cachedDigest(config, agent) {
  const now = Date.now()
  const sid = agentSessionId(agent)
  const cards = resolveCardsFor(rpRoot(config), sid)
  const lock = getLock(rpRoot(config), sid)
  const key = [sid || '-', currentMtime(config), cards ? cards.map((c) => c.file).join('|') : '', lock ? String(lock.scenario || '').length : 0].join('#')
  const hit = digestCache.get(key)
  if (hit && now - hit.at < DIGEST_TTL_MS) return hit.text
  const current = sessionSummary(config, cards, lock)
  const memory = digestOneLiner(config)
  const RULES = [
    '演出纪律：',
    '1. 视角：卡里有格式要求就按卡；没有则第三人称写动作与环境，第二人称称呼你。',
    // ★2026-11-10（用户实测：描写不足、冲击力不够）：原 200-400 字上限把每轮压成梗概。
    //   改为下限+上限区间，并把「字数不够就是细节没展开」写成判据，指向身体与感官。
    '2. 长度（硬性）：每轮正文 1200-2500 字；性爱或重点场面 2000-3500 字。字数不够就是细节没展开——补身体、补动作、补感官、补对话回合，不要补废话。收在同一场景的进行时里，不写总结、不写「接下来你打算怎么办」。',
    '3. 不替你（用户）做决定、不代写他的台词与内心。',
    '4. 不在故事里解释自己在扮演，不写「好的，我明白了」这类壳子。',
    '5. 时间与场景要往前走，别在同一句话上打转。',
    '6. 世界书（硬性）：pick 之后、开场之前**必须先** rp_card(action=book, query=词) 取与首幕相关的条目正文；演出中凡触发词出现也要先取再写。设定只能来自卡内世界书，绝不自己编。这几步不可为省步数跳过——宁可多一次调用。',
    '7. 每 8-10 轮把这一幕写进 rp_memory(kind=scene)，长会话才不会失忆。',
    '8. 卡组里有多位角色时就是群聊：各角色按自己的性格说话，不要写成同一个人；用名字或明显特征区分谁在说。',
    '9. 状态栏 / 变量块只在需要时输出，且不要照抄上一轮的数字与文字，只写变化的部分。',
    '10. 用户说「再来一版」时，把上一轮重写一遍、换一种走向；说「两版」时给两个版本，用 ==== 分隔，等他挑。',
    // ★2026-11-08（用户贴图实测）：角色卡（酒馆格式）常自带 HTML 状态栏模板，
    //   模型会连 <details>/<div style="…"> 一起吐出来；DSH 对话框不渲染 HTML，
    //   用户看到的是整段源码。禁止标签，只留纯文本三类信息。
    '11. 不输出 HTML 标签：<details>、<summary>、<div style="…">、<ul>/<li> 在 DSH 里都不渲染，会原样变成源码。状态面板写成纯文本或 Markdown 列表，最多 6 行，只写「处境 / 状态 / 可见特征」。',
    '12. 卡里带 HTML 状态栏模板时，把它改写成纯文本再写；不要照抄标签、内联样式与颜色值。',
    // ★2026-11-08（用户要求）：卡加载后**先介绍、后开戏**。
    // 以前的毛病是选完卡立刻按 first_mes 铺开一大段剧情，用户还没表态就被推着走。
    '13. 首轮礼仪：卡刚加载上来、用户还没回应过任何剧情时，不要进主剧情。先做开场介绍——① 一句话说清这个角色是谁、在哪、与你什么关系；② 列 3-5 条「开戏前该知道的事」（身份、脾气、忌讳、当前局势、时间地点）；③ 说明本卡自带几个开场、默认从第几个开始（没有自带开场就说「按标准开场来」）；④ 结尾问一句「从哪开始？」就停。总长 300-500 字。',
    // ★2026-11-08（用户要求）：有自带开场就优先复现；★2026-11-10 改为复现后必须扩写。
    '14. 开戏：卡有自带开场就以**原文为骨架**——先照它复现（不改写核心事实、不换视角、不替换人名），复现完**必须把骨架扩写成完整画面**：环境的光影温度气味、角色身体的姿态与细微动作、衣物与皮肤的状态、呼吸与声音、一处可被回应的停顿。总长 1000-1800 字。不要停在「着力点」上收尾，也不要复述开场已有的信息。',
    '15. 卡没有自带开场时，按同一套要求现写：时间地点 + 一组感官细节（光/声/气味/温度/触感）+ 角色的具体身体动作 + 一句能被接住的台词或动作，总长 1000-1800 字。',
    '16. 开场三条底线：不替玩家行动、不复述已经写过的信息、不在开场里塞总结或「请选择」。用户第二次回应起转入正常叙事，此后不再重复介绍。',
    // ★2026-11-10（用户要求：色情冲击力不够、身体要直接描写）：成人场面不许淡出、不许隐喻替代。
    '17. 成人/性描写（硬性，用户明确要求时生效）：直接写身体与性行为。用明确的词——阴茎、龟头、冠状沟、阴道口、内壁、阴蒂、乳头、乳房、臀、腰、大腿根、精液、爱液；写插入的角度与深度、抽送的节奏与摩擦、温度与湿度、肌肉的收缩与痉挛、液体的流动与声音、皮肤的红与汗、气味的浓淡、呼吸的断裂与嗓子的哑。禁止用「那里」「结合」「融为一体」「做了很久」这类替代与概括，禁止淡出、跳切、一夜过场。进程按身体节奏一段一段推进：前戏 → 进入 → 节奏变化 → 失控 → 高潮 → 余韵；用户说跳过才跳。',
    // ★2026-11-10：生理反应要真实，且各角色反应按性格分化，不能全员一套叫床。
    '18. 生理与性格（硬性）：写酸胀、发麻、发抖、腿软、膝盖磨红、腰塌下去、被撞得说不出完整句子、汗把头发黏在脸侧。角色的反应服从卡内性格——毒舌的边骂边软、冷淡的被弄到失语、强势的会反过来夺主导；不要所有人同一套台词与同一个姿势。',
  ].join('\n')
  const locked = Boolean(cards && cards.length)
  const gate = locked
    ? '本会话角色已定，不能中途更换；要换角色请新建会话。刚选定、用户还没表态时，按第 13 条先做开场介绍，不要直接进剧情。'
    : '开局先挑卡：用户点名了卡就直接 rp_card(action=pick, name=…)，不用先 search；没说名字才用 rp_card(action=search) 或 action=list 浏览。pick 之后**必须先**用 rp_card(action=book, query=…) 取与首幕相关的世界书正文（卡里没有世界书条目才跳过），再按第 13 条做开场介绍——book 这一步不许为省步数跳过。read / opening 不必再调，pick 已带回卡设定与 #1 开场原文。'
  // 卡正文 / 记忆正文里可能带 {{char}}、{{user}} 这类酒馆占位符，必须先中和再进 section，
  // 否则 DSH 的变量校验会让整轮请求失败（见 neutralizePromptVars 注释）。
  // ★通道出口 3（提示词）：把这个会话真实拥有的工具面写进纪律之前——
  //   工具已经由 lib/channel.js 的 view 过滤砍到白名单，这里补一句「调不到就是没有」，
  //   否则模型会按旧习惯假装有终端/文件。
  const chNote = presetChannelNote()
  const text = neutralizePromptVars([RULES, chNote, gate, current, memory].filter(Boolean).join('\n'))
  digestCache.set(key, { at: now, text })
  if (digestCache.size > 32) digestCache.clear()
  probeDigest(sid, resolvePresetOf(agent), cards)
  return text
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-rp-mode 加载失败：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  const config = loadConfig()

  // 判定点要用会话快照读 preset（agent 上没有可靠字段）。绑不上就 fail-open。
  try {
    bindSessionSource(ctx)
  } catch (error) {
    channelLog('[install] 会话快照未绑定: ' + String((error && error.message) || error), config)
  }

  // 卡库面板后端：只读三条路由，webServer 没就绪就自己重试，失败不影响扮演。
  try {
    mountRoutes(ctx, config)
  } catch (error) {
    safeLog(ctx, 'warn', 'dsh-rp-mode: 卡库面板路由未挂 ' + String((error && error.message) || error))
  }

  // 提示词段：静态纪律 + 每次组装时刷新的一句记忆摘要。
  try {
    const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
    if (prompt && typeof prompt.section === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(
        () =>
          prompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            text: (context) => {
              // ★0.6.0：不再往 agent 层补注册（那条路 0.5.15 实测无效：
              //   注册 2/2 成功但 view(agent) 仍是 2、rp_card 仍不可见）。
              //   工具面只由 preset 行清单决定，这里只留组装期观测。
              probeAssemble(context)
              return cachedDigest(config, context && context.agent)
            },
          }),
        'rp-mode.section()',
      )
    }
  } catch (error) {
    safeLog(ctx, 'warn', 'dsh-rp-mode: 提示词段未注册 ' + String((error && error.message) || error))
  }

  // ★0.6.0 重写：与官方 tool-web 完全同构 —— 在 apply 里**同步**注册，不轮询、
  //   不猜实例、不再包 ToolsService.view、不再往 agent 层补注册。
  //
  //   为什么这么改（2026-11-10 实测链）：
  //     · 模型拿到的工具表是 `definitions(scope, toolSet)` → `toolSet.view(scope)`，
  //       toolSet 是 agent-loop 每步 `loopCtx.tools.resolve({agent})` 冻结的快照；
  //       插件侧包 `ToolsService.view` 改不到它（dsh-tools/lib/index.js:542-581）。
  //     · 平台给的收窄只有两条正路：preset 里不挂载 / `agent.ctx.tools.restrict()`。
  //       本包不再有第三条。
  //     · 旧路径靠 setTimeout 轮询等 tools 就绪；官方行都是 inject=['tools'] 由 cordis
  //       等到服务就绪才 apply，同步注册天然落对作用域。这里跟官方对齐。
  const defsNow = createTools(config)
  // ★0.6.2：两条路径都取，拿到几个不同实例就注册几份 ——
  //   实测 agent 读的实例与 ctx.tools 不是同一个（sameTools=diff），
  //   而工具在不在模型手里，只看 agent 那一步 resolve 用的是哪一把。
  const targets = pickToolTargets(ctx)
  if (targets.length) {
    sharedDefinitions = defsNow
    probeTools = targets[0].tools
  }
  const syncRegister = () => {
    if (!targets.length) {
      diag('[register] tools 不可用（两条路径都没拿到），本行工具未注册')
      return () => {}
    }
    // ★0.6.7（用户要求：重复注册要差异化）：
    //   多路注册是为了「总有一路能落对层」，但两份**完全相同**的定义同时留着是浪费，
    //   卸载时还留残影。做法：逐路注册，每注册完一路就回读 global 视图，
    //   **第一次让 rp_card 出现在 global 层**的那一路记为 keeper（真正的有效路径），
    //   其余各路的 handle 立刻 dispose。一路都没打进 global 时**全部保留**（不敢删，
    //   那时 rp_* 可能只在 agent 层可见，删掉就没工具了）。
    const globalHasCard = (tools) => {
      try {
        const v = typeof tools.view === 'function' ? tools.view(undefined) : null
        return Boolean(v && v.visible && v.visible.has('rp_card'))
      } catch {
        return false
      }
    }
    const keepers = []
    const perTarget = []
    const summary = []
    const states = []
    for (const target of targets) {
      const before = globalHasCard(target.tools)
      const handles = []
      let ok = 0
      const failed = []
      for (const definition of defsNow) {
        try {
          handles.push(target.tools.register(definition))
          ok += 1
        } catch (error) {
          failed.push(String(definition?.name || '?'))
          safeLog(ctx, 'warn', 'dsh-rp-mode: 注册工具失败 ' + String(definition?.name || '?') + ' ' + String((error && error.message) || error))
        }
      }
      const after = globalHasCard(target.tools)
      perTarget.push({ target, handles })
      states.push({ source: target.source, before, after })
      summary.push(target.source + '=' + ok + '/' + defsNow.length + (failed.length ? '!' + failed.join('|') : ''))
    }
    const keeper = pickKeeper(states)
    if (keeper) keepers.push(keeper)
    diag(
      '[register] 同步注册 ' + summary.join(' ') +
        ' [' + defsNow.map((d) => d.name).join(',') + '] 路数=' + targets.length,
    )
    // 差异化：留 keeper 那一路，其余释放。
    let released = []
    if (keepers.length) {
      released = perTarget.filter((p) => p.target.source !== keepers[0])
      for (const p of released) {
        for (const handle of p.handles) {
          try {
            handle?.dispose?.()
          } catch {
            // 释放失败不影响 keeper
          }
        }
      }
      diag(
        '[register] 保留 ' + keepers[0] + '（global 命中）· 释放 ' +
          (released.length ? released.map((p) => p.target.source).join(',') : '(无需释放)'),
      )
    } else {
      diag('[register] 无 global 命中 → 保留全部 ' + targets.length + ' 路（不敢删，删了可能整批不可见）')
    }
    return () => {
      for (const p of perTarget) {
        for (const handle of p.handles) {
          try {
            handle?.dispose?.()
          } catch {
            // 卸载失败不影响禁用
          }
        }
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(syncRegister, 'rp-mode.tools()')
  else syncRegister()
  // ★0.6.3：注册完立刻回读**全局视图**（view(undefined) 只取 global 层 + 无 scope 链）。
  //   命中 rp_card ⇒ 注册落在 global 层，任何 agent 的 view/toolSet 都会 merge 到它；
  //   没命中 ⇒ 注册落在某个 scope 层（preset 子行自己的 scope），agent 的祖先链里
  //   没有它 —— 这就是 0.6.0/0.6.1/0.6.2「注册 2/2 但 setNames 没有 rp_*」的成因判定。
  try {
    const g = probeTools && typeof probeTools.view === 'function' ? probeTools.view(undefined) : null
    const names = g && g.visible ? [...g.visible.keys()] : []
    const hit = ['rp_card', 'rp_memory'].filter((n) => names.includes(n))
    diag(
      '[register] 回读 global view=' + names.length + ' 命中[' + hit.join(',') + ']' +
        (hit.length ? '（落在 global 层）' : '（← 没落在 global 层，agent 祖先链看不到）'),
    )
  } catch (error) {
    diag('[register] 回读 global view 失败：' + String((error && error.message) || error))
  }
  safeLog(ctx, 'info', 'dsh-rp-mode ready（' + defsNow.length + ' 个工具，同步注册）')

  const legacyRegisterWhenToolsReady = (tools) => {
    const definitions = defsNow
    const registerAll = () => {
      const handles = []
      const failed = []
      for (const definition of definitions) {
        try {
          handles.push(tools.register(definition))
        } catch (error) {
          failed.push(String(definition?.name || '?'))
          safeLog(ctx, 'warn', 'dsh-rp-mode: 注册工具失败 ' + String(definition?.name || '?') + ' ' + String((error && error.message) || error))
        }
      }
      if (failed.length) {
        // ★只统计"尝试次数"会骗人：register 的校验（如缺 output.render）会抛错，
        //   而旧日志照样写「注册 2 个工具」。这里把成功数与失败名一起落盘。
        channelLog('[register] 失败 ' + failed.join(',') + '（成功 ' + handles.length + '/' + definitions.length + '）', config)
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
    safeLog(ctx, 'info', 'dsh-rp-mode ready（' + definitions.length + ' 个工具）')
    // 落盘证据：证明「插件到底激活没、注册了几个工具」。桌面壳不留插件 stdout，
    // 之前排查 rp_card 消失时就是因为没有这一行而只能猜。
    diag('apply 完成：注册 ' + definitions.length + ' 个工具 [' + definitions.map((d) => d.name).join(',') + '] tools 来源=' + String(getState(ctx).toolSource || '?'))
    // ★注册完立刻回读一次（此时 view 过滤器还没装，读的是原始视图）：
    //   「注册成功」不等于「进了这个实例」。上一轮就是注册成功却发不出去，
    //   靠这行能一眼分出「注册错实例」和「注册对但被过滤」。
    try {
      const raw = typeof tools.view === 'function' ? tools.view(undefined) : null
      if (raw && raw.visible) {
        const names = [...raw.visible.keys()]
        const hit = ['rp_card', 'rp_memory'].filter((n) => raw.visible.has(n))
        diag('注册后回读 view(undefined)：' + raw.visible.size + ' 个，命中 [' + hit.join(',') + ']' + (hit.length === 2 ? '' : ' ← 注册没落在这个实例里'))
      } else {
        diag('注册后回读 view(undefined)：不可读')
      }
    } catch (error) {
      diag('注册后回读 view 失败：' + String((error && error.message) || error))
    }
    // ★通道出口 1/2（工具）：把 ToolsService.view 包一层过滤器（描述 + schema +
    //   执行 + 每步准入全覆盖），再用 tools.guard 做执行兜底。见 lib/channel.js 顶部注释。
    //   旧的 tools.restrict 路线已废：它只能看见全局层与祖先链，而 base 工具挂在
    //   agent 自己那一层，restrict 永远砍不到（实测 deny 66 个名字只有 qq/sticker 被认出）。
    installChannel(ctx, tools, config, definitions)
  }

  // ★0.6.0：view 过滤器与 agent 层补注册全部退役。工具面 = preset 行清单。
  //   回滚开关：config.json 顶层写 "legacyChannel": true 时走 0.5.x 旧出口
  //   （setTimeout 轮询注册 + 包 ToolsService.view）。默认关，只为"曾经好使过"留退路。
  if (config && config.legacyChannel === true) {
    channelLog('[install] legacyChannel=true → 走 0.5.x 旧出口（轮询注册 + view 过滤器）', config)
    registerWhenToolsReady(ctx, legacyRegisterWhenToolsReady)
  } else {
    channelLog('[install] 工具面只由 preset 行清单决定（view 过滤器与 agent 层补注册已退役）', config)
  }
}

/**
 * 工具白名单 —— preset 只能「加插件」，减不掉 base bundle 里的工具。
 *
 * 实测：扮演会话实测到 69 个工具定义（base 的 bash / pwsh / fs / fs-search / skill /
 * todo / goal / subagent / workflow / jobs / plan-mode…全部在），说明 preset 不裁剪工具面。
 * dsh-tools 提供的是另一条路：`tools.restrict({ allow | deny })` —— agent 作用域的限制，
 * 命中后工具从该 agent 的**描述、schema 与执行集合**里一起消失（不只是隐藏调用）。
 *
 * 语义要点（来自 dsh-tools/lib/index.js:447-467）：
 *   - 必须在 **scoped** context 上调；全局调用会抛错（保护「别遮蔽所有 agent」）
 *   - `allow` 只能写**全局工具名**；scope 内注册的工具（本包的 rp_card / rp_memory）
 *     不受限制影响，写进来会被判 unknown 并抛错
 *   - 空 filter 抛错（`restrict({})` 是 no-op）
 *
 * 所以策略是：按白名单调 allow，报错里点名的未知名字（通常是 scope 内工具）剔除后重试；
 * 全部失败就 warn 降级，绝不影响扮演本身。
 */
/**
 * 一次 restrict 尝试：从报错里点名的未知工具名剔除后重试。
 * restrict 对「不存在的名字」直接抛错，而 scope 内注册的工具（rp_card / rp_memory）
 * 在 allow/deny 里都算未知 —— 所以必须按报错回退，不能盲写。
 */
function attemptRestrict(tools, filter) {
  const current = {}
  if (Array.isArray(filter.allow)) current.allow = filter.allow.slice()
  if (Array.isArray(filter.deny)) current.deny = filter.deny.slice()
  let lastError = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!current.allow?.length && !current.deny?.length) return { error: lastError || 'empty filter' }
    try {
      return { dispose: tools.restrict(current), used: JSON.parse(JSON.stringify(current)) }
    } catch (error) {
      lastError = String((error && error.message) || error)
      const named = [...lastError.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      let changed = false
      for (const key of ['allow', 'deny']) {
        if (!current[key]) continue
        const next = current[key].filter((n) => !named.includes(n))
        if (next.length !== current[key].length) {
          current[key] = next
          changed = true
        }
      }
      if (!changed) return { error: lastError }
    }
  }
  return { error: lastError || 'too many attempts' }
}

export function applyToolAllowlist(ctx, tools, config, label = 'scope') {
  const wanted = Array.isArray(config.allowedTools)
    ? config.allowedTools.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
    : []
  const denied = Array.isArray(config.denyTools)
    ? config.denyTools.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
    : []
  if (!wanted.length && !denied.length) return
  if (!tools || typeof tools.restrict !== 'function') {
    const msg = 'dsh-rp-mode: tools.restrict 不可用，工具白名单未生效（工具面仍是全部）'
    safeLog(ctx, 'warn', msg)
    diag(`[${label}] ${msg}`)
    return
  }

  // 先走 allow（白名单语义）；allow 里的全局工具若全被判未知（说明它们其实是 scope 内注册），
  // 退回 deny（黑名单语义）—— 两条都失败才降级，绝不影响扮演本身。
  let result = wanted.length ? attemptRestrict(tools, { allow: wanted }) : { error: 'no allow list' }
  let mode = 'allow'
  if (!result.dispose && denied.length) {
    const fallback = attemptRestrict(tools, { deny: denied })
    if (fallback.dispose) {
      result = fallback
      mode = 'deny'
    }
  }
  if (result.dispose) {
    const dispose = result.dispose
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
    const used = result.used || {}
    const okMsg =
      `dsh-rp-mode 工具白名单生效（${label}/${mode}）：` +
      (mode === 'allow' ? `allow=${(used.allow || []).join(',')}` : `deny=${(used.deny || []).length} 个`)
    safeLog(ctx, 'info', okMsg)
    diag(`[${label}] OK ${mode} ` + JSON.stringify(used))
  } else {
    const badMsg = `dsh-rp-mode: 工具白名单未生效（${label}）` + (result.error || '')
    safeLog(ctx, 'warn', badMsg)
    diag(`[${label}] FAIL ` + (result.error || 'unknown'))
  }
}

/**
 * agent 级工具守卫 —— 真正的落点。
 *
 * `restrict()` 要求 **scoped context（agent.ctx）**；preset 的行挂在 standing scope 上，
 * `ctx.get('tools')` 拿到的是根服务，直接调只会得到
 * 「tools.restrict() requires a scoped context」。
 *
 * 所以改成：挂一个 systemPrompt.context 钩子（每次组装提示词都会带着 agent 进来），
 * 第一次见到某个 agent 时就地对 `agent.ctx.tools` 上限制，并按 agent 记一次。
 * 首轮可能仍带全量工具（钩子与工具描述在同一轮组装里），从第二轮起稳定为白名单。
 */
export function installAgentToolGuard(ctx, config) {
  const prompt = ctx && typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
  if (!prompt || typeof prompt.context !== 'function' || typeof ctx.effect !== 'function') {
    diag('[agent] systemPrompt.context 不可用，agent 级工具守卫未安装')
    return
  }
  const guarded = new WeakSet()
  ctx.effect(
    () =>
      prompt.context({
        name: 'dsh:rp-mode-tool-guard',
        order: SECTION_ORDER + 1,
        text: (context) => {
          try {
            const agent = context && context.agent
            if (agent && typeof agent === 'object' && !guarded.has(agent)) {
              guarded.add(agent)
              // agent.ctx 上工具服务有两种暴露方式（服务属性 / ctx.get），都试一遍
              const actx = agent.ctx
              let tools = actx && actx.tools
              if (!tools && actx && typeof actx.get === 'function') {
                try {
                  tools = actx.get('tools')
                } catch {
                  tools = null
                }
              }
              diag(`[agent] 首次见到 agent → agent.ctx=${actx ? 'ok' : 'missing'} tools=${tools ? 'ok' : 'missing'}`)
              if (tools) applyToolAllowlist(ctx, tools, config, 'agent')
            }
          } catch (error) {
            diag('[agent] 守卫抛错: ' + String((error && error.message) || error))
          }
          return ''
        },
      }),
    'rp-mode.toolGuard()',
  )
  diag('[agent] 守卫已安装')
}
