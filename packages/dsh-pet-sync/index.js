import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { note as kitNote } from 'dsh-plugin-kit/note'
/**
 * dsh-pet-sync — 桌宠/悬浮窗统一整合 + 与本程序同步开关
 *
 * 一个插件同时管两件事：
 *   1. 形态统一：「大肥鱼」桌宠 和 「小鲸鱼挂件」悬浮窗 是同一程序的两套立绘，
 *      这里用一个 form（pet / widget）切换，不再是两个各自启动的程序。
 *   2. 生命周期同步：DSH 加载插件 → 桌宠起来；DSH 退出/禁用插件 → 桌宠一起停。
 *
 * 不注入系统提示词、不改 DSH 行为，只做进程与配置的看护。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PET_DIR,
  defaultPythonw,
  petStatus,
  readPetConfig,
  readState,
  startPet,
  stopPet,
  switchForm,
  writeState,
} from 'dsh-plugin-kit/pet'

export const name = 'dsh-pet-sync'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  enabled: true,
  autoStart: true,
  stopOnExit: true,
  form: 'pet',
  petDir: DEFAULT_PET_DIR,
  pythonw: '',
}

function loadConfig() {
  const file = path.join(HERE, 'config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function toolDef({ name: toolName, description, parameters, schema, render, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema,
      render: (_args, value) => [{ type: 'text', text: render(value) }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    execute,
  }
}

/** 日志永远不能把插件带崩：logger 在 cordis 里是对象，方法调用签名必须是 logger.info(msg)。 */
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

// ── 与桌宠的契约（2026-11-01 P1）──
// 状态：~/.dsh/pet/state.json —— **只有桌宠进程写**，这里只读。
// 指令：~/.dsh/pet/inbox.jsonl —— 插件只追加，桌宠按偏移读、执行、回执。
// 规矩：插件不再直接改 config.json（以前和桌宠的 autosave 互相覆盖）。
const PET_HOME = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'pet')

function readPetState() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(PET_HOME(), 'state.json'), 'utf8'))
    const age = Date.now() - Number(data.updatedAt || 0)
    return { ...data, stale: !(age >= 0 && age < 10000) }
  } catch {
    return null
  }
}

function pushPetCommand(type, payload, ttlSec = 120, source = 'pet-sync') {
  try {
    const dir = PET_HOME()
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const item = {
      id: 'c_' + Math.random().toString(16).slice(2, 14),
      type,
      from: source,
      ts: now,
      exp: now + ttlSec * 1000,
      payload: payload || {},
    }
    const line = JSON.stringify(item)
    if (Buffer.byteLength(line, 'utf8') > 8 * 1024) return null
    fs.appendFileSync(path.join(dir, 'inbox.jsonl'), line + '\n', 'utf8')
    return item.id
  } catch {
    return null
  }
}

/** 插件加载入口：任何异常都在这里吃掉，绝不让 apply 抛错（昨晚 pet-hub 就是这么把宿主带崩的）。 */
export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    safeLog(ctx, 'warn', 'dsh-pet-sync 加载失败：' + String((error && error.message) || error))
    note('apply 抛错：' + String((error && error.message) || error))
    return undefined
  }
}

/**
 * 冷启动时 apply 可能比 tools 服务先跑（实测重启后工具全没注册）。
 * 这里自己等服务，但**同一进程只许注册一次** —— cordis 会对同一插件多次调用
 * apply()，08:14 那次崩溃就是两路注册撞了同名工具。
 */
const STATE_KEY = Symbol.for('dsh-pet-sync.state')

function state(ctx) { return lifecycle(ctx, () => ({ registered: false, waiting: false, autoStarted: false, since: 0 })) }

