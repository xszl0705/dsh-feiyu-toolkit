/**
 * 工具定义：draw_chart（matplotlib）+ draw_card（Pillow）。
 *
 * 硬约定（来自 docs/绘图落地实施方案-2026-11-01.md）：
 *   1. 只回路径，不回 base64，不把图片内容塞进上下文。
 *   2. 失败要有明确 reason，不产出空图。
 *   3. 凡是图里要出现准确数字/文字的，必须走这条线（生成模型会改数字）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { runPython } from './bridge.js'

const KINDS = ['line', 'bar', 'pie', 'scatter', 'dual']

function slug(text, fallback = 'draw') {
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

function resolveOut(config, given, prefix) {
  // 输出根目录：所有落盘都必须落在它里面。
  // 没有这道约束时 args.outPath 能指向 ~/.ssh/authorized_keys 之类的任意位置，
  // 被提示词注入后就是「覆盖任意文件」（2026-11-01 审计）。
  const root = path.resolve(config.outputDir || path.join(process.cwd(), 'out', 'draw'))
  if (typeof given === 'string' && given.trim()) {
    const target = path.resolve(given.trim())
    const rel = path.relative(root, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`outPath 必须落在输出目录内（${root}），收到：${target}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    return target
  }
  fs.mkdirSync(root, { recursive: true })
  return path.join(root, `${prefix}-${stamp()}.png`)
}

function describe(r) {
  if (!r || r.ok !== true) {
    return `出图失败（${r?.reason || 'UNKNOWN'}）：${r?.error || '未知错误'}`
  }
  const kb = Math.max(1, Math.round((r.bytes || 0) / 1024))
  return `已生成：${r.path}\n尺寸 ${r.width}×${r.height}，${kb}KB，耗时 ${r.elapsedMs}ms\n在正文里用 ![](路径) 引用它。`
}

export function createTools(config = {}) {
  /** ---------- draw_chart ---------- */
  const drawChart = {
    name: 'draw_chart',
    description:
      '用 matplotlib 画数据图（折线/柱状/饼图/散点/双轴），落盘成 PNG 并返回路径。适合任何图里必须出现**准确数字或文字**的场景：趋势、对比、占比、双指标对照。不画插画，不做艺术风格。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: KINDS,
          description: '图表类型。dual=双轴（第 1 个系列柱状、第 2 个折线）。默认 line',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'X 轴标签，如 ["一月","二月","三月"]',
        },
        series: {
          type: 'array',
          description: '数据系列，如 [{"name":"调用次数","data":[40,31,52]}]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '系列名（图例用）' },
              data: { type: 'array', items: { type: 'number' }, description: '数值' },
            },
            required: ['data'],
          },
        },
        title: { type: 'string', description: '标题' },
        xlabel: { type: 'string', description: 'X 轴说明' },
        ylabel: { type: 'string', description: 'Y 轴说明' },
        outPath: { type: 'string', description: '输出路径（可选，默认自动生成在工作区 out/draw 下）' },
      },
      required: ['series'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          elapsedMs: { type: 'number' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const kind = KINDS.includes(String(args?.kind || '').toLowerCase())
        ? String(args.kind).toLowerCase()
        : 'line'
      const series = Array.isArray(args?.series) ? args.series : []
      const labels = Array.isArray(args?.labels) ? args.labels.map(String) : []
      if (!series.length) {
        return { ok: false, reason: 'NO_DATA', error: 'series 为空，没有可画的数据' }
      }
      const outPath = resolveOut(config, args?.outPath, `chart-${slug(args?.title)}`)
      return runPython(
        'chart.py',
        {
          kind,
          labels,
          series: series.map((s) => ({
            name: s?.name ? String(s.name) : '',
            data: Array.isArray(s?.data) ? s.data.map((v) => (v === null || v === '' ? null : Number(v))) : [],
          })),
          title: args?.title ? String(args.title) : '',
          xlabel: args?.xlabel ? String(args.xlabel) : '',
          ylabel: args?.ylabel ? String(args.ylabel) : '',
          outPath,
        },
        { pythonPath: config.pythonPath, timeoutMs: 35000 },
      )
    },
  }

  /** ---------- draw_card ---------- */
  const drawCard = {
    name: 'draw_card',
    description:
      '用 Pillow 把文字排成一张卡片图（渐变底 + 白卡 + 中文自动换行）。两种形态：card=标题+正文段落；rows=键值列表（适合体检报告、榜单、对比清单）。落盘返回路径。不依赖 GPU 与网络。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['card', 'rows'],
          description: 'card=段落卡片（默认），rows=键值列表',
        },
        title: { type: 'string', description: '标题' },
        body: { type: 'string', description: '正文（card 模式用，支持 \\n 换行）' },
        rows: {
          type: 'array',
          description: '键值对列表（rows 模式用），如 [["底模","anything-v5"],["显存","8187MB"]]',
          items: { type: 'array', items: { type: 'string' } },
        },
        footer: { type: 'string', description: '页脚小字' },
        width: { type: 'number', description: '图片宽度，默认 900' },
        outPath: { type: 'string', description: '输出路径（可选）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          elapsedMs: { type: 'number' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    timeoutMs: 25000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const kind = String(args?.kind || 'card').toLowerCase() === 'rows' ? 'rows' : 'card'
      const rows = Array.isArray(args?.rows) ? args.rows : []
      if (kind === 'rows' && !rows.length) {
        return { ok: false, reason: 'NO_DATA', error: 'rows 模式需要非空 rows' }
      }
      if (kind === 'card' && !args?.title && !args?.body) {
        return { ok: false, reason: 'NO_DATA', error: 'card 模式需要 title 或 body' }
      }
      const outPath = resolveOut(config, args?.outPath, `card-${slug(args?.title)}`)
      const width = Math.min(Math.max(Number(args?.width) || 900, 480), 1600)
      return runPython(
        'card.py',
        {
          kind,
          title: args?.title ? String(args.title) : '',
          body: args?.body ? String(args.body) : '',
          rows: rows.map((r) => (Array.isArray(r) ? r.map(String) : [String(r), ''])),
          footer: args?.footer ? String(args.footer) : '',
          width,
          outPath,
        },
        { pythonPath: config.pythonPath, timeoutMs: 20000 },
      )
    },
  }

  return [drawChart, drawCard]
}
