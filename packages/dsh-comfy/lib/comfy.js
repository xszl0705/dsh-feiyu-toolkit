/**
 * ComfyUI HTTP 客户端。
 *
 * 协议（ComfyUI ≥0.3）：
 *   POST /prompt    { prompt: <API 格式工作流>, client_id }  -> { prompt_id }
 *   GET  /history/<id>                                        -> { <id>: { status, outputs } }
 *   GET  /system_stats, /object_info                           -> 设备与可用模型
 *
 * 出图落在 ComfyUI 的 --output-directory 里，按 filename 从磁盘读，不需要 /view。
 */
import http from 'node:http'
import { URL } from 'node:url'

function requestJson(baseUrl, method, pathname, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(pathname, baseUrl)
    } catch (error) {
      resolve({ ok: false, error: `baseUrl 不合法: ${error?.message || error}` })
      return
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 400) {
            resolve({ ok: false, status: res.statusCode, error: text.slice(0, 400) })
            return
          }
          try {
            resolve({ ok: true, data: JSON.parse(text) })
          } catch {
            resolve({ ok: false, error: `返回不是 JSON: ${text.slice(0, 200)}` })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (error) => {
      resolve({ ok: false, error: String(error?.message || error), offline: true })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

export async function systemStats(baseUrl) {
  const r = await requestJson(baseUrl, 'GET', '/system_stats', undefined, 6000)
  if (!r.ok) return { up: false, error: r.error }
  const d = r.data || {}
  const dev = (d.devices || [])[0] || {}
  return {
    up: true,
    version: d.system?.comfyui_version || '',
    python: d.system?.python_version || '',
    gpu: dev.name || '',
    vramTotalMb: dev.vram_total ? Math.round(dev.vram_total / 2 ** 20) : 0,
    vramFreeMb: dev.vram_free ? Math.round(dev.vram_free / 2 ** 20) : 0,
  }
}

export async function objectInfo(baseUrl) {
  const r = await requestJson(baseUrl, 'GET', '/object_info', undefined, 20000)
  if (!r.ok) return { ok: false, error: r.error }
  const oi = r.data || {}
  const ckpt = oi.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []
  const cn = oi.ControlNetLoader?.input?.required?.control_net_name?.[0] || []
  return { ok: true, checkpoints: ckpt, controlnets: cn, nodes: Object.keys(oi) }
}

export async function submit(baseUrl, workflow, clientId) {
  const r = await requestJson(baseUrl, 'POST', '/prompt', {
    prompt: workflow,
    client_id: clientId || 'dsh-comfy',
  })
  if (!r.ok) {
    if (r.offline) return { ok: false, reason: 'OFFLINE', error: `连不上 ComfyUI：${r.error}` }
    return { ok: false, reason: 'REJECTED', error: r.error }
  }
  if (!r.data?.prompt_id) {
    return { ok: false, reason: 'REJECTED', error: JSON.stringify(r.data).slice(0, 400) }
  }
  return { ok: true, promptId: r.data.prompt_id }
}

export async function waitFor(baseUrl, promptId, timeoutMs = 120000, intervalMs = 800) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await requestJson(baseUrl, 'GET', `/history/${promptId}`, undefined, 8000)
    if (!r.ok) {
      if (r.offline) return { ok: false, reason: 'OFFLINE', error: r.error }
    } else if (r.data && r.data[promptId]) {
      const entry = r.data[promptId]
      const status = entry.status || {}
      if (status.status_str === 'error') {
        const msgs = status.messages || []
        const err = msgs.find((m) => m?.[0] === 'execution_error')
        const detail = err?.[1]?.exception_message || JSON.stringify(msgs).slice(0, 400)
        return { ok: false, reason: 'EXEC_ERROR', error: String(detail).slice(0, 500) }
      }
      if (status.completed === true || status.completed === undefined) {
        return { ok: true, entry }
      }
    }
    await new Promise((r2) => setTimeout(r2, intervalMs))
  }
  return { ok: false, reason: 'TIMEOUT', error: `${timeoutMs}ms 内没出图（冷启动时首次可能较慢）` }
}

export function outputFiles(entry) {
  const names = []
  for (const nodeOut of Object.values(entry?.outputs || {})) {
    for (const img of nodeOut?.images || []) {
      names.push([img.subfolder, img.filename].filter(Boolean).join('/'))
    }
  }
  return names
}

export function txt2imgWorkflow(ckpt, opts = {}) {
  const {
    positive = '', negative = '', width = 512, height = 768,
    steps = 25, cfg = 7, seed = 42, prefix = 'dsh', sampler = 'euler_ancestral',
  } = opts
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    5: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed, steps, cfg, sampler_name: sampler, scheduler: 'normal', denoise: 1.0,
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } },
  }
}

/** Canny 是 ComfyUI 原生节点，不需要下载任何权重（_aux 系列预处理器要下模型，沙箱里会写不进去）。 */
export function controlnetWorkflow(ckpt, controlnet, imageName, opts = {}) {
  const {
    positive = '', negative = '', strength = 0.8, width = 512, height = 768,
    steps = 25, cfg = 7, seed = 42, prefix = 'dsh_cn',
    lowThreshold = 0.4, highThreshold = 0.8,
  } = opts
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    8: { class_type: 'LoadImage', inputs: { image: imageName } },
    9: {
      class_type: 'Canny',
      inputs: { image: ['8', 0], low_threshold: lowThreshold, high_threshold: highThreshold },
    },
    10: { class_type: 'ControlNetLoader', inputs: { control_net_name: controlnet } },
    11: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ['2', 0], negative: ['3', 0], control_net: ['10', 0], image: ['9', 0],
        strength, start_percent: 0.0, end_percent: 1.0,
      },
    },
    5: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['11', 0], negative: ['11', 1], latent_image: ['4', 0],
        seed, steps, cfg, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1.0,
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } },
  }
}
