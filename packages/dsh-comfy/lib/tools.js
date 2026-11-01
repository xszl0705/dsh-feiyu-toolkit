/**
 * 工具定义：单入口 comfy(action=status|generate|controlnet)，旧的三工具名不再注册。
 *
 * 硬约定（docs/绘图落地实施方案-2026-11-01.md 第 3.7 节）：
 *   1. 服务没起就明确报「未启动」，绝不自己去把它拉起来（服务生命周期归用户）。
 *   2. 只回路径，不回 base64。
 *   3. 超时给明确原因，不静默失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  systemStats, objectInfo, submit, waitFor, outputFiles,
  txt2imgWorkflow, controlnetWorkflow,
} from './comfy.js'

/**
 * 只看文件头判断是不是真图片，不信扩展名。
 * 用途：拦住「把任意文件当参考图复制进 ComfyUI input 目录」这条路（2026-11-01 审计）。
 */
export function looksLikeImage(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(12)
    const n = fs.readSync(fd, buf, 0, 12, 0)
    if (n < 4) return false
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true // PNG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true // JPEG
    if (buf.subarray(0, 3).toString('ascii') === 'GIF') return true // GIF
    if (buf[0] === 0x42 && buf[1] === 0x4d) return true // BMP
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true // WebP
    return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 忽略 */ }
    }
  }
}

