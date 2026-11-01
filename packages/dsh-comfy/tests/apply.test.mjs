/** apply 层 suite：用假 ctx 跑 index.js，确认注册与禁用开关。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

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

  {
    const { ctx, registered, provided, declared, effectRan } = fakeCtx()
    const api = apply(ctx)
    check('apply 返回 api', Boolean(api && api.id === 'comfy'), JSON.stringify(api)?.slice(0, 120))
    check('注册了 1 个工具', registered.length === 1, `实际 ${registered.length}`)
    const names = registered.map((d) => d.name).sort().join(',')
    check('工具名是 comfy', names === 'comfy', names)
    check('每个工具都有 execute', registered.every((d) => typeof d.execute === 'function'))
    check('每个工具都有 parameters', registered.every((d) => d.parameters && d.parameters.type === 'object'))
    check('走了 ctx.effect 托管', effectRan())
    check('注册了 comfy 服务', Boolean(provided.comfy))
    check('声明的 id 是 comfy', declared.length === 1 && declared[0].id === 'comfy', JSON.stringify(declared[0])?.slice(0, 160))
    check('capability 明确「不负责启动服务」', (declared[0]?.limits || []).some((l) => /不负责启动/.test(l)), JSON.stringify(declared[0]?.limits))
    check('api 能报 baseUrl', typeof api.baseUrl === 'string' && api.baseUrl.includes('127.0.0.1'))
  }

  {
    const cfgFile = path.join(path.dirname(HERE), 'config.json')
    const backup = fs.readFileSync(cfgFile, 'utf8')
    try {
      fs.writeFileSync(cfgFile, JSON.stringify({ enabled: false }), 'utf8')
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
