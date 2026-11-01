/**
 * dsh-service-autostart — 服务自愈（从 dsh-qq-adapter 抽出来）。
 *
 * 为什么单独成插件：
 *  - 拉起 NapCat / 微心跳属于「身体」层，不是 QQ 渠道的事；
 *  - qq 卸了不该影响自愈，自愈也不该因为 qq 没装就消失；
 *  - 以后别的服务（语音桥、Ollama）也能复用同一套冷却与失败上限。
 *
 * 兼容策略：
 *  - 调用方传自己的 config（`config.autostart`），这里和本地默认值合并；
 *  - qq 侧优先用这个服务，拿不到再回退自己那份，功能不丢。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycle } from './lib/lifecycle.js'
import { ensureMindLoop, ensureNapCat, ensureServices, portOpen } from './lib/autostart.js'

export const name = 'dsh-service-autostart'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_KEY = Symbol.for('dsh-service-autostart.service')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const DEFAULTS = {
  enabled: true,
  napcat: {},
  mindLoop: {},
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
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了不影响自愈
  }
}

function state(ctx) {
  return lifecycle(ctx, () => ({ started: false, last: null, calls: 0 }))
}

export function apply(ctx) {
  const st = state(ctx)
  if (st.started) return
  st.started = true
  const config = loadConfig()
  if (config.enabled === false) {
    note('config.enabled=false，未启动')
    return
  }

  /** 把本地默认值和调用方传来���配置合起来：调用方优先。 */
  function withConfig(callerConfig) {
    const incoming = callerConfig?.autostart || {}
    return {
      autostart: {
        ...config,
        ...incoming,
        napcat: { ...(config.napcat || {}), ...(incoming.napcat || {}) },
        mindLoop: { ...(config.mindLoop || {}), ...(incoming.mindLoop || {}) },
      },
    }
  }

  async function run(handler, options = {}) {
    if (st.disposed) return { action: 'disposed' }
    st.calls += 1
    try {
      const result = await handler({
        config: withConfig(options.config),
        state: options.state || {},
        note: options.note || note,
        ...(options.probe ? { probe: options.probe } : {}),
        ...(options.launch ? { launch: options.launch } : {}),
      })
      st.last = { at: new Date().toISOString(), result }
      return result
    } catch (error) {
      const message = String((error && error.message) || error)
      note('自愈调用失败：' + message)
      return { action: 'error', error: message }
    }
  }

  const api = {
    id: 'autostart',
    ensureServices: (options) => run(ensureServices, options),
    ensureNapCat: (options) => run(ensureNapCat, options),
    ensureMindLoop: (options) => run(ensureMindLoop, options),
    portOpen,
    stats: () => ({ calls: st.calls, last: st.last }),
  }

  try {
    if (typeof ctx.provide === 'function') ctx.provide('autostart', api)
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
      id: 'autostart',
      package: 'dsh-service-autostart',
      intent: '服务自愈：QQ（NapCat）与微心跳没在跑就静默拉起',
      limits: ['只在调用方要求时启动', '冷却期内不重复拉', '失败 8 次后降到 10 分钟一次'],
      failureModes: [
        { code: 'MISSING_LAUNCHER', meaning: '启动脚本不存在', retry: '不重试' },
        { code: 'SPAWN_EPERM', meaning: '受限环境禁止拉起子进程', retry: '不重试' },
      ],
      scope: ['owner'],
      state: () => {
        const last = st.last
        return {
          calls: st.calls,
          lastAction: last ? String(last.result?.action || last.result?.napcat?.action || '') : '',
          lastAt: last ? String(last.at) : '',
        }
      },
    })
  } catch {
    // self 没装不影响自愈
  }

  note(`dsh-service-autostart 就绪（napcat ${config.napcat?.root || '默认'}）`)
  return api
}
