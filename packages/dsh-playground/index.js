/**
 * dsh-playground — 试验区管理（把「先在隔离 profile 验证」从口令变成工具）。
 *
 * 为什么要有这个插件：
 *   1. DSH 工具启动的子进程继承 agent 沙箱，拉不起 powershell / 第二个 DSH 实例；
 *      插件在宿主进程里没有这层限制。
 *   2. 「装插件前先进试验区」这条规则，靠人记不可靠——做成工具，想忘都难。
 *
 * 不做什么：
 *   - 不自动改 desktop（要显式传 profile 名，默认就是 verifyx）
 *   - 不按进程名杀进程（只杀自己记下的 pid）
 *   - 不在 apply 时启动任何东西
 */

import os from 'node:os'
import fs from 'node:fs'
import { note as kitNote } from 'dsh-plugin-kit/note'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { scanConflicts } from './lib/conflict.js'
import {
  checkProfile,
  defaultProfilesRoot,
  installPlugin,
  instanceStatus,
  portOpen,
  readInstanceState,
  startInstance,
  stopInstance,
} from './lib/playground.js'

export const name = 'dsh-playground'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_KEY = Symbol.for('dsh-playground.service')
const STATE_KEY = Symbol.for('dsh-playground.state')

const DEFAULTS = {
  enabled: true,
  exe: '',
  cli: '',
  profilesRoot: '',
  port: 3080,
  bootTimeoutMs: 45000,
  backupRoot: path.join(os.homedir(), '.dsh', 'backups'),
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  kitNote(HERE, message)
}

function state(ctx) {
  return lifecycle(ctx, () => {
    const shared = globalThis[STATE_KEY] || { pid: null, profile: '', port: null }
    globalThis[STATE_KEY] = shared
    return { started: false, calls: 0, lastAction: '', lastError: '', shared }
  })
}

export function apply(ctx) {
  const st = state(ctx)
  if (st.started) return st.api || undefined
  const config = loadConfig()
  if (config.enabled === false) {
    note('config.enabled=false，未启动')
    return undefined
  }
  st.started = true
  const profilesRoot = config.profilesRoot || defaultProfilesRoot()
  const settings = { ...config, profilesRoot }

  // 宿主重启后内存里的 pid 没了：从落盘记录补回来（超过 24h 视为过期，避免杀到复用的 pid）
  function hydrate() {
    if (st.shared.pid) return
    const saved = readInstanceState()
    const age = Date.now() - Date.parse(String(saved.at || ''))
    if (saved.pid && Number.isFinite(age) && age >= 0 && age < 24 * 3600 * 1000) {
      st.shared.pid = Number(saved.pid)
      st.shared.profile = String(saved.profile || '')
      st.shared.port = Number(saved.port) || null
    }
  }

  async function run(action, fn) {
    st.calls += 1
    st.lastAction = action
    try {
      const result = await fn()
      if (result && result.ok === false) st.lastError = String(result.error || '')
      return result
    } catch (error) {
      st.lastError = String((error && error.message) || error)
      note(`${action} 失败：${st.lastError}`)
      return { ok: false, error: st.lastError }
    }
  }

  const api = {
    id: 'playground',
    status: () => run('status', () => {
      hydrate()
      return instanceStatus({ state: st.shared, config: settings })
    }),
    start: ({ profile = 'verifyx', port } = {}) =>
      run('start', () => startInstance({ profile, port, state: st.shared, config: settings, note })),
    stop: () => run('stop', () => {
      hydrate()
      return stopInstance({ state: st.shared, note })
    }),
    check: ({ profile = 'verifyx' } = {}) => run('check', () => checkProfile({ profile, config: settings })),
    conflicts: ({ profile = 'verifyx' } = {}) =>
      run('conflicts', () => scanConflicts({ profilesRoot: settings.profilesRoot, profile })),
    install: ({ profile = 'verifyx', packageName, sourceDir } = {}) =>
      run('install', () => installPlugin({ profile, packageName, sourceDir, config: settings, note })),
    portOpen,
    stats: () => ({
      calls: st.calls,
      lastAction: st.lastAction,
      lastError: st.lastError,
      profile: st.shared.profile || '',
      pid: st.shared.pid || null,
      port: st.shared.port || settings.port,
    }),
  }

  try {
    if (typeof ctx.provide === 'function') ctx.provide('playground', api)
  } catch {
    // 宿主可能不认这个服务名
  }
  globalThis[SERVICE_KEY] = api
  st.own(() => {
    if (globalThis[SERVICE_KEY] === api) delete globalThis[SERVICE_KEY]
  })

  // 把状态报给 self
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    self?.declare?.({
      id: 'playground',
      package: 'dsh-playground',
      intent: '试验区管理：启停隔离 profile 实例、检查组合配置、往试验区装插件',
      limits: [
        '默认只动 verifyx，不碰 desktop',
        '只杀自己记下的 pid，不按进程名全杀',
        '不自动启动，必须显式调用',
        '装插件只改指定 profile 的 package.json 和 junction',
      ],
      failureModes: [
        { code: 'PROFILE_MISSING', meaning: 'profile 目录不存在', retry: '不重试，报路径' },
        { code: 'BOOT_TIMEOUT', meaning: '端口在超时内没起来', retry: '看 profile 日志后重试' },
        { code: 'SPAWN_FAILED', meaning: '拉不起进程', retry: '检查 exe/cli 路径' },
      ],
      scope: ['owner'],
      state: () => ({
        profile: st.shared.profile || '',
        pid: st.shared.pid || null,
        port: st.shared.port || settings.port,
        calls: st.calls,
        lastError: st.lastError ? st.lastError.slice(0, 60) : '',
      }),
    })
  } catch {
    // self 没装不影响试验区
  }

  note('dsh-playground 就绪（默认 verifyx:3080）')

  // ---- 工具注册：tools 服务可能晚就绪，250ms 重试最多 60 秒 ----
  installTools(ctx, api, st, settings)

  st.api = api
  return api
}

