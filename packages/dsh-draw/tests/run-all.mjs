/** 汇总跑全部 suite，结果落 tests/_out/result.json。allOk=true 才算过。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '_out')

const suites = []
const errors = []

for (const file of ['smoke-bridge.mjs', 'tools.test.mjs', 'apply.test.mjs']) {
  try {
    const mod = await import(pathToFileURL(path.join(HERE, file)).href)
    const result = await mod.run()
    suites.push(result)
    console.log(`\n== ${result.suite} ==  ${result.total - result.failed}/${result.total}`)
    for (const c of result.cases) {
      console.log(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.ok || !c.extra ? '' : ' — ' + c.extra}`)
    }
  } catch (error) {
    errors.push({ file, error: String(error?.message || error) })
    console.log(`\n== ${file} 崩了 ==  ${error?.message || error}`)
  }
}

const total = suites.reduce((n, s) => n + s.total, 0)
const failed = suites.reduce((n, s) => n + s.failed, 0)
const allOk = errors.length === 0 && failed === 0 && suites.length === 3

const payload = {
  at: new Date().toISOString(),
  allOk,
  total,
  failed,
  errors,
  suites,
}

fs.mkdirSync(OUT, { recursive: true })
const outFile = path.join(OUT, 'result.json')
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8')

console.log(`\n${allOk ? 'ALL OK' : 'FAILED'}  ${total - failed}/${total} 通过，结果写入 ${outFile}`)
process.exit(allOk ? 0 : 1)
