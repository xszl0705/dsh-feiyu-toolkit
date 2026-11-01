/**
 * dsh-naga-tools — 参照 NagaAgent 的 agent-manifest 契约，把它的三类能力
 * 搬到 DSH 原生工具里（不引 Python、不引 MCP 进程）：
 *
 *   NagaAgent mcpserver/agent_open_launcher   →  naga(action=list|open)
 *   NagaAgent mcpserver/agent_weather_time    →  naga(action=weather)
 *   NagaAgent mcpserver/system_control        →  naga(action=lock|sleep|screen_off|volume_up|volume_down|mute|open_settings)
 *
 * 原项目的 agent-manifest.json 每个 agent 声明 name/description/tools；
 * 这里用 DSH 的 ToolDefinition 等价表达：parameters JSON Schema + output schema。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import https from 'node:https'

const START_MENU_ROOTS = [
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
]

/** 递归收集开始菜单里的快捷方式（app_launcher 的等价实现）。 */
function listShortcuts(limit = 400) {
  const out = []
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= limit) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (/\.(lnk|url)$/i.test(entry.name)) {
        const name = entry.name.replace(/\.(lnk|url)$/i, '')
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name, path: full })
      }
    }
  }
  for (const root of START_MENU_ROOTS) walk(root, 0)
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return out
}

function matchShortcut(apps, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const exact = apps.find((app) => app.name.toLowerCase() === q)
  if (exact) return exact
  const starts = apps.find((app) => app.name.toLowerCase().startsWith(q))
  if (starts) return starts
  const contains = apps.find((app) => app.name.toLowerCase().includes(q))
  if (contains) return contains
  return null
}

function launchShortcut(target) {
  // target 是开始菜单里扫到的快捷方式路径，正常不含元字符。
  // 但 cmd.exe 会把 & | > < ^ 当作命令分隔/重定向来解释，
  // 一旦路径里带上这些字符（恶意命名的 .lnk 就够），/c start 会执行额外的命令。
  // 所以这里先拒掉，不给注入留口子（2026-11-01 审计）。
  const raw = String(target || '')
  if (!raw) throw new Error('启动失败：路径为空')
  if (/[&|<>^"\r\n]/.test(raw)) {
    throw new Error('路径含 shell 元字符，拒绝执行：' + raw.slice(0, 200))
  }
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', raw], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (error) {
    // 受限环境（spawn EPERM）下不要让工具把插件带崩，交给调用方报错
    throw new Error('启动失败：' + String((error && error.message) || error))
  }
}

function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, message: String(stderr || error.message || '').trim().slice(0, 300) })
            return
          }
          resolve({ ok: true, message: String(stdout || '').trim().slice(0, 300) })
        },
      )
    } catch (error) {
      resolve({ ok: false, message: 'spawn 失败：' + String((error && error.message) || error).slice(0, 200) })
    }
  })
}

const VOLUME_UP = [
  '$w=Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,int e);\' -Name K -PassThru;',
  'for($i=0;$i<2;$i++){$w::keybd_event(0xAF,0,0,0)}',
].join('')

const VOLUME_DOWN = [
  '$w=Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,int e);\' -Name K -PassThru;',
  'for($i=0;$i<2;$i++){$w::keybd_event(0xAE,0,0,0)}',
].join('')

const VOLUME_MUTE = [
  '$w=Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,int e);\' -Name K -PassThru;',
  '$w::keybd_event(0xAD,0,0,0)',
].join('')

const SCREEN_OFF = [
  '$w=Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern int SendMessage(int h,int m,int w,int l);\' -Name S -PassThru;',
  '$w::SendMessage(0xffff,0x0112,0xF170,2)',
].join('')

const SYSTEM_ACTIONS = {
  lock: { command: 'rundll32.exe user32.dll,LockWorkStation', label: '锁定屏幕' },
  sleep: { command: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0', label: '进入睡眠' },
  screen_off: { command: SCREEN_OFF, label: '关闭显示器' },
  volume_up: { command: VOLUME_UP, label: '音量 +' },
  volume_down: { command: VOLUME_DOWN, label: '音量 -' },
  mute: { command: VOLUME_MUTE, label: '静音切换' },
  open_settings: { command: 'Start-Process ms-settings:', label: '打开 Windows 设置' },
}

function httpJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'curl/8.0 dsh-naga-tools', Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 512 * 1024) req.destroy(new Error('response too large'))
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
  })
}

