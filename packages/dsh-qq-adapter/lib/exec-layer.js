/**
 * 执行层 worker + 图片入库 handler（阶段 1.3 试点）。
 *
 * 只接一类副作用：图片入库（幂等，按 sha256 去重）。
 * 非幂等动作（发消息）先不做，等这一层跑稳再接。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { openExecStore, sqliteReady } from './exec-store.js'

export function createExecutor({
  store,
  handlers = {},
  maxAttempts = 3,
  leaseMs = 30_000,
  retryKinds = (kind) => String(kind).startsWith('image.'),
  note = () => {},
} = {}) {
  // 串行化 tick：并发认领会让「刚 enqueue 就立即排水」拿不到结果
  let chain = Promise.resolve()

  async function runOnce(limit) {
    let done = 0
    for (let i = 0; i < limit; i += 1) {
      const effect = store.claim({ leaseMs })
      if (!effect) break
      const handler = handlers[effect.kind]
      try {
        if (typeof handler !== 'function') throw new Error('没有 handler：' + effect.kind)
        const result = await handler(effect)
        store.finish(effect.id, { status: 'done', result })
        done += 1
      } catch (error) {
        const message = String((error && error.message) || error)
        note(`执行层失败 ${effect.kind} ${effect.id}（第 ${effect.attempts} 次）：${message}`)
        // 非幂等动作不能自动重发；网络层不确定时只能进 unknown 等对账
        if (error && error.unknown) store.finish(effect.id, { status: 'unknown', error: message })
        else if (retryKinds(effect.kind) && Number(effect.attempts) < maxAttempts) store.retry(effect.id, message, { delayMs: 500 * Number(effect.attempts || 1) })
        else store.finish(effect.id, { status: 'failed', error: message })
      }
    }
    return done
  }

  function tick(limit = 4) {
    const next = chain.then(() => runOnce(limit))
    chain = next.catch(() => {})
    return next
  }

  let timer = null
  function start({ intervalMs = 5000 } = {}) {
    if (timer) return
    timer = setInterval(() => {
      tick().catch(() => {})
    }, Math.max(1000, Number(intervalMs) || 5000))
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop }
}

/** 图片入库：从 staging 文件读 bytes → imageLibrary.remember（内部按 sha 去重）。 */
export function createImageIngestHandler({ imageLibrary, note = () => {} } = {}) {
  return async (effect) => {
    const payload = effect.payload ? JSON.parse(effect.payload) : {}
    if (!payload.stagingFile) throw new Error('stagingFile 缺失')
    const bytes = fs.readFileSync(payload.stagingFile)
    const saved = imageLibrary.remember({ bytes, source: payload.source || {} })
    fs.rmSync(payload.stagingFile, { force: true })
    if (saved.ok) {
      return {
        id: saved.record.id,
        mediaType: saved.record.mediaType,
        animated: saved.record.animated,
      }
    }
    // not-image / too-large 是确定性结果，重试没有意义
    if (saved.reason === 'not-image' || saved.reason === 'too-large') return { skipped: saved.reason }
    throw new Error(saved.reason || 'remember failed')
  }
}

/** 纯文字发送：非幂等，只执行一次；网络层不确定时标 unknown。 */
function createSendHandler({ sendText } = {}) {
  return async (effect) => {
    if (typeof sendText !== 'function') throw new Error('sendText 未注入')
    const payload = effect.payload ? JSON.parse(effect.payload) : {}
    let result
    try {
      result = await sendText(payload)
    } catch (error) {
      // 请求可能已经到达桥但没拿到响应：无法确认，标 unknown，绝不自动重发
      if (!error?.definite) error.unknown = true
      throw error
    }
    if (!result || result.ok === false) {
      const error = new Error(`retcode=${result?.retcode ?? '?'}`)
      error.definite = true
      throw error
    }
    return { retcode: result.retcode ?? 0 }
  }
}

