/**
 * 等宿主 tools 服务就绪：先取一次，取不到就排一次重试（默认 250ms、最多 120 秒）。
 *
 * 原来 screenshot / memory-unified / qq-adapter 各写一份，字段名和超时文案都不同。
 * 统一后调用方只剩三行：
 *
 *   const tools = toolsOrRetry(ctx, st, () => applyInner(ctx), { warn, log })
 *   if (!tools) return
 *
 * st 需要是 lifecycle 状态（提供 later）——重试排在插件自己的生命周期里，卸载即停。
 *
 * 超时从 60 秒提到 120 秒（2026-11-04）：screenshot 的 load.log 里累积 39 次
 * 「61s 内没等到 tools 服务」，宿主冷启动时工具服务实打实会晚到一分钟以上。
 */

export function toolsOrRetry(ctx, st, retry, { timeout = 120000, interval = 250, warn, log } = {}) {
  const tools = ctx.get?.('tools')
  if (tools && typeof tools.register === 'function') {
    st._toolsSince = undefined
    return tools
  }
  if (!st._toolsSince) st._toolsSince = Date.now()
  if (st._toolsWaiting) return null
  if (Date.now() - st._toolsSince < timeout) {
    st._toolsWaiting = true
    st.later(() => {
      st._toolsWaiting = false
      try {
        retry()
      } catch (error) {
        if (log) log('重试注册失败：' + String((error && error.message) || error))
      }
    }, interval)
  } else if (warn) {
    warn(Math.round((Date.now() - st._toolsSince) / 1000))
  }
  return null
}
