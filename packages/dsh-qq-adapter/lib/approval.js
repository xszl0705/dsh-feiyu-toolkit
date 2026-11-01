/**
 * 陌生人私聊审批：先问主人，同意后才生成回复。
 * 同意过的人在这一轮里后续消息直接放行（本地/大模型由 reply 路由决定）。
 */

export class ApprovalStore {
  constructor({ ttlMs = 10 * 60 * 1000, approvedMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.approvedMs = approvedMs
    this.now = now
    this.pending = new Map()
    this.approved = new Map()
  }

  prune() {
    const now = this.now()
    for (const [id, item] of this.pending) {
      if (now - item.at > this.ttlMs) this.pending.delete(id)
    }
    for (const [id, until] of this.approved) {
      if (until <= now) this.approved.delete(id)
    }
  }

  isApproved(userId) {
    this.prune()
    return (this.approved.get(String(userId)) || 0) > this.now()
  }

  pendingFor(userId) {
    this.prune()
    return this.pending.get(String(userId)) || null
  }

  ask({ userId, name, text, ownerId, send }) {
    const id = String(userId)
    if (this.isApproved(id)) return { status: 'approved' }
    const existing = this.pending.get(id)
    if (existing && this.now() - existing.at < 2 * 60 * 1000) return { status: 'pending' }
    const item = { userId: id, name: String(name || id), text: String(text || ''), at: this.now() }
    this.pending.set(id, item)
    if (send && ownerId) {
      send({
        kind: 'private',
        targetId: String(ownerId),
        text: `QQ 上 ${item.name}（${id}）说：\n「${item.text.slice(0, 160)}」\n\n要回吗？回「同意」或「拒绝」。`,
      }).catch(() => {})
    }
    return { status: 'asked', pending: item }
  }

  resolve(ownerText) {
    this.prune()
    const text = String(ownerText || '').trim()
    const yes = /^(同意|通过|可以|行|回吧|同意回复|回)$/.test(text)
    const no = /^(拒绝|不行|不回|算了|不同意|别回)$/.test(text)
    if (!yes && !no) return null
    let latest = null
    for (const item of this.pending.values()) {
      if (!latest || item.at > latest.at) latest = item
    }
    if (!latest) return { status: 'none' }
    this.pending.delete(latest.userId)
    if (no) return { status: 'denied', pending: latest }
    this.approved.set(latest.userId, this.now() + this.approvedMs)
    return { status: 'approved', pending: latest }
  }
}
