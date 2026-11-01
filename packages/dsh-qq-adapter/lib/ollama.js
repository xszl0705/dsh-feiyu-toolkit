/**
 * Ollama 自启：DSH 启动时若本地模型没跑，就用隐藏控制台把它拉起来。
 * 只在 QQ 适配器加载时挂一次；进程退出不主动杀 Ollama。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'

export function startOllamaWatch(local = {}, log = () => {}) {
  const endpoint = String(local.endpoint || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const exe = String(local.exe || '')
  const models = String(local.models || '')
  let starting = false

  const ping = async () => {
    try {
      const res = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  const tick = async () => {
    if (await ping()) return
    if (starting) return
    if (!fs.existsSync(exe)) {
      log('Ollama 自启跳过：找不到 ' + exe)
      return
    }
    starting = true
    try {
      const child = spawn(exe, ['serve'], {
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
        env: { ...process.env, OLLAMA_MODELS: models },
      })
      child.on('error', (error) => log('Ollama 自启失败：' + String((error && error.message) || error)))
      child.on('exit', (code) => log('Ollama 进程退出：' + code))
      log('Ollama 自启已拉起（隐藏控制台）')
    } catch (error) {
      log('Ollama 自启异常：' + String((error && error.message) || error))
    } finally {
      starting = false
    }
  }

  void tick()
  const timer = setInterval(tick, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
