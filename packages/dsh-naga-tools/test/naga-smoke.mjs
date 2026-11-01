/**
 * dsh-naga-tools smoke test（不依赖 DSH）。
 * 只测"读"能力：列应用、模糊匹配、天气解析。
 * 系统控制会锁屏/关屏，测试里绝不执行。
 */
import { createNagaTools } from '../lib/naga.js'

const [naga] = createNagaTools()

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('ok  -', msg)
}

assert(naga.name === 'naga', 'tool name: naga')
assert(naga.parameters.properties.action.enum.includes('lock'), 'naga action enum covers the whitelist')

const listed = await naga.execute({ action: 'list', limit: 10 })
assert(Array.isArray(listed.apps) && listed.apps.length > 0, `shortcut index non-empty (${listed.apps?.length ?? 0} shown)`)
console.log('    sample:', listed.apps.slice(0, 5).map((a) => a.name).join('、'))

const miss = await naga.execute({ action: 'open', query: '这个应用肯定不存在-xyz' })
assert(Boolean(miss.error), 'unknown app returns error, not a crash')

const wx = await naga.execute({ action: 'weather' })
assert(typeof wx.time === 'string' && wx.time.length > 4, 'weather_time returns local time')
console.log('    time:', wx.time, '| city:', wx.city || '-', '| weather:', wx.weather || wx.error || '-')

if (wx.error) {
  console.log('    (weather network failed, but the tool returned a structured error instead of throwing)')
} else {
  assert(Boolean(wx.temperature), 'weather returns temperature when network works')
}

console.log('\nall naga-tools checks passed')