function render(text) {
  return [{ type: 'text', text }]
}

function renderByAction(action, v) {
  if (action === 'status') {
    return v.listening
      ? `试验区在跑：${v.profile || '(未记 profile)'} · pid ${v.pid ?? '?'} · ${v.url}`
      : `试验区没在跑（端口 ${v.port} 无监听，profile ${v.profile || '未记'}）`
  }
  if (action === 'start') {
    return v.ok
      ? `试验区起来了：${v.url}（pid ${v.pid}${v.bootMs ? '，' + v.bootMs + 'ms' : ''}）`
      : `启动失败：${v.error}${v.hint ? '（' + v.hint + '）' : ''}`
  }
  if (action === 'stop') {
    return v.ok ? `试验区已停（pid ${v.pid}）` : `停止失败：${v.error}`
  }
  if (action === 'check') {
    if (!v.ok) return `检查失败：${v.error}`
    return `${v.profile}：组合树共 ${v.entries} 个条目\n` + (v.preview || []).join(', ')
  }
  if (action === 'conflicts') {
    if (!v.ok) return `扫描失败：${v.error}`
    const toolHits = v.toolConflicts || []
    const svcHits = v.serviceConflicts || []
    if (!toolHits.length && !svcHits.length) {
      return `${v.profile}：扫了 ${v.scanned}/${v.packages} 个包，${v.toolCount} 个工具名、${v.serviceCount} 个服务名，**没有重名**`
    }
    const out = [`${v.profile}：发现 ${toolHits.length + svcHits.length} 处冲突`]
    for (const hit of toolHits) out.push(`  工具 ${hit.name} ← ${hit.owners.join(' / ')}`)
    for (const hit of svcHits) out.push(`  服务 ${hit.name} ← ${hit.owners.join(' / ')}`)
    return out.join('\n')
  }
  if (action === 'install') {
    if (!v.ok) return `安装失败：${v.error || (v.failed || []).join('/')}\n备份：${v.backup || '-'}`
    const c = v.checks || {}
    return (
      `已装 ${v.packageName} → ${v.profile}\n` +
      `  deps=${c.inDeps} bundles=${c.inBundles}（共 ${c.bundlesCount}）junction=${c.junctionReadable}\n` +
      `  备份：${v.backup}`
    )
  }
  return String(v.error || '')
}