function fmtTime(date) {
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function createNagaTools(plugin) {
  /**
   * 单入口工具：原 naga_app_launcher / naga_weather_time / naga_system_control 合并而来。
   * 参数名、默认值、对宿主 api 的调用方式全部沿用旧实现，只换入口（省工具定义 token）。
   */
  const naga = {
    name: 'naga',
    description:
      '本机应用、时间天气、固定系统动作（合并自 app_launcher / weather_time / system_control）。' +
      'action=list 列开始菜单应用；action=open 按名字模糊匹配并启动（未命中返回候选）；' +
      'action=weather 报当前时间与天气（不给 city 按 IP 定位，天气来自 wttr.in，免 Key）；' +
      'action=lock/sleep/screen_off/volume_up/volume_down/mute/open_settings 只做固定动作，不接受任意命令。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'open', 'weather', 'lock', 'sleep', 'screen_off', 'volume_up', 'volume_down', 'mute', 'open_settings'],
          description: 'list 列应用；open 启动应用；weather 查时间天气；其余为系统动作',
        },
        query: { type: 'string', description: 'open 时的应用名（模糊匹配，如 微信 / steam / code）' },
        limit: { type: 'number', description: 'list 时最多返回多少条，默认 60' },
        city: { type: 'string', description: 'weather 时的城市名，可中英文；省略则自动定位' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          apps: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
          launched: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
          time: { type: 'string' },
          city: { type: 'string' },
          weather: { type: 'string' },
          temperature: { type: 'string' },
          ok: { type: 'boolean' },
          message: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // weather：沿用旧 weather_time 的排版（带 error 时仍要显示时间）
        if (value?.time) {
          const parts = ['现在 ' + (value.time || '?')]
          if (value.city) parts.push('地点 ' + value.city)
          if (value.weather) parts.push(value.weather + (value.temperature ? '，' + value.temperature : ''))
          if (value.error) parts.push('（天气没取到：' + value.error + '）')
          return [{ type: 'text', text: parts.join(' · ') }]
        }
        // 系统动作：沿用旧 system_control 的排版
        if (value?.ok === false) return [{ type: 'text', text: '失败：' + (value?.error || value?.message || '未知错误') }]
        if (value?.ok === true) return [{ type: 'text', text: '已执行：' + value.action }]
        // 应用：沿用旧 app_launcher 的排版
        if (value?.error) return [{ type: 'text', text: value.error }]
        if (value?.launched) return [{ type: 'text', text: '已启动：' + value.launched }]
        const apps = Array.isArray(value?.apps) ? value.apps : []
        if (value?.candidates?.length) return [{ type: 'text', text: '没找到精确匹配，候选：' + value.candidates.join('、') }]
        return [{ type: 'text', text: '开始菜单里共 ' + apps.length + ' 个应用：\n' + apps.map((a) => '· ' + a.name).join('\n') }]
      },
    },
    timeoutMs: 20000,
    // 含锁屏 / 睡眠 / 关屏这类会打断用户的操作，不与其它调用并发
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args?.action || '')

      if (action === 'list' || action === 'open') {
        const apps = listShortcuts(400)
        if (action === 'list') {
          const limit = Math.max(1, Math.min(400, Number(args?.limit) || 60))
          return { action: 'list', apps: apps.slice(0, limit).map((app) => ({ name: app.name })) }
        }
        const target = matchShortcut(apps, args?.query)
        if (!target) {
          const q = String(args?.query || '').toLowerCase()
          const candidates = apps
            .filter((app) => q && app.name.toLowerCase().includes(q.slice(0, 2)))
            .slice(0, 8)
            .map((app) => app.name)
          return { action: 'open', error: '没找到「' + (args?.query || '') + '」', candidates }
        }
        try {
          launchShortcut(target.path)
          return { action: 'open', launched: target.name }
        } catch (error) {
          return { action: 'open', error: '启动失败：' + (error?.message || error) }
        }
      }

      if (action === 'weather') {
        const now = new Date()
        const city = String(args?.city || '').trim()
        const result = { action: 'weather', time: fmtTime(now), city: '', weather: '', temperature: '', error: '' }
        try {
          const url = 'https://wttr.in/' + encodeURIComponent(city || '') + '?format=j1&lang=zh'
          const data = await httpJson(url)
          const area = data?.nearest_area?.[0]?.areaName?.[0]?.value || city || ''
          const cur = data?.current_condition?.[0] || {}
          const desc = cur?.lang_zh?.[0]?.value || cur?.weatherDesc?.[0]?.value || ''
          result.city = area
          result.weather = desc
          result.temperature = cur?.temp_C ? cur.temp_C + '°C（体感 ' + (cur.FeelsLikeC ?? '?') + '°C）' : ''
        } catch (error) {
          result.error = String(error?.message || error).slice(0, 120)
        }
        return result
      }

      const entry = SYSTEM_ACTIONS[action]
      if (!entry) return { ok: false, action, error: '未知 action：' + action }
      const result = await runPowerShell(entry.command)
      return { action: entry.label, ok: result.ok, message: result.message }
    },
  }

  return [naga]
}
