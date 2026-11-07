/**
 * 客户端启动时的服务自愈：微心跳没在跑就静默拉起；探测 QQ 桥（SnowLuma）是否在线；
 * bsk daemon（BrowserSkill 的浏览器自动化后端）没在跑就拉起一个 foreground 实例。
 *
 * 为什么放在插件里而不是外部 watchdog：
 * 外部 watchdog 若由 DSH 工具启动，会继承 agent 的沙箱，spawn 子进程直接 EPERM
 * （NapCat 时代实测过 `spawn EPERM`）。插件跑在宿主进程里，没有这层限制。
 *
 * 所有拉起都用 windowsHide + stdio:ignore，不弹任何窗口。
 *
 * 2026-11-02：NapCat 已废弃（QQ 桥改用 SnowLuma，占 3001/5099）。本模块不再拉起 QQ 桥，
 * 只探测端口状态（probeBridge）；拉起能力只剩微心跳（mind-loop）。
 *
 * 2026-11-05：新增 bsk daemon 自愈。BrowserSkill 的 daemon 必须挂在持久宿主进程上
 * （`--foreground`），因为它走 detached 会被 Windows Job Object 拒绝；插件进程正好是持久宿主，
 * 所以这里用「不 detached、不 unref」的方式拉起，随宿主生命周期存活。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { isAlive as kitIsAlive, portOpen as kitPortOpen } from 'dsh-plugin-kit/process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 默认值按插件自身位置与当前运行时推导，换台机器不用改：
// mind-loop 与本插件同在 dsh-plugins/ 下；node 用当前宿主可执行文件（拉起时补 ELECTRON_RUN_AS_NODE）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const DEFAULTS = {
  enabled: true,
  bridge: {
    host: '127.0.0.1',
    port: 3001,
  },
  mindLoop: {
    enabled: true,
    script: path.resolve(HERE, '../../mind-loop/mind-loop.mjs'),
    node: process.execPath,
    pidFile: path.join(DSH_HOME, 'dafeiyu', 'mind-loop.pid'),
    cooldownMs: 10 * 60 * 1000,
  },
  bsk: {
    enabled: true,
    bin: '',
    home: path.join(HERE, '..', '..', '_thirdparty', 'bsk-home'),
    host: '127.0.0.1',
    port: 52800,
    cooldownMs: 10 * 60 * 1000,
  },
}

/** 只测「端口有没有人听」，不发任何协议数据（实现统一在 kit/process）。 */
export function portOpen(port, { host = '127.0.0.1', timeoutMs = 900 } = {}) {
  return kitPortOpen(port, { host, timeoutMs })
}

export function pidAlive(pid) {
  return kitIsAlive(pid)
}

export function readPid(file) {
  try {
    return Number.parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10)
  } catch {
    return 0
  }
}

/** detached + 全隐藏：进程活过宿主，且永远不弹控制台。 */
export function launchHidden(file, args, options = {}) {
  const child = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    ...options,
  })
  child.on('error', () => {})
  child.unref()
  return child
}

/**
 * 挂在本进程上的子进程：不 detached、不 unref。
 * bsk daemon 的 `--foreground` 只能这样起——detached 会被 Windows Job Object 判定为
 * 「仍在 Job 内」，随后失败；真正要求的是「有一个比客户端活得久、且不短命的主人」。
 */
export function launchOwned(file, args, options = {}) {
  const child = spawn(file, args, {
    stdio: 'ignore',
    windowsHide: true,
    ...options,
  })
  child.on('error', () => {})
  return child
}

function merge(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(base[key] || {}), ...value } : value
  }
  return out
}

/**
 * 探测 QQ 桥（SnowLuma 默认监听 3001）是否在线。只报状态，不拉起。
 * 桥的生命周期由用户 / SnowLuma 自己维护；这里只负责让「桥在不在」可查。
 */
export async function probeBridge({ config = {}, probe = portOpen } = {}) {
  const merged = merge(DEFAULTS, config.autostart || {})
  if (!merged.enabled) return { action: 'disabled' }
  const bridge = merged.bridge
  const up = await probe(bridge.port, { host: bridge.host })
  return up ? { action: 'up', port: bridge.port } : { action: 'down', port: bridge.port }
}

export async function ensureMindLoop({ config = {}, state = {}, note = () => {}, launch = launchHidden, exists = fs.existsSync } = {}) {
  const cfg = merge(DEFAULTS, config.autostart || {}).mindLoop
  if (!cfg.enabled) return { action: 'disabled' }

  const pid = readPid(cfg.pidFile)
  if (pidAlive(pid)) return { action: 'running', pid }
  if (Date.now() - (Number(state.mindLoopTriedAt) || 0) < cfg.cooldownMs) return { action: 'cooldown' }
  if (!exists(cfg.script)) return { action: 'missing-script', script: cfg.script }

  const node = exists(cfg.node) ? cfg.node : process.execPath
  const env = node === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env }
  state.mindLoopTriedAt = Date.now()
  try {
    launch(node, [cfg.script], { cwd: path.dirname(cfg.script), env })
    note('微心跳没在跑，已静默拉起 mind-loop')
    return { action: 'launched', pidFile: cfg.pidFile }
  } catch (error) {
    note('拉起微心跳失败：' + String(error?.message || error))
    return { action: 'error', error: String(error?.message || error) }
  }
}

/**
 * bsk daemon（BrowserSkill）自愈：端口在听就报 running，否则拉一个 foreground 实例。
 * 端口默认 52800；BSK_HOME 必须和 daemon 一致，否则客户端与 daemon 各找各的家。
 */
export async function ensureBskDaemon({
  config = {},
  state = {},
  note = () => {},
  probe = portOpen,
  launch = launchOwned,
  exists = fs.existsSync,
} = {}) {
  const cfg = merge(DEFAULTS, config.autostart || {}).bsk
  if (!cfg.enabled) return { action: 'disabled' }
  if (!cfg.bin) return { action: 'missing-binary', bin: '' }

  const up = await probe(cfg.port, { host: cfg.host })
  if (up) return { action: 'running', port: cfg.port }

  if (Date.now() - (Number(state.bskTriedAt) || 0) < cfg.cooldownMs) return { action: 'cooldown' }
  if (!exists(cfg.bin)) return { action: 'missing-binary', bin: cfg.bin }

  state.bskTriedAt = Date.now()
  try {
    launch(cfg.bin, ['daemon', 'start', '--foreground'], {
      cwd: cfg.home,
      env: { ...process.env, BSK_HOME: cfg.home },
    })
    note('bsk daemon 没在跑，已拉起（foreground）')
    return { action: 'launched', port: cfg.port }
  } catch (error) {
    note('拉起 bsk daemon 失败：' + String(error?.message || error))
    return { action: 'error', error: String(error?.message || error) }
  }
}

/** 启动时统一检查：探测 QQ 桥 + 拉起微心跳 + 拉起 bsk daemon。只有后两者会被拉起。 */
export async function ensureServices({ config = {}, state = {}, note = () => {}, probe, launch, launchBsk = launchOwned } = {}) {
  const bridge = await probeBridge({ config, probe })
  const mindLoop = await ensureMindLoop({ config, state, note, launch })
  const bsk = await ensureBskDaemon({ config, state, note, probe, launch: launchBsk })
  return { bridge, mindLoop, bsk }
}
