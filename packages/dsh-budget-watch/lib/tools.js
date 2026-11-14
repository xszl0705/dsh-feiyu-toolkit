/**
 * 单入口工具 budget(action=status|sessions|advice)，由 budget_status / budget_sessions / budget_advice 合并而来。
 *
 * 全部只读：只解析会话日志里的 usage，不改任何东西、不起子进程、不联网。
 * 「建议交接」只是一句话，不替用户切会话——那是开关，归人。
 *
 * 判定用**双条件**（2026-11-08 起）：步数 + 最近一步的实际输入规模。
 * 只看步数会漏掉「没到 250 步但上下文已经 480k」的会话——实测确实存在（221 步峰值 485k）。
 */
import { collectSessions, resolveSessionFile, shapeOfSession, summarizeFile } from './usage.js'

export const DEFAULTS = {
  stepsWarn: 200,
  stepsHard: 250,
  tokensWarn: 200000000,
  perStepWarn: 400000,
  cacheRateWarn: 0.7,
  contextWarn: 250000,
  contextHard: 400000,
  burstInput: 100000,
  burstCacheRate: 0.8,
  burstCount: 2,
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US')
}

function pct(x) {
  return (Number(x || 0) * 100).toFixed(1) + '%'
}

/** 会话目录名是 uuid；兼容老格式 session-<uuid>。 */
function shortId(name) {
  const s = String(name || '')
  return (s.startsWith('session-') ? s.slice(8) : s).slice(0, 8) || '?'
}

/**
 * 连续 burstCount 步都满足「非缓存输入 ≥ burstInput 且缓存占比 < burstCacheRate」。
 * 这是缓存失效的典型形态：本来该命中的前缀全变成新输入。
 */
export function detectBurst(recent, thresholds = DEFAULTS) {
  const t = { ...DEFAULTS, ...thresholds }
  const n = Math.max(1, Number(t.burstCount) || 2)
  if (!Array.isArray(recent) || recent.length < n) return false
  return recent.slice(-n).every((s) => {
    const input = Number(s?.input) || 0
    const cache = Number(s?.cache) || 0
    const ctx = input + cache
    if (input < t.burstInput) return false
    return ctx > 0 && cache / ctx < t.burstCacheRate
  })
}

/**
 * 根据阈值算告警。四档：ok → prepare（准备账本）→ warn（软线）→ hard（该交接）。
 *
 * - hard：步数 ≥ stepsHard，或最近一步上下文 ≥ contextHard（该在回复边界交接）
 * - prepare：步数 ≥ stepsWarn，或上下文 ≥ contextWarn，或连续突发
 * - warn：累计/每步均值/缓存命中这几条老软线
 */
export function judge(stat, thresholds = DEFAULTS) {
  const t = { ...DEFAULTS, ...thresholds }
  const hard = []
  const warn = []
  const prepare = []
  const ctx = Number(stat.context) || 0
  const burst = detectBurst(stat.recent, t)

  if (stat.steps >= t.stepsHard) hard.push(`步数 ${stat.steps} ≥ ${t.stepsHard}，收束后交接`)
  else if (ctx >= t.contextHard) hard.push(`上下文 ${fmt(ctx)} ≥ ${fmt(t.contextHard)}，在回复边界交接`)
  else if (stat.steps >= t.stepsWarn) prepare.push(`步数 ${stat.steps} ≥ ${t.stepsWarn}，先准备账本`)
  else if (ctx >= t.contextWarn) prepare.push(`上下文 ${fmt(ctx)} ≥ ${fmt(t.contextWarn)}，先准备账本`)
  else if (burst) prepare.push(`连续 ${t.burstCount} 步非缓存输入 ≥ ${fmt(t.burstInput)} 且缓存 < ${pct(t.burstCacheRate)}`)

  if (stat.total >= t.tokensWarn) warn.push(`累计 ${(stat.total / 1e8).toFixed(2)} 亿 ≥ ${(t.tokensWarn / 1e8).toFixed(2)} 亿`)
  if (stat.perStep >= t.perStepWarn) warn.push(`每步 ${fmt(stat.perStep)} ≥ ${fmt(t.perStepWarn)}`)
  if (stat.cacheRate < t.cacheRateWarn && stat.steps > 50) warn.push(`缓存命中 ${pct(stat.cacheRate)} < ${pct(t.cacheRateWarn)}`)

  const level = hard.length ? 'hard' : warn.length ? 'warn' : prepare.length ? 'prepare' : 'ok'
  return { level, alerts: [...hard, ...warn, ...prepare], thresholds: t }
}