function installTools(ctx, api, st, settings) {
  const tryMount = () => {
    const tools = ctx.get?.('tools')
    if (!tools || typeof tools.register !== 'function') {
      if (!st.toolsSince) st.toolsSince = Date.now()
      if (st.toolsWaiting) return
      if (Date.now() - st.toolsSince > 60000) {
        note('60 秒内没等到 tools 服务，playground 工具未注册')
        return
      }
      st.toolsWaiting = true
      const timer = typeof st.later === 'function' ? st.later : setTimeout
      timer(() => {
        st.toolsWaiting = false
        tryMount()
      }, 250)
      return
    }

    const definitions = [
      {
        name: 'playground',
        description:
          '试验区（默认 verifyx:3080）单入口：action=status 看状态 / start 启动（profile、port）/ stop 停止 / check 查组合树（profile）/ conflicts 扫工具与服务重名（profile）/ install 装插件（packageName 必填，sourceDir 仅 link: 安装时给）。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'start', 'stop', 'check', 'conflicts', 'install'],
              description: '要做的事',
            },
            profile: { type: 'string', description: '除 stop 外都用：profile 名，默认 verifyx' },
            port: { type: 'number', description: 'start 用：端口，默认 3080' },
            packageName: { type: 'string', description: 'install 用（必填）：插件包名，如 dsh-feiyu-look' },
            sourceDir: {
              type: 'string',
              description: 'install 用：源码目录（link: 安装时必填），如 D:\plugins\dsh-feiyu-look',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              action: { type: 'string' },
              profile: { type: 'string' },
              pid: { type: 'number' },
              port: { type: 'number' },
              listening: { type: 'boolean' },
              url: { type: 'string' },
              bootMs: { type: 'number' },
              entries: { type: 'number' },
              packages: { type: 'number' },
              toolCount: { type: 'number' },
              serviceCount: { type: 'number' },
              packageName: { type: 'string' },
              backup: { type: 'string' },
              hint: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_a, v) => render(renderByAction(String(_a?.action || 'status'), v)),
        },
        timeoutMs: 120000,
        isConcurrencySafe: () => false,
        execute: async (args) => {
          const action = String(args?.action || 'status')
          if (action === 'status') return { ...(await api.status()), action }
          if (action === 'start') {
            const v = await api.start({ profile: String(args?.profile || 'verifyx'), port: Number(args?.port) || undefined })
            return { ...v, action }
          }
          if (action === 'stop') return { ...(await api.stop()), action }
          if (action === 'check') return { ...(await api.check({ profile: String(args?.profile || 'verifyx') })), action }
          if (action === 'conflicts') return { ...(await api.conflicts({ profile: String(args?.profile || 'verifyx') })), action }
          if (action === 'install') {
            const v = await api.install({
              profile: String(args?.profile || 'verifyx'),
              packageName: String(args?.packageName || ''),
              sourceDir: args?.sourceDir ? String(args.sourceDir) : '',
            })
            return { ...v, action }
          }
          return { ok: false, action, error: '未知 action：' + action }
        },
      },
    ]

    const handles = []
    for (const definition of definitions) {
      try {
        handles.push(tools.register(definition))
      } catch (error) {
        note('注册工具失败 ' + definition.name + '：' + String((error && error.message) || error))
      }
    }
    st.own(() => {
      for (const handle of handles) {
        try {
          handle?.dispose?.()
        } catch {
          // ignore
        }
      }
    })
    note('playground 工具已注册（1 个）')
  }

  tryMount()
}
