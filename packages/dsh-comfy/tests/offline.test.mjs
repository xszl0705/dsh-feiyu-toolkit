/** 离线路径 suite：服务不在时每个工具都要给出明确原因，而不是静默失败。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTools } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '_out')

// 故意指向一个没人监听的端口，保证离线路径可稳定复现
const DEAD = 'http://127.0.0.1:59999'

export async function run() {
  fs.mkdirSync(OUT, { recursive: true })
  const cases = []
  const check = (name, ok, extra) => cases.push({ name, ok: !!ok, extra: extra ? String(extra).slice(0, 200) : '' })

  const tools = createTools({
    baseUrl: DEAD,
    outputDir: OUT,
    comfyOutputDir: OUT,
    comfyInputDir: OUT,
    defaultCheckpoint: 'anything-v5-PrtRE.safetensors',
  })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  check('只有一个工具 comfy', tools.length === 1 && Boolean(byName.comfy), `实际 ${tools.length}`)

  // 1. status 对服务不在的场景应回 up:false，而不是抛错
  const st = await byName.comfy.execute({ action: 'status' })
  check('status 服务不在时 up=false', st.up === false, JSON.stringify(st))
  check('status 带错误原因', typeof st.error === 'string' && st.error.length > 0, st.error)
  const rendered = byName.comfy.output.render({ action: 'status' }, st)
  check('status render 提示手动启动', /未启动/.test(rendered[0].text) && /手动启动/.test(rendered[0].text), rendered[0].text.slice(0, 120))

  // 2. generate 应回 OFFLINE
  const g = await byName.comfy.execute({ action: 'generate', prompt: '1girl, solo' })
  check('generate 服务不在时 OFFLINE', g.ok === false && g.reason === 'OFFLINE', JSON.stringify(g))

  // 3. controlnet：参考图不存在 -> BAD_INPUT（先于连服务）
  const c1 = await byName.comfy.execute({ action: 'controlnet', imagePath: path.join(OUT, '不存在.png'), prompt: 'x' })
  check('controlnet 参考图缺失时 BAD_INPUT', c1.ok === false && c1.reason === 'BAD_INPUT', JSON.stringify(c1))

  // 4. controlnet：参考图存在但服务不在 -> OFFLINE
  const refFile = path.join(OUT, 'ref.png')
  fs.writeFileSync(refFile, Buffer.from('89504e470d0a1a0a', 'hex'))
  const c2 = await byName.comfy.execute({ action: 'controlnet', imagePath: refFile, prompt: 'x' })
  check('controlnet 服务不在时 OFFLINE', c2.ok === false && c2.reason === 'OFFLINE', JSON.stringify(c2))

  // 5. 没配 comfyOutputDir -> NOT_CONFIGURED（且不尝试联网）
  const bare = Object.fromEntries(
    createTools({ baseUrl: DEAD, outputDir: OUT }).map((t) => [t.name, t]),
  )
  const c3 = await bare.comfy.execute({ action: 'generate', prompt: 'x' })
  check('未配目录时 NOT_CONFIGURED', c3.ok === false && c3.reason === 'NOT_CONFIGURED', JSON.stringify(c3))

  // 6. render 在失败时给出人话
  const r = byName.comfy.output.render({ action: 'generate' }, g)
  check('generate render 提到手动启动', /手动启动/.test(r[0].text), r[0].text.slice(0, 120))

  const failed = cases.filter((c) => !c.ok).length
  return { suite: 'offline', total: cases.length, failed, cases }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run()
  for (const c of r.cases) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ' — ' + c.extra}`)
  console.log(`${r.total - r.failed}/${r.total} 通过`)
  process.exit(r.failed === 0 ? 0 : 1)
}