function slug(text, fallback = 'comfy') {
  const s = String(text || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return s || fallback
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function primaryDescribe(r, kind) {
  if (!r || r.ok !== true) {
    const reason = r?.reason || 'UNKNOWN'
    const hint =
      reason === 'OFFLINE'
        ? '\nComfyUI 没在跑。这一步需要你手动启动（模型不负责拉起服务）。启动命令见 docs/绘图落地实施方案-2026-11-01.md 第 3.3 节。'
        : ''
    return `出图失败（${reason}）：${r?.error || '未知错误'}${hint}`
  }
  const kb = Math.max(1, Math.round((r.bytes || 0) / 1024))
  return `已生成：${r.path}\n${r.width}×${r.height}，${kb}KB，耗时 ${Math.round((r.elapsedMs || 0) / 1000)}s（${kind}）\n在正文里用 ![](路径) 引用它。`
}

/** 等 ComfyUI 把文件写盘（它先回 history 再落盘的情况很少，但保险起见重试几次）。 */
async function pickOutputFile(dir, name, tries = 10) {
  const target = path.join(dir, name.split('/').join(path.sep))
  for (let i = 0; i < tries; i++) {
    if (fs.existsSync(target)) return target
    await new Promise((r) => setTimeout(r, 200))
  }
  return ''
}

export function createTools(config = {}) {
  const baseUrl = config.baseUrl || 'http://127.0.0.1:8188'
  const outDir = config.outputDir || path.join(process.cwd(), 'out', 'comfy')
  const comfyOut = config.comfyOutputDir || ''
  const comfyIn = config.comfyInputDir || ''
  const ckptDefault = config.defaultCheckpoint || 'anything-v5-PrtRE.safetensors'
  const cnDefault = config.defaultControlnet || 'control_v11p_sd15_canny_fp16.safetensors'

  /** ---------- comfy：单入口，action=status|generate|controlnet ---------- */
  const comfy = {
    name: 'comfy',
    description:
      '本地 ComfyUI：action=status 看服务/显存/底模与 ControlNet；generate 文生图（prompt 必填，图里要准确文字请用 draw_chart）；controlnet 用参考图锁构图重绘（imagePath+prompt 必填）。服务没起只报 OFFLINE，不自动拉起。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'generate', 'controlnet'], description: '要做的事' },
        prompt: { type: 'string', description: 'generate/controlnet 用：正向提示词' },
        negative: { type: 'string', description: '反向提示词，可选' },
        imagePath: { type: 'string', description: 'controlnet 用：参考图绝对路径（会被复制到 ComfyUI 的 input 目录）' },
        ckpt: { type: 'string', description: `底模名，默认 ${ckptDefault}` },
        controlnet: { type: 'string', description: `controlnet 用：ControlNet 模型名，默认 ${cnDefault}` },
        strength: { type: 'number', description: 'controlnet 用：控制强度 0~1，默认 0.8' },
        width: { type: 'number', description: '宽，默认 512' },
        height: { type: 'number', description: '高，默认 768' },
        steps: { type: 'number', description: '步数，默认 25' },
        cfg: { type: 'number', description: 'generate 用：CFG，默认 7' },
        seed: { type: 'number', description: '随机种子，不传则随机' },
        outPath: { type: 'string', description: '输出路径，可选' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' }, ok: { type: 'boolean' }, up: { type: 'boolean' },
          path: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' },
          bytes: { type: 'number' }, elapsedMs: { type: 'number' }, reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => {
        if (v?.action === 'status') {
          if (!v?.up) {
            return [{
              type: 'text',
              text: `ComfyUI 未启动（${baseUrl}）。${v?.error ? '\n' + v.error : ''}\n需要出图的话请手动启动服务，启动命令见 docs/绘图落地实施方案-2026-11-01.md 第 3.3 节。`,
            }]
          }
          return [{
            type: 'text',
            text: [
              `ComfyUI ${v.version} 在跑（${baseUrl}）`,
              `GPU ${v.gpu}｜显存 ${v.vramFreeMb}/${v.vramTotalMb} MB 空闲`,
              `底模 ${v.checkpoints.length} 个：${v.checkpoints.slice(0, 5).join('、')}${v.checkpoints.length > 5 ? ' …' : ''}`,
              `ControlNet ${v.controlnets.length} 个${v.controlnets.length ? '：' + v.controlnets.slice(0, 3).join('、') + (v.controlnets.length > 3 ? ' …' : '') : ''}`,
            ].join('\n'),
          }]
        }
        return [{ type: 'text', text: primaryDescribe(v, v?.action === 'controlnet' ? 'ControlNet' : 'txt2img') }]
      },
    },
    timeoutMs: 240000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args?.action || 'status')
      if (action === 'status') {
        const st = await systemStats(baseUrl)
        if (!st.up) return { action, up: false, baseUrl, error: st.error }
        const oi = await objectInfo(baseUrl)
        return {
          action,
          up: true,
          baseUrl,
          version: st.version,
          gpu: st.gpu,
          vramFreeMb: st.vramFreeMb,
          vramTotalMb: st.vramTotalMb,
          checkpoints: oi.ok ? oi.checkpoints : [],
          controlnets: oi.ok ? oi.controlnets : [],
          defaultCheckpoint: ckptDefault,
          defaultControlnet: cnDefault,
        }
      }
      if (action === 'generate') return { ...(await runJob(args, 'generate')), action }
      if (action === 'controlnet') return { ...(await runJob(args, 'controlnet')), action }
      return { ok: false, action, error: '未知 action：' + action }
    },
  }

  async function runJob(args, mode) {
    const t0 = Date.now()
    if (!comfyOut) {
      return { ok: false, reason: 'NOT_CONFIGURED', error: 'config.json 里没配 comfyOutputDir（ComfyUI 的 --output-directory）' }
    }
    if (mode === 'controlnet' && !comfyIn) {
      return { ok: false, reason: 'NOT_CONFIGURED', error: 'config.json 里没配 comfyInputDir（ComfyUI 的 --input-directory）' }
    }

    // 参数先校验，再连服务：参数错不该被网络错误盖住
    let refInner = ''
    if (mode === 'controlnet') {
      const src = String(args?.imagePath || '')
      if (!src || !fs.existsSync(src)) {
        return { ok: false, reason: 'BAD_INPUT', error: `参考图不存在：${src || '(空)'}` }
      }
      // 只接受真正的图片：否则这一步等于「把任意文件复制进 ComfyUI input 目录」，
      // 配合能读该目录的工具就构成任意文件读取（2026-11-01 审计）。
      if (!looksLikeImage(src)) {
        return {
          ok: false,
          reason: 'BAD_INPUT',
          error: `参考图不是有效图片（只接受 PNG/JPEG/GIF/BMP/WebP）：${src}`,
        }
      }
      const ext = path.extname(src) || '.png'
      refInner = `dshref-${stamp()}-${randomBytes(3).toString('hex')}${ext}`
      try {
        fs.mkdirSync(comfyIn, { recursive: true })
        fs.copyFileSync(src, path.join(comfyIn, refInner))
      } catch (error) {
        return { ok: false, reason: 'IO_FAILED', error: `复制参考图失败：${error?.message || error}` }
      }
    }

    const st = await systemStats(baseUrl)
    if (!st.up) {
      return {
        ok: false,
        reason: 'OFFLINE',
        error: `连不上 ComfyUI（${baseUrl}）：${st.error}。服务需要手动启动。`,
      }
    }

    let workflow
    const seed = Number.isFinite(Number(args?.seed)) ? Number(args.seed) : Math.floor(Math.random() * 2 ** 31)
    const common = {
      positive: String(args?.prompt || ''),
      negative: String(args?.negative || ''),
      width: Math.min(Math.max(Number(args?.width) || 512, 256), 1024),
      height: Math.min(Math.max(Number(args?.height) || 768, 256), 1024),
      steps: Math.min(Math.max(Number(args?.steps) || 25, 4), 60),
      cfg: Math.min(Math.max(Number(args?.cfg) || 7, 1), 20),
      seed,
    }

    if (mode === 'controlnet') {
      workflow = controlnetWorkflow(args?.ckpt || ckptDefault, args?.controlnet || cnDefault, refInner, {
        ...common,
        strength: Math.min(Math.max(Number(args?.strength) || 0.8, 0.1), 1.0),
      })
      if (!workflow) return { ok: false, reason: 'NOT_CONFIGURED', error: 'ControlNet 模型不存在' }
    } else {
      workflow = txt2imgWorkflow(args?.ckpt || ckptDefault, common)
    }

    const sub = await submit(baseUrl, workflow)
    if (!sub.ok) return { ok: false, reason: sub.reason, error: sub.error }

    const done = await waitFor(baseUrl, sub.promptId, mode === 'controlnet' ? 200000 : 150000)
    if (!done.ok) return { ok: false, reason: done.reason, error: done.error, promptId: sub.promptId }

    const files = outputFiles(done.entry)
    if (!files.length) {
      return { ok: false, reason: 'NO_OUTPUT', error: '任务完成了但没有图片输出', promptId: sub.promptId }
    }
    const src = await pickOutputFile(comfyOut, files[0])
    if (!src) {
      return {
        ok: false,
        reason: 'NO_FILE',
        error: `history 说有图，但 ${path.join(comfyOut, files[0])} 不存在——检查 comfyOutputDir 是否和 ComfyUI 的 --output-directory 一致`,
        promptId: sub.promptId,
      }
    }

    // 输出路径必须落在 outDir 内：否则被提示词注入后可以覆盖任意文件（2026-11-01 审计）。
    const root = path.resolve(outDir)
    const outPath = args?.outPath
      ? path.resolve(String(args.outPath))
      : path.join(root, `${mode}-${slug(args?.prompt)}-${stamp()}.png`)
    {
      const rel = path.relative(root, outPath)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          ok: false,
          reason: 'BAD_INPUT',
          error: `outPath 必须落在输出目录内（${root}），收到：${outPath}`,
          promptId: sub.promptId,
        }
      }
    }
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.copyFileSync(src, outPath)
    } catch (error) {
      return { ok: false, reason: 'IO_FAILED', error: `写目标文件失败：${error?.message || error}` }
    }

    const size = fs.statSync(outPath).size
    return {
      ok: true,
      path: outPath,
      bytes: size,
      elapsedMs: Date.now() - t0,
      seed,
      promptId: sub.promptId,
      sourceFile: src,
    }
  }

  return [comfy]
}
