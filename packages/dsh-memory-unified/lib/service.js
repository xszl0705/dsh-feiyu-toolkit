/**
 * 记忆服务：把 store 暴露成一个进程内共享对象。
 *
 * 优先注册成 DSH 服务（ctx.provide / ctx.set），拿不到宿主 API 时
 * 退回到 globalThis 上的稳定 symbol——效果一样，QQ/桌宠都能查同一份记忆。
 */

export const SERVICE_KEY = Symbol.for('dsh-memory-unified.service')

export function installMemoryService(ctx, api) {
  globalThis[SERVICE_KEY] = api
  for (const name of ['memory', 'dsh-memory']) {
    try {
      if (typeof ctx?.provide === 'function') ctx.provide(name, api)
    } catch {
      // 宿主不支持就跳过
    }
    try {
      if (typeof ctx?.set === 'function') ctx.set(name, api)
    } catch {
      // 同上
    }
  }
  return api
}

export function getMemoryService(ctx) {
  try {
    const service = ctx?.get?.('memory')
    if (service && typeof service.search === 'function') return service
  } catch {
    // ignore
  }
  return globalThis[SERVICE_KEY] || null
}

export function memoryServiceFromGlobal() {
  return globalThis[SERVICE_KEY] || null
}
