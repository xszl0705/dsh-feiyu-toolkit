/**
 * 单入口工具 budget(action=status|sessions|advice)，由 budget_status / budget_sessions / budget_advice 合并而来。
 *
 * 全部只读：只解析会话日志里的 usage，不改任何东西、不起子进程、不联网。
 * 「建议交接」只是一句话，不替用户切会话——那是开关，归人。
 */
import path from 'node:path'

import { collectSessions } from './usage.js'

const DEFAULTS = {
  stepsWarn: 200,
  stepsHard: 250,
  tokensWarn: 200000000,
  perStepWarn: 400000,
  cacheRateWarn: 0.7,
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US')
}

function pct(x) {
  return (Number(x || 0) * 100).toFixed(1) + '%'
}

/** 会话目录名形如 session-95b11640-0dc9-...，前 8 位全是 "session-"，没有信息量。 */
function shortId(name) {
  const s = String(name || '')
  return (s.startsWith('session-') ? s.slice(8) : s).slice(0, 8) || '?'
}

/** 根据阈值算告警。硬线优先于软线。 */
export function judge(stat, thresholds = DEFAULTS) {
  const t = { ...DEFAULTS, ...thresholds }
  const alerts = []
  const hard = []
  if (stat.steps >= t.stepsHard) hard.push(`步数 ${stat.steps} ≥ ${t.stepsHard}`)
  else if (stat.steps >= t.stepsWarn) alerts.push(`步数 ${stat.steps} ≥ ${t.stepsWarn}`)
  if (stat.total >= t.tokensWarn) alerts.push(`累计 ${(stat.total / 1e8).toFixed(2)} 亿 ≥ ${(t.tokensWarn / 1e8).toFixed(2)} 亿`)
  if (stat.perStep >= t.perStepWarn) alerts.push(`每步 ${fmt(stat.perStep)} ≥ ${fmt(t.perStepWarn)}`)
  if (stat.cacheRate < t.cacheRateWarn && stat.steps > 50) alerts.push(`缓存命中 ${pct(stat.cacheRate)} < ${pct(t.cacheRateWarn)}`)
  const level = hard.length ? 'hard' : alerts.length ? 'warn' : 'ok'
  return { level, alerts: [...hard, ...alerts], thresholds: t }
}