function stageBytes(dir, bytes) {  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`)
  fs.writeFileSync(file, bytes)
  return file
}

/**
 * 执行层门面：初始化存储、恢复未完成副作用、起定时排水。
 * node:sqlite 不可用时返回 null，调用方回退到直写。
 */
export function createExecLayer({ dir, imageLibrary, tickMs = 5000, maxAttempts = 3, sendText = null, note = () => {} } = {}) {
  if (!sqliteReady()) return null
  if (!dir) throw new Error('exec dir 缺失')
  if (!imageLibrary) throw new Error('imageLibrary 缺失')

  const root = path.resolve(dir)
  const store = openExecStore({ file: path.join(root, 'qq.db') })
  const stagingDir = path.join(root, 'staging')
  const executor = createExecutor({
    store,
    handlers: {
      'image.ingest': createImageIngestHandler({ imageLibrary, note }),
      'qq.send': createSendHandler({ sendText }),
    },
    maxAttempts,
    note,
  })

  const recovered = store.recover()
  if (recovered) note(`执行层恢复 ${recovered} 条未完成副作用`)
  const pruned = store.prune({ days: 30 })
  if (pruned) note(`执行层清理 ${pruned} 条已收敛记录`)

  /**
   * 等到某条 effect 进入终态：按 deadline 等，不按固定轮数。
   * 队列有积压时固定 3 轮会误报 queued，调用方会把它当成「没发出去 / 没入库」。
   */
  async function waitTerminal(idemKey, { timeoutMs = 8000 } = {}) {
    const terminal = ['done', 'failed', 'unknown']
    const deadline = Date.now() + timeoutMs
    let row = store.getByIdem(idemKey)
    while (row && !terminal.includes(row.status) && Date.now() < deadline) {
      await executor.tick(1)
      row = store.getByIdem(idemKey)
      if (row && terminal.includes(row.status)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return row
  }

  async function ingestImage({ bytes, source } = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, reason: 'empty' }
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    const idemKey = 'image:' + sha
    const staged = stageBytes(stagingDir, bytes)
    const { created, effect } = store.enqueue({
      kind: 'image.ingest',
      idemKey,
      payload: { stagingFile: staged, source: source || {} },
    })

    if (!created) {
      // 同一张图已经在队列里：用它的 staging，不重复占磁盘
      fs.rmSync(staged, { force: true })
      if (effect.status === 'done') {
        const result = effect.result ? JSON.parse(effect.result) : {}
        return { ok: true, id: result.id || null, mediaType: result.mediaType, animated: result.animated, deduped: true }
      }
      if (effect.status === 'failed') return { ok: false, reason: effect.last_error || 'failed' }
    }

    const row = await waitTerminal(idemKey)
    if (row && row.status === 'done') {
      const result = row.result ? JSON.parse(row.result) : {}
      return { ok: true, id: result.id || null, mediaType: result.mediaType, animated: result.animated, deduped: !created }
    }
    return { ok: false, queued: true, status: row?.status || 'unknown', reason: row?.last_error || 'queued' }
  }

  async function send({ kind, targetId, text } = {}) {
    if (typeof sendText !== 'function') return { ok: false, reason: 'sendText 未注入' }
    const idemKey = 'send:' + crypto.randomUUID()
    store.enqueue({ kind: 'qq.send', idemKey, payload: { kind, targetId, text } })
    const row = await waitTerminal(idemKey)
    if (!row) return { ok: false, reason: 'effect missing' }
    if (row.status === 'done') return { ok: true, retcode: row.result ? JSON.parse(row.result).retcode : 0 }
    if (row.status === 'unknown') return { ok: false, unknown: true, reason: row.last_error || 'unknown' }
    return { ok: false, status: row.status, reason: row.last_error || row.status }
  }

  /** 待对账列表（unknown）：人工判断「到底发出去没有」的证据。 */
  function listUnknown({ limit = 20 } = {}) {
    return store.listByStatus('unknown', limit).map((row) => {
      let payload = {}
      try {
        payload = row.payload ? JSON.parse(row.payload) : {}
      } catch {
        payload = {}
      }
      return {
        id: row.id,
        effectKind: row.kind,
        channel: payload.kind || '',
        targetId: payload.targetId || '',
        text: payload.text || '',
        attempts: Number(row.attempts) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastError: row.last_error,
      }
    })
  }

  /** 人工裁定：decision=sent（已发出）| not-sent（没发出）。unknown 永不自动重发。 */
  function reconcile(id, decision) {
    const status = decision === 'sent' ? 'done' : decision === 'not-sent' ? 'failed' : null
    if (!status) return { ok: false, reason: 'decision 只能是 sent 或 not-sent' }
    return store.resolve(id, { status })
  }

  executor.start({ intervalMs: tickMs })

  return {
    file: store.file,
    ingestImage,
    send,
    drain: (limit = 4) => executor.tick(limit),
    stats: () => store.stats(),
    listUnknown,
    reconcile,
    recover: () => store.recover(),
    close: () => {
      executor.stop()
      store.close()
    },
    store,
  }
}
