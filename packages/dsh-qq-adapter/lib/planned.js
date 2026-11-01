/**
 * 计划消息与发送前复检（Proactive AI 思路）。
 * 纯函数：不直接发消息。
 */

export function createPlan({
  groupId,
  sourceMessageId = '',
  action = 'reply',
  text = '',
  contextVersion = 0,
  now = Date.now(),
  ttlSec = 180,
} = {}) {
  return {
    id: `plan_${now}_${Math.random().toString(36).slice(2, 8)}`,
    groupId: String(groupId || ''),
    sourceMessageId: String(sourceMessageId || ''),
    action: action === 'ask' ? 'ask' : 'reply',
    text: String(text || '').slice(0, 500),
    createdAt: now,
    expireAt: now + Math.max(10, Number(ttlSec) || 180) * 1000,
    contextVersion: Number(contextVersion) || 0,
    status: 'planned',
  }
}

export function planExpired(plan, now = Date.now()) {
  return !plan || Number(plan.expireAt || 0) <= now
}

/**
 * 返回 { cancel, reason }。
 * newGate 为空表示复检失败/超时，按取消处理。
 */
export function recheckPlan({ plan, now = Date.now(), contextVersion = 0, newGate = null } = {}) {
  if (!plan) return { cancel: true, reason: 'missing-plan' }
  if (plan.status !== 'planned') return { cancel: true, reason: 'not-planned' }
  if (planExpired(plan, now)) return { cancel: true, reason: 'expired' }

  if (Number(contextVersion) !== Number(plan.contextVersion)) {
    if (!newGate || newGate.action === 'silence') return { cancel: true, reason: 'context-changed-silence' }
    if (plan.action === 'reply' && Number(newGate.relevance) < 0.5) return { cancel: true, reason: 'relevance-drop' }
    if (plan.action === 'ask' && newGate.action !== 'ask') return { cancel: true, reason: 'ask-no-longer-valid' }
  }

  if (newGate && newGate.action === 'silence') return { cancel: true, reason: 'gate-silence' }
  return { cancel: false, reason: '' }
}

export function markPlan(plan, status) {
  return { ...plan, status }
}