export function createTools(config = {}) {
  const thresholds = {
    stepsWarn: Number(config.stepsWarn) || DEFAULTS.stepsWarn,
    stepsHard: Number(config.stepsHard) || DEFAULTS.stepsHard,
    tokensWarn: Number(config.tokensWarn) || DEFAULTS.tokensWarn,
    perStepWarn: Number(config.perStepWarn) || DEFAULTS.perStepWarn,
    cacheRateWarn: Number(config.cacheRateWarn) || DEFAULTS.cacheRateWarn,
  }

  /** ---------- 单入口 budget(action) ---------- */
  const budget = {
    name: 'budget',
    description:
      '看会话 token 预算（合并自 budget_status / budget_sessions / budget_advice）。' +
      'action=status 看当前会话：步数、累计消耗、每步均值、缓存命中率、是否该交接；' +
      'action=sessions 列最近几天各会话消耗（找哪次最贵）；' +
      'action=advice 出交接建议（只输出文字，不执行任何操作，切会话是用户的动作）。纯只读。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'sessions', 'advice'],
          description: 'status 看当前会话；sessions 列各会话排行；advice 出交接建议',
        },
        stepsWarn: { type: 'number', description: 'status 的步数预警线，默认 200' },
        stepsHard: { type: 'number', description: 'status 的步数硬线，默认 300' },
        days: { type: 'number', description: 'sessions 最近几天，默认 1' },
        limit: { type: 'number', description: 'sessions 最多返回几条，默认 10' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          session: { type: 'string' },
          steps: { type: 'number' },
          total: { type: 'number' },
          input: { type: 'number' },
          cache: { type: 'number' },
          output: { type: 'number' },
          perStep: { type: 'number' },
          maxStep: { type: 'number' },
          cacheRate: { type: 'number' },
          level: { type: 'string' },
          alerts: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                session: { type: 'string' },
                steps: { type: 'number' },
                total: { type: 'number' },
                perStep: { type: 'number' },
                cacheRate: { type: 'number' },
              },
            },
          },
          text: { type: 'string' },
          ok: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, v) => {
        // advice：沿用旧 budget_advice 的排版
        if (v?.text) return [{ type: 'text', text: v.text }]
        // 未知 action
        if (v?.ok === false) return [{ type: 'text', text: v?.error || '未知 action' }]
        // sessions：沿用旧 budget_sessions 的排版
        if (Array.isArray(v?.rows)) {
          if (v?.error) return [{ type: 'text', text: '查不了：' + v.error }]
          if (!v.rows.length) return [{ type: 'text', text: '最近没有会话记录' }]
          const lines = v.rows.map(
            (r, i) =>
              String(i + 1).padStart(2) +
              '. ' + String(shortId(r.session)).padEnd(8) +
              '  ' + String(r.steps).padStart(5) + ' 步' +
              '  总 ' + String(fmt(r.total)).padStart(12) +
              '  每步 ' + String(fmt(r.perStep)).padStart(8) +
              '  缓存 ' + pct(r.cacheRate),
          )
          return [{ type: 'text', text: '共 ' + v.count + ' 个会话：\n' + lines.join('\n') }]
        }
        // status：沿用旧 budget_status 的排版
        if (v?.error) return [{ type: 'text', text: '看不了预算：' + v.error }]
        const head = v.level === 'hard' ? '🔴 该交接了' : v.level === 'warn' ? '🟡 接近交接线' : '🟢 正常'
        const lines = [
          head + '｜会话 ' + shortId(v.session) + '｜' + fmt(v.steps) + ' 步',
          '累计 ' + fmt(v.total) + ' token（新输入 ' + fmt(v.input) + ' + 缓存读 ' + fmt(v.cache) + ' + 输出 ' + fmt(v.output) + '）',
          '每步均值 ' + fmt(v.perStep) + '｜单步最大 ' + fmt(v.maxStep) + '｜缓存命中 ' + pct(v.cacheRate),
        ]
        if (v.alerts?.length) lines.push('触发：' + v.alerts.join('；'))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args = {}) => {
      const action = String(args?.action || '')

      if (action === 'status') {
        const all = collectSessions({ days: 1 })
        if (!all.length) {
          return { action: 'status', session: '', steps: 0, total: 0, input: 0, cache: 0, output: 0, perStep: 0, maxStep: 0, cacheRate: 0, level: 'ok', alerts: [], error: '没找到会话日志' }
        }
        const cur = all[0]
        const t = {
          ...thresholds,
          stepsWarn: Number(args?.stepsWarn) || thresholds.stepsWarn,
          stepsHard: Number(args?.stepsHard) || thresholds.stepsHard,
        }
        const verdict = judge(cur, t)
        return {
          action: 'status',
          session: cur.session,
          steps: cur.steps,
          total: cur.total,
          input: cur.input,
          cache: cur.cache,
          output: cur.output,
          perStep: cur.perStep,
          maxStep: cur.maxStep,
          cacheRate: cur.cacheRate,
          level: verdict.level,
          alerts: verdict.alerts,
          error: '',
        }
      }

      if (action === 'sessions') {
        const days = Math.max(1, Number(args?.days) || 1)
        const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10))
        const all = collectSessions({ days }).sort((a, b) => b.total - a.total)
        return {
          action: 'sessions',
          count: all.length,
          rows: all.slice(0, limit).map((s) => ({
            session: s.session,
            steps: s.steps,
            total: s.total,
            perStep: s.perStep,
            cacheRate: Number(s.cacheRate.toFixed(4)),
          })),
          error: '',
        }
      }

      if (action === 'advice') {
        const all = collectSessions({ days: 1 })
        if (!all.length) return { action: 'advice', level: 'ok', text: '没有会话记录，无从建议', error: '' }
        const cur = all[0]
        const verdict = judge(cur, thresholds)
        const saved = Math.round(cur.total * 0.35)
        const lines = []
        if (verdict.level === 'ok') {
          lines.push('当前 ' + cur.steps + ' 步、每步 ' + fmt(cur.perStep) + '、缓存 ' + pct(cur.cacheRate) + '，还没到交接线。')
          lines.push('距离 ' + thresholds.stepsWarn + ' 步还有约 ' + Math.max(0, thresholds.stepsWarn - cur.steps) + ' 步。')
        } else {
          lines.push('**当前 ' + cur.steps + ' 步、累计 ' + fmt(cur.total) + ' token、缓存命中 ' + pct(cur.cacheRate) + '**')
          lines.push('触发：' + verdict.alerts.join('；'))
          lines.push('')
          lines.push('如果继续跑，每多 100 步大约再花 ' + fmt(cur.perStep * 100) + ' token；')
          lines.push('现在交接并开新会话，同类工作量能省约 ' + fmt(saved) + ' token（33%~45%，按实测拆段估算）。')
          lines.push('')
          lines.push('交接怎么做（需要你操作）：')
          lines.push('1. 让我写一份交接账本（memory_note(kind=handoff)）')
          lines.push('2. 你在界面上新建会话')
          lines.push('3. 新会话开头让我 memory_recall 取账本')
          lines.push('')
          lines.push('**不会自动切**：切会话是开关，归你。')
        }
        return { action: 'advice', level: verdict.level, text: lines.join('\n'), error: '' }
      }

      return { ok: false, action, error: '未知 action：' + action }
    },
  }

  return [budget]
}
