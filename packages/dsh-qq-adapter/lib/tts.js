/**
 * SSVO 语音网关客户端（uni-voice，默认 127.0.0.1:9882）。
 *
 * 链路：POST /say 提交文本 → 轮询 /jobs/{id} 等 ready → GET /jobs/{id}/audio 落 wav。
 * 网关内部按情景选引擎（cache → gsv → edge → sapi），本模块只负责提交、等待、取文件。
 * 出错一律抛错，由调用方决定回退（SAPI）或直接失败，不在本模块吞异常语义。
 *
 * 显存交替（tts.ollama.enabled）：8GB 卡放不下 Ollama(~3GB) + gsv(~4.3GB)。
 * 语音合成前把 Ollama 里的模型卸载（keep_alive=0）腾出显存，合成结束再按 keep_alive 加载回去。
 * 卸载失败不影响语音（Ollama 没开或刚好空闲），只记在返回原因里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function gatewayUrl(config = {}) {
  return String(config.url || 'http://127.0.0.1:9882').replace(/\/+$/, '')
}

function ollamaBase(config = {}) {
  return String(config.url || 'http://127.0.0.1:11434').replace(/\/+$/, '')
}

async function ollamaJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
  return res.json()
}

async function ollamaLoadedModels(config = {}) {
  const ps = await ollamaJson(`${ollamaBase(config)}/api/ps`, {}, 2500)
  return Array.isArray(ps?.models) ? ps.models : []
}

/**
 * 暂停 Ollama：有模型在显存就卸载，轮询到空或超时。
 * @returns {Promise<boolean>} 是否真的卸载过（false = 本来就没占显存）
 */
export async function pauseOllama(config = {}) {
  const loaded = await ollamaLoadedModels(config)
  if (!loaded.length) return false
  const model = String(config.model || loaded[0]?.name || 'qwen3:4b')
  await ollamaJson(`${ollamaBase(config)}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }, 8000)
  const waitMs = Number(config.unloadWaitMs) || 8000
  const started = Date.now()
  while (Date.now() - started < waitMs) {
    await sleep(400)
    try {
      const left = await ollamaLoadedModels(config)
      if (!left.length) return true
    } catch {
      // 查询失败就当已卸载，避免卡住语音
      return true
    }
  }
  return true
}

/** 恢复 Ollama：按 keepAlive 重新加载模型（不阻塞调用方）。 */
export async function resumeOllama(config = {}) {
  const model = String(config.model || 'qwen3:4b')
  await ollamaJson(`${ollamaBase(config)}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: String(config.keepAlive || '30m') }),
  }, 15000)
}

async function submitAndFetch(text, outPath, config = {}) {
  const base = gatewayUrl(config)
  const scene = String(config.scene || 'auto').trim()
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const body = { text }
  // scene=auto 时不传，交给网关按字数/白名单/tag 自己判定情景
  if (scene && scene !== 'auto') body.scene = scene
  if (Number(config.deadlineMs) > 0) body.deadline_ms = Number(config.deadlineMs)

  const submit = await fetch(`${base}/say`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(config.submitTimeoutMs) || 5000),
  })
  if (!submit.ok) throw new Error(`SSVO /say HTTP ${submit.status}`)
  const submitted = await submit.json()
  const jobId = submitted?.job_id
  if (!jobId) throw new Error('SSVO /say 未返回 job_id')

  const started = Date.now()
  const timeoutMs = Number(config.timeoutMs) || 20000
  const pollMs = Number(config.pollMs) || 600
  const authHeaders = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs)
    const res = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`SSVO /jobs HTTP ${res.status}`)
    const job = await res.json()
    const status = String(job?.status || '')
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`SSVO 合成失败：${job?.error || status}`)
    }
    if (status !== 'ready') continue

    const audio = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/audio`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(15000),
    })
    if (!audio.ok) throw new Error(`SSVO 取音频 HTTP ${audio.status}`)
    const buffer = Buffer.from(await audio.arrayBuffer())
    if (buffer.length < 1000) throw new Error(`SSVO 音频过短（${buffer.length}B）`)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, buffer)
    return {
      bytes: buffer.length,
      engine: String(job?.engine || 'unknown'),
      scene: String(job?.scene || scene || 'auto'),
      ms: Date.now() - started,
    }
  }
  throw new Error(`SSVO 超时（${timeoutMs}ms 内未就绪）`)
}

/**
 * 走网关合成一句话并写入 outPath；合成前暂停 Ollama，结束后恢复。
 * @param {string} text 要朗读的文字
 * @param {string} outPath 目标 wav 绝对路径
 * @param {{url?:string, scene?:string, deadlineMs?:number, timeoutMs?:number, pollMs?:number, apiKey?:string, ollama?:object}} config
 * @returns {Promise<{bytes:number, engine:string, scene:string, ms:number, ollama?:string}>}
 */
export async function synthesizeViaGateway(text, outPath, config = {}) {
  const ollama = config.ollama && config.ollama.enabled !== false ? config.ollama : null
  let paused = false
  let pauseNote = ''
  if (ollama) {
    try {
      paused = await pauseOllama(ollama)
      pauseNote = paused ? '已暂停 Ollama' : 'Ollama 未占用'
    } catch {
      // Ollama 不可达：不影响语音，直接按当前显存状态合成
      pauseNote = 'Ollama 不可达'
    }
  }
  try {
    const info = await submitAndFetch(text, outPath, config)
    return { ...info, ollama: pauseNote || undefined }
  } finally {
    if (paused) {
      // 恢复不阻塞发送：加载 3-5s，语音先发出去
      void resumeOllama(ollama).catch(() => {})
    }
  }
}

/**
 * Windows SAPI 兜底：调 lib/say.ps1 合成 wav。
 * 必须在宿主进程里跑才有语音权限（脚本走 PowerShell）。
 */
export function synthesizeWithSapi(text, outPath) {
  return new Promise((resolve, reject) => {
    const script = path.join(HERE, 'lib', 'say.ps1')
    if (!fs.existsSync(script)) return reject(new Error('缺少 lib/say.ps1'))
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, String(text), String(outPath),
    ], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        if (code !== 0) {
          return reject(new Error(`TTS 退出码 ${code}：${stderr.trim().slice(0, 200)}`))
        }
        const size = fs.statSync(outPath).size
        if (!size) return reject(new Error('TTS 输出为空文件'))
        resolve(size)
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * 文本转语音：优先走本机 SSVO 网关（uni-voice，自然音色），失败回退 SAPI。
 * 返回值带 via，detail 里据此区分实际走的通道。
 * @returns {Promise<{size:number, via:'ssvo'|'sapi', engine?:string, scene?:string, ms?:number}>}
 */
export async function synthesizeSpeech(text, outPath, config = {}, note = () => {}) {
  const tts = { ...(config.tts || {}) }
  if (tts.enabled !== false) {
    try {
      const result = await synthesizeViaGateway(text, outPath, tts)
      return { size: result.bytes, via: 'ssvo', engine: result.engine, scene: result.scene, ms: result.ms }
    } catch (error) {
      if (tts.fallbackToSapi === false) throw error
      note(`TTS 网关不可用，回退 SAPI：${String((error && error.message) || error)}`)
    }
  }
  return { size: await synthesizeWithSapi(text, outPath), via: 'sapi' }
}