function applyInner(ctx) {
  const st = state(ctx)
  if (st.registered) return
  const cfg = loadConfig()
  const petDir = cfg.petDir || DEFAULT_PET_DIR
  const pythonw = cfg.pythonw || defaultPythonw()
  let startedPids = []

  const ensureUp = async (form) => {
    const result = await startPet({ petDir, pythonw, form: form || (cfg.form === 'widget' ? 'widget' : 'pet') })
    if (result.ok) {
      startedPids = Array.from(new Set([...startedPids, result.pid]))
      writeState({ pid: result.pid, form: cfg.form, running: true, startedByPlugin: !result.adopted })
    }
    return result
  }

  if (!st.autoStarted && cfg.enabled && cfg.autoStart) {
    st.autoStarted = true
    ensureUp()
      .then((r) => {
        if (!r.ok) safeLog(ctx, 'warn', `dsh-pet-sync: 桌宠没起来：${r.error}`)
      })
      .catch((error) => safeLog(ctx, 'warn', `dsh-pet-sync: 自动启动异常：${error && error.message}`))
  }

  // 把桌宠状态报给 self：running / pid / form 一眼能看到
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare === 'function') {
      self.declare({
        id: 'pet-sync',
        package: 'dsh-pet-sync',
        intent: '桌宠进程管理：查看状态、启动、停止、切换形态',
        limits: ['桌宠缺失时如实报告未运行，不伪造进程状态', '不改桌宠的行为规则', '单实例：宁可不开也不分身'],
        failureModes: [
          { code: 'PET_MISSING', meaning: '桌宠程序或配置缺失', retry: '报告缺失，等待安装' },
          { code: 'PET_INSTANCE_STUCK', meaning: '旧实例还活着但没响应', retry: '拒绝启动第二只，写 pet-instance.log' },
        ],
        scope: ['owner'],
        state: () => {
          const snapshot = readState()
          return {
            running: Boolean(snapshot.running),
            pid: Number(snapshot.pid) || 0,
            form: String(snapshot.form || ''),
            startedByPlugin: Boolean(snapshot.startedByPlugin),
          }
        },
      })
    }
  } catch {
    // self 没装不影响桌宠
  }

  const tools = ctx.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    if (!st.since) st.since = Date.now()
    if (st.waiting) return
    if (Date.now() - st.since > 60000) {
      note('60s 内没等到 tools 服务，1 个工具均未注册')
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

  const definitions = [
    toolDef({
      name: 'pet',
      description:
        '桌宠控制：action=status 看状态 / start 启动（form: pet|widget）/ stop 停止 / form 切形态 / say 让它说一句话（text，最多 60 字）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop', 'form', 'say'], description: '要做的事' },
          form: { type: 'string', enum: ['pet', 'widget'], description: 'start/form 用：目标形态，省略用配置里的默认值' },
          text: { type: 'string', description: 'say 用：要说的话，短句最好' },
        },
        required: ['action'],
      },
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, action: { type: 'string' }, text: { type: 'string' }, error: { type: 'string' } },
      },
      render: (v) => v.text || v.error || '（无输出）',
      execute: async (args) => {
        const action = String(args?.action || 'status')
        if (action === 'status') {
          const v = await petStatus({ petDir, pythonw })
          const live = readPetState()
          // 2026-11-04：状态以进程探测为准；pet-sync.json 与探测不一致时修正，
          // 避免「状态文件说在跑、进程不在」的三源不一致。
          const snapshot = readState()
          if (Boolean(snapshot.running) !== v.running || Number(snapshot.pid || 0) !== Number(v.pid || 0)) {
            writeState({ running: v.running, pid: v.pid ?? null })
            note(`状态修正：pet-sync.json running=${Boolean(snapshot.running)} → ${v.running}，pid=${snapshot.pid ?? 'null'} → ${v.pid ?? 'null'}`)
          }
          const text = v.running
            ? `桌宠在跑（pid ${v.pid}）· 形态 ${v.form}（${v.skin}）· 尺寸 ${v.size} · 模式 ${v.mode}${v.topmost ? ' · 置顶' : ''}`
            : `桌宠没在跑 · 配置目录 ${v.petDir}${v.configFound ? '' : '（config.json 缺失）'}`
          return { ...v, action, state: live, text }
        }
        if (action === 'start') {
          const result = await ensureUp(args?.form)
          const text = result.ok ? `已${result.adopted ? '复用' : '启动'}桌宠（pid ${result.pid}）` : `启动失败：${result.error}`
          return { ...result, action, text }
        }
        if (action === 'stop') {
          const status = await petStatus({ petDir, pythonw })
          const result = await stopPet(status.pids)
          if (!result.ok) return { ...result, action, text: `停止失败：${result.error}` }
          writeState({ running: false, pid: null })
          return { ...result, action, text: `已停止 ${result.stopped?.length ?? 0} 个桌宠进程` }
        }
        if (action === 'form') {
          const form = args?.form === 'widget' ? 'widget' : 'pet'
          // 配置归桌宠写：这里只发指令，不再直接改 config.json
          const id = pushPetCommand('set', { skin: form === 'widget' ? '小鲸鱼挂件' : '大肥鱼' }, 60, 'pet-sync')
          if (id && (await petStatus({ petDir, pythonw })).running) {
            return { ok: true, action, form, queued: id, text: `已请桌宠切到 ${form} 形态（指令 ${id}）` }
          }
          if (!id) return { ok: false, action, form, error: '指令没写进队列' }
          const result = await switchForm({ petDir, pythonw, form })
          if (result.ok) writeState({ form, pid: result.pid, running: true })
          return { ...result, action, form, text: result.ok ? `已切到 ${form} 形态（pid ${result.pid}）` : `切换失败：${result.error}` }
        }
        if (action === 'say') {
          const text = String(args?.text || '').trim().slice(0, 60)
          if (!text) return { ok: false, action, error: 'text 为空' }
          const status = await petStatus({ petDir, pythonw })
          if (!status.running) {
            return { ok: false, action, running: false, error: '桌宠没在跑，这句没送出去' }
          }
          const id = pushPetCommand('say', { text }, 120, 'pet-sync')
          if (!id) return { ok: false, action, error: '指令队列写不进去' }
          return { ok: true, action, id, text: `已排队，桌宠会说：${text}` }
        }
        return { ok: false, action, error: '未知 action：' + action }
      },
    }),
  ]

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
  safeLog(ctx, 'info', 'dsh-pet-sync ready（1 个工具）')
  note('dsh-pet-sync: 1 个工具已注册（pid ' + process.pid + '）')

  // 与 DSH 同步开关：插件卸载（禁用/退出应用）时把桌宠一起停掉
  if (cfg.stopOnExit && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      petStatus({ petDir, pythonw }).then((status) => {
        if (status.running) stopPet(status.pids).catch(() => {})
        writeState({ running: false, pid: null })
      })
    })
  }
}