export function createTools(config = {}, hooks = {}) {
  const thresholds = {
    stepsWarn: Number(config.stepsWarn) || DEFAULTS.stepsWarn,
    stepsHard: Number(config.stepsHard) || DEFAULTS.stepsHard,
    tokensWarn: Number(config.tokensWarn) || DEFAULTS.tokensWarn,
    perStepWarn: Number(config.perStepWarn) || DEFAULTS.perStepWarn,
    cacheRateWarn: Number(config.cacheRateWarn) || DEFAULTS.cacheRateWarn,
    contextWarn: Number(config.contextWarn) || DEFAULTS.contextWarn,
    contextHard: Number(config.contextHard) || DEFAULTS.contextHard,
    burstInput: Number(config.burstInput) || DEFAULTS.burstInput,
    burstCacheRate: Number(config.burstCacheRate) || DEFAULTS.burstCacheRate,
    burstCount: Number(config.burstCount) || DEFAULTS.burstCount,
  }

  /**
   * 当前会话优先按会话 id 定位（index.js 从 session/event 记下来的），
   * 拿不到才退回「最近改动的日志」——mtime 会被子代理和后台会话干扰。
   */
  function resolveCurrent() {
    let id = ''
    try {
      id = typeof hooks.getSessionId === 'function' ? String(hooks.getSessionId() || '') : ''
    } catch {
      id = ''
    }
    if (id) {
      const file = resolveSessionFile(id)
      if (file) {
        const stat = summarizeFile(file)
        if (stat) return { stat, via: 'session-id' }
      }
    }
    const all = collectSessions({ days: 1 })
    return all.length ? { stat: all[0], via: 'mtime' } : null
  }

  /** ---------- 单入口 budget(action) ---------- */
  const budget = {
    name: 'budget',
    description:
      '看会话 token 预算（合并自 budget_status / budget_sessions / budget_advice）。' +
      'action=status 看当前会话：步数、累计消耗、每步均值、**最近一步的上下文规模**、缓存命中率、是否该交接；' +
      '判定用步数与上下文双条件（200 步或 250k 上下文 → 准备账本；250 步或 400k 上下文 → 该交接）。' +
      'action=sessions 列最近几天各会话消耗（找哪次最贵）；' +
      'action=shape 看当前会话的请求块结构，定位缓存前缀断在哪一块（只算长度与类型，不读正文）；' +
      'action=advice 出交接建议（只输出文字，不执行任何操作，切会话是用户的动作）。纯只读。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'sessions', 'shape', 'advice'],
          description: 'status 看当前会话；sessions 列各会话排行；shape 定位缓存断点；advice 出交接建议',
        },
        stepsWarn: { type: 'number', description: 'status 的步数预警线，默认 200' },
        stepsHard: { type: 'number', description: 'status 的步数硬线，默认 250' },
        contextWarn: { type: 'number', description: 'status 的上下文预警线（输入+缓存），默认 250000' },
        contextHard: { type: 'number', description: 'status 的上下文硬线（输入+缓存），默认 400000' },
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
          via: { type: 'string' },
          steps: { type: 'number' },
          total: { type: 'number' },
          input: { type: 'number' },
          cache: { type: 'number' },
          output: { type: 'number' },
          perStep: { type: 'number' },
          maxStep: { type: 'number' },
          context: { type: 'number' },
          lastInput: { type: 'number' },
          lastCacheRate: { type: 'number' },
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
                context: { type: 'number' },
                cacheRate: { type: 'number' },
              },
            },
          },
          text: { type: 'string' },
          ok: { type: 'boolean' },
          frozen: { type: 'boolean' },
          freezeValue: { type: 'number' },
          totalChars: { type: 'number' },
          breakAt: { type: 'object' },
          turns: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' },
        },
      },
      render: (_args, v) => {
        // advice：沿用旧 budget_advice 的排版
        if (v?.text) return [{ type: 'text', text: v.text }]
        // shape：请求块结构
        if (v?.action === 'shape') {
          if (v?.error) return [{ type: 'text', text: '看不了结构：' + v.error }]
          const lines = [
            '🧩 会话 ' + shortId(v.session) + '｜累计 ' + fmt(v.totalChars) + ' 字符｜' + v.steps + ' 步',
          ]
          if (v.frozen) {
            const b = v.breakAt
            lines.push(
              '🔴 轮首缓存冻结在 ' + fmt(v.freezeValue) + '——断点落在第 ' + (b ? b.i + 1 : '?') + ' 块：' +
                (b ? b.kind + '（' + fmt(b.len) + ' 字符，turn ' + (b.turn ?? '-') + '）' : '未定位'),
            )
            lines.push('含义：该块之后每轮都被重发为新输入。')
          } else {
            lines.push('🟢 轮首缓存未冻结（最近几轮仍在跟随上下文增长）')
          }
          const tail = (v.turns || []).slice(-8)
          if (tail.length) {
            lines.push('')
            lines.push('最近几轮首步：')
            for (const t of tail) {
              lines.push(
                '  turn ' + String(t.turn).padStart(3) + '  缓存 ' + String(fmt(t.cache)).padStart(10) +
                  '  / 上下文 ' + String(fmt(t.ctx)).padStart(10) +
                  '  ' + (t.ctx ? ((t.cache / t.ctx) * 100).toFixed(1) : '0.0') + '%',
              )
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
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
              '  上下文 ' + String(fmt(r.context)).padStart(9) +
              '  缓存 ' + pct(r.cacheRate),
          )
          return [{ type: 'text', text: '共 ' + v.count + ' 个会话：\n' + lines.join('\n') }]
        }
        // status：沿用旧 budget_status 的排版
        if (v?.error) return [{ type: 'text', text: '看不了预算：' + v.error }]
        const head =
          v.level === 'hard'
            ? '🔴 该交接了'
            : v.level === 'warn'
              ? '🟡 有软线超了'
              : v.level === 'prepare'
                ? '🟠 先准备交接'
                : '🟢 正常'
        const lines = [
          head + '｜会话 ' + shortId(v.session) + '｜' + fmt(v.steps) + ' 步' + (v.via === 'mtime' ? '（按mtime猜的会话）' : ''),
          '累计 ' + fmt(v.total) + ' token（新输入 ' + fmt(v.input) + ' + 缓存读 ' + fmt(v.cache) + ' + 输出 ' + fmt(v.output) + '）',
          '每步均值 ' + fmt(v.perStep) + '｜单步最大 ' + fmt(v.maxStep) + '｜缓存命中 ' + pct(v.cacheRate),
          '最近一步上下文 ' + fmt(v.context) + '（新输入 ' + fmt(v.lastInput) + '，缓存 ' + pct(v.lastCacheRate) + '）',
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
        const found = resolveCurrent()
        if (!found) {
          return { action: 'status', session: '', via: '', steps: 0, total: 0, input: 0, cache: 0, output: 0, perStep: 0, maxStep: 0, context: 0, lastInput: 0, lastCacheRate: 0, cacheRate: 0, level: 'ok', alerts: [], error: '没找到会话日志' }
        }
        const cur = found.stat
        const t = {
          ...thresholds,
          stepsWarn: Number(args?.stepsWarn) || thresholds.stepsWarn,
          stepsHard: Number(args?.stepsHard) || thresholds.stepsHard,
          contextWarn: Number(args?.contextWarn) || thresholds.contextWarn,
          contextHard: Number(args?.contextHard) || thresholds.contextHard,
        }
        const verdict = judge(cur, t)
        return {
          action: 'status',
          session: cur.session,
          via: found.via,
          steps: cur.steps,
          total: cur.total,
          input: cur.input,
          cache: cur.cache,
          output: cur.output,
          perStep: cur.perStep,
          maxStep: cur.maxStep,
          context: cur.context,
          lastInput: cur.lastInput,
          lastCacheRate: Number(cur.lastCacheRate.toFixed(4)),
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
            context: s.context,
            cacheRate: Number(s.cacheRate.toFixed(4)),
          })),
          error: '',
        }
      }

      if (action === 'shape') {
        const found = resolveCurrent()
        if (!found) return { ok: false, action: 'shape', error: '没有会话记录' }
        const shape = shapeOfSession(found.stat.file)
        if (!shape) return { ok: false, action: 'shape', error: '会话日志读不出来' }
        const out = {
          ok: true,
          action: 'shape',
          session: found.stat.session,
          via: found.via,
          steps: found.stat.steps,
          totalChars: shape.totalChars,
          frozen: shape.frozen,
          freezeValue: shape.freezeValue,
          turns: shape.turns.slice(-8),
          error: '',
        }
        // 未冻结时 breakAt 为 null；schema 只接受 object，所以该字段按需挂上
        if (shape.breakAt) out.breakAt = shape.breakAt
        return out
      }

      if (action === 'advice') {
        const found = resolveCurrent()
        if (!found) return { action: 'advice', level: 'ok', text: '没有会话记录，无从建议', error: '' }
        const cur = found.stat
        const verdict = judge(cur, thresholds)
        const saved = Math.round(cur.total * 0.35)
        const lines = []
        if (verdict.level === 'ok') {
          lines.push(
            '当前 ' + cur.steps + ' 步、最近上下文 ' + fmt(cur.context) + '、每步 ' + fmt(cur.perStep) + '、缓存 ' + pct(cur.cacheRate) + '，还没到交接线。',
          )
          lines.push(
            '距离 ' + thresholds.stepsWarn + ' 步还有约 ' + Math.max(0, thresholds.stepsWarn - cur.steps) + ' 步；' +
              '上下文到 ' + fmt(thresholds.contextWarn) + ' 时同样会提醒。',
          )
        } else if (verdict.level === 'prepare') {
          lines.push('**' + cur.steps + ' 步、最近上下文 ' + fmt(cur.context) + '——先准备交接，别急着开新的大活。**')
          lines.push('触发：' + verdict.alerts.join('；'))
          lines.push('')
          lines.push('现在先做：把当前任务的目标、已完成项、下一步写成账本（memory_note(kind=handoff)），制品路径列清楚。')
          lines.push('还能继续做收尾性的小改动；大段新工作留到新会话。')
          lines.push('' + '距离硬线 ' + thresholds.stepsHard + ' 步还有 ' + Math.max(0, thresholds.stepsHard - cur.steps) + ' 步。')
          lines.push('')
          lines.push('**不会自动切**：切会话是开关，归你。')
        } else {
          lines.push('**' + cur.steps + ' 步、累计 ' + fmt(cur.total) + ' token、最近上下文 ' + fmt(cur.context) + '**')
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
