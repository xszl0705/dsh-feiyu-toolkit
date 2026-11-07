// Each installed package owns its context instances; no process-wide ready flag.
const instances = new WeakMap()
export function lifecycle(ctx, create = () => ({})) {
  if (instances.has(ctx)) return instances.get(ctx)
  const controller = new AbortController()
  const timers = new Set(), cleanups = []
  const st = Object.assign(create(), {
    disposed: false, signal: controller.signal,
    own(handle) { if (handle) cleanups.push(handle); return handle },
    later(fn, delay) {
      if (st.disposed) return
      const timer = setTimeout(() => { timers.delete(timer); if (!st.disposed) fn() }, delay)
      timers.add(timer)
      return timer
    },
    dispose() {
      if (st.disposed) return
      st.disposed = true
      controller.abort(new Error('PLUGIN_DISPOSED'))
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const handle of cleanups.reverse()) {
        try {
          const result = typeof handle === 'function' ? handle() : handle.dispose?.()
          Promise.resolve(result).catch(() => {})
        } catch { /* release the remaining resources */ }
      }
      instances.delete(ctx)
    },
  })
  instances.set(ctx, st)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => st.dispose())
  return st
}
