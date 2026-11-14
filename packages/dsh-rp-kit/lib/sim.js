/**
 * 蒙特卡洛数值模拟。只跑用户给的表达式，不猜规则语义。
 *
 * spec:
 * {
 *   name?: string,
 *   trials?: number,          // 默认 10000，上限 config.simTrialLimit
 *   maxRounds?: number,       // 默认 20
 *   hit?: { dice?: "d100", lte: 65 },   // 省略 = 必中
 *   damage: "1d10+3",
 *   crit?: { lte: 5, extra: "1d10" },   // 省略 = 无暴击
 *   defender: { hp: 40, dr?: 0 }
 * }
 */

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function parseDice(expr) {
  const text = String(expr || '').replace(/\s+/g, '').toLowerCase()
  if (!text) throw new Error('骰式为空的')
  const fixed = /^([+-]?\d+)$/.exec(text)
  if (fixed) return { count: 0, sides: 0, bonus: Number(fixed[1]) }
  const m = /^(\d*)d(\d+)([+-]\d+)?$/.exec(text)
  if (m) return { count: m[1] ? Number(m[1]) : 1, sides: Number(m[2]), bonus: m[3] ? Number(m[3]) : 0 }
  // 1d10+3 已覆盖；再兜底 "2d6-1"、"d20" 之外的形式交给上层报错
  throw new Error('看不懂的骰式：' + expr + '（支持 d20 / 1d10+3 / 5 这种）')
}

export function rollDice(parsed, rng) {
  let total = parsed.bonus
  for (let i = 0; i < parsed.count; i += 1) total += 1 + Math.floor(rng() * parsed.sides)
  return total
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))
  return sorted[idx]
}

export function simulate(spec, limits = {}) {
  const name = spec?.name || '未命名模拟'
  const trialCap = Number(limits.simTrialLimit) || 50000
  const trials = Math.max(100, Math.min(trialCap, Number(spec?.trials) || 10000))
  const maxRounds = Math.max(1, Math.min(100, Number(spec?.maxRounds) || 20))
  const hp = Number(spec?.defender?.hp)
  const dr = Number(spec?.defender?.dr) || 0
  if (!Number.isFinite(hp) || hp <= 0) throw new Error('defender.hp 必须是正数')
  const damage = parseDice(spec?.damage)
  const hitSpec = spec?.hit ? { dice: parseDice(spec.hit.dice || 'd100'), lte: Number(spec.hit.lte) } : null
  if (hitSpec && (!Number.isFinite(hitSpec.lte) || hitSpec.lte <= 0)) throw new Error('hit.lte 必须是正数百分比')
  const critSpec = spec?.crit ? { lte: Number(spec.crit.lte), extra: parseDice(spec.crit.extra || '0') } : null
  const rng = mulberry32(20261105)
  const killRounds = []
  let hits = 0
  let checks = 0
  let crits = 0
  let damageTotal = 0
  let roundsTotal = 0
  for (let t = 0; t < trials; t += 1) {
    let remain = hp
    let killedAt = 0
    for (let round = 1; round <= maxRounds; round += 1) {
      roundsTotal += 1
      let hit = true
      if (hitSpec) {
        checks += 1
        hit = rollDice(hitSpec.dice, rng) <= hitSpec.lte
      }
      if (!hit) continue
      hits += 1
      let dmg = rollDice(damage, rng)
      if (critSpec && rollDice({ count: 1, sides: 100, bonus: 0 }, rng) <= critSpec.lte) {
        crits += 1
        dmg += rollDice(critSpec.extra, rng)
      }
      dmg = Math.max(0, dmg - dr)
      damageTotal += dmg
      remain -= dmg
      if (remain <= 0) {
        killedAt = round
        break
      }
    }
    if (killedAt) killRounds.push(killedAt)
  }
  killRounds.sort((a, b) => a - b)
  return {
    name,
    trials,
    maxRounds,
    hitRate: checks ? +(hits / checks).toFixed(4) : 1,
    critRate: hitSpec ? +(crits / Math.max(1, hits)).toFixed(4) : 0,
    avgDamagePerRound: +(damageTotal / Math.max(1, trials * Math.min(maxRounds, 5))).toFixed(2),
    killRate: +(killRounds.length / trials).toFixed(4),
    roundsToKill: killRounds.length
      ? { p10: pct(killRounds, 0.1), p50: pct(killRounds, 0.5), p90: pct(killRounds, 0.9), mean: +(killRounds.reduce((a, b) => a + b, 0) / killRounds.length).toFixed(2) }
      : null,
    verdict: judge(killRounds.length / trials, killRounds, maxRounds),
  }
}

function judge(killRate, killRounds, maxRounds) {
  if (!killRounds.length) return '打不死：' + maxRounds + ' 轮内无法击杀，检查伤害与 HP 是否匹配'
  const p50 = pct(killRounds, 0.5)
  if (p50 < 2) return '太快：中位数 ' + p50 + ' 轮就结束，没给玩家操作空间'
  if (p50 > 12) return '太慢：中位数 ' + p50 + ' 轮，群聊里会拖到失去节奏'
  if (killRate < 0.8) return '不稳：只有 ' + Math.round(killRate * 100) + '% 的局能在 ' + maxRounds + ' 轮内击杀，方差偏大'
  return '可接受：中位数 ' + p50 + ' 轮击杀'
}
