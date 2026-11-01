/**
 * 在线链路 live 测试：需要 ComfyUI 已经跑在 config.json 的 baseUrl 上。
 * 单独执行：node tests/live.mjs
 * 不在 run-all 里，因为它依赖外部服务的生命周期（那归用户）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTools } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '_out', 'live')
const cfgFile = path.join(path.dirname(HERE), 'config.json')

const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
const cases = []
const check = (name, ok, extra) => cases.push({ name, ok: !!ok, extra: extra ? String(extra).slice(0, 240) : '' })

fs.mkdirSync(OUT, { recursive: true })
const tools = Object.fromEntries(createTools({ ...config, outputDir: OUT }).map((t) => [t.name, t]))

// 1. 服务在不在
const st = await tools.comfy.execute({ action: 'status' })
console.log('status:', JSON.stringify(st).slice(0, 300))
check('ComfyUI 在跑', st.up === true, st.error)
check('能看到底模', (st.checkpoints || []).length > 0, JSON.stringify(st.checkpoints))
check('能看到 ControlNet', (st.controlnets || []).length > 0, `${(st.controlnets || []).length} 个`)

if (!st.up) {
  console.log('\n服务没起，live 测试到此为止。先手动启动 ComfyUI（见 docs/绘图落地实施方案-2026-11-01.md 第 3.3 节）。')
  process.exit(1)
}

// 2. 文生图
const g = await tools.comfy.execute({
  action: 'generate',
  prompt: '1girl, solo, blue hair, hoodie, smile, upper body, masterpiece, best quality',
  negative: 'lowres, bad anatomy, worst quality',
  width: 512, height: 768, steps: 20, seed: 20261101,
})
console.log('generate:', JSON.stringify(g).slice(0, 260))
check('文生图成功', g.ok === true, g.error)
check('文生图落盘', g.ok && fs.existsSync(g.path))
check('文生图耗时合理', g.ok && g.elapsedMs > 0, `${g.elapsedMs}ms`)

// 3. ControlNet（用上一步的图当参考）
if (g.ok) {
  const c = await tools.comfy.execute({
    action: 'controlnet',
    imagePath: g.path,
    prompt: '1girl, solo, blue hair, white hoodie, smile, upper body, masterpiece',
    strength: 0.8,
    width: 512, height: 768, steps: 20, seed: 20261102,
  })
  console.log('controlnet:', JSON.stringify(c).slice(0, 260))
  check('ControlNet 成功', c.ok === true, c.error)
  check('ControlNet 落盘', c.ok && fs.existsSync(c.path))
  if (c.ok) {
    const a = fs.statSync(g.path).size
    const b = fs.statSync(c.path).size
    check('两次输出不是同一个文件', g.path !== c.path, `${a} vs ${b} 字节`)
  }
}

const failed = cases.filter((x) => !x.ok).length
const result = { suite: 'live', total: cases.length, failed, cases, at: new Date().toISOString() }
fs.writeFileSync(path.join(HERE, '_out', 'live-result.json'), JSON.stringify(result, null, 2), 'utf8')
for (const c of cases) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ' — ' + c.extra}`)
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
