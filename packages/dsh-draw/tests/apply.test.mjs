/** apply 层 suite：用假 ctx 跑 index.js，确认工具注册与禁用开关的行为。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 造一个最小 ctx：tools 立即可用，effect 立即执行，provide 记账。 */
function fakeCtx() {
  const registered = []
  const provided = {}
  const declared = []
  let effectRun = false
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          register(def) {
            registered.push(def)
            return { dispose() {} }
          },
        }
      }
      if (name === 'self') return { declare: (d) => declared.push(d) }
      return undefined
    },
    effect(fn) {
      effectRun = true
      return fn()
    },
    provide(name, value) {
      provided[name] = value
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, registered, provided, declared, effectRan: () => effectRun }
}

export async function run() {
  const cases = []
  const check = (name, ok, extra) => cases.push({ name, ok: !!ok, extra: extra ? String(extra).slice(0, 240) : '' })

  // 1. 正常加载
  {
    const { ctx, registered, provided, declared, effectRan } = fakeCtx()
    const api = apply(ctx)
    check('apply 返回 api', Boolean(api && api.id === 'draw'), JSON.stringify(api)?.slice(0, 120))
    check('注册了 2 个工具', registered.length === 2, `实际 ${registered.length}`)
    const names = registered.map((d) => d.name).sort()
    check('工具名是 draw_card / draw_chart', names.join(',') === 'draw_card,draw_chart', names.join(','))
    check('每个工具都有 execute', registered.every((d) => typeof d.execute === 'function'))
    check('每个工具都有 parameters', registered.every((d) => d.parameters && d.parameters.type === 'object'))
    check('走了 ctx.effect 托管', effectRan())
    check('注册了 draw 服务', Boolean(provided.draw))
    check('声明了 capability', declared.length === 1 && declared[0].id === 'draw', JSON.stringify(declared[0])?.slice(0, 160))
    check('capability 带 limits', Array.isArray(declared[0]?.limits) && declared[0].limits.length > 0)
    check('api 能报告 python 来源', typeof api.python === 'function' && typeof api.python().from === 'string')
  }

  // 2. 禁用开关：config.enabled=false 时不注册
  {
    const cfgFile = path.join(path.dirname(HERE), 'config.json')
    const backup = fs.readFileSync(cfgFile, 'utf8')
    try {
      fs.writeFileSync(cfgFile, JSON.stringify({ enabled: false, outputDir: '', pythonPath: '' }), 'utf8')
      const { ctx, registered } = fakeCtx()
      const api = apply(ctx)
      check('enabled=false 时不注册工具', registered.length === 0, `实际 ${registered.length}`)
      check('enabled=false 时返回 enabled:false', api?.enabled === false, JSON.stringify(api))
    } finally {
      fs.writeFileSync(cfgFile, backup, 'utf8')
    }
  }

  const failed = cases.filter((c) => !c.ok).length
  return { suite: 'apply', total: cases.length, failed, cases }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run()
  for (const c of r.cases) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ' — ' + c.extra}`)
  console.log(`${r.total - r.failed}/${r.total} 通过`)
  process.exit(r.failed === 0 ? 0 : 1)
}
