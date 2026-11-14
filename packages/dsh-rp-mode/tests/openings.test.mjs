/**
 * 卡自带开场：占位符替换 + 开场清单。
 * 跑法：node tests/openings.test.mjs
 */
import { fillPlaceholders, openingsOf } from '../lib/card.js'

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fails.push(name + (extra ? ' :: ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

/* 1. 占位符替换 */
{
  const card = { name: '莉安娜·魅夜' }
  ok('{{user}} → 你', fillPlaceholders('{{user}}推开门。', card) === '你推开门。')
  ok('{{char}} → 卡名', fillPlaceholders('{{char}}抬起头。', card) === '莉安娜·魅夜抬起头。')
  ok('<user> / <char> 同样替换', fillPlaceholders('<user>看着<char>', card) === '你看着莉安娜·魅夜')
  ok('大小写与空格容错', fillPlaceholders('{{ USER }} 和 {{ Char }}', card) === '你 和 莉安娜·魅夜')
  ok('没卡名时退成「角色」', fillPlaceholders('{{char}}', {}) === '角色')
  ok('纯文本原样', fillPlaceholders('窗外在下雨。', card) === '窗外在下雨。')
  ok('空值返回空串', fillPlaceholders(null, card) === '')
}

/* 2. 开场清单 */
{
  const card = {
    name: '莉安娜',
    firstMes: '{{user}}推开门，{{char}}抬起头。',
    alternateGreetings: ['雨夜里的一条短信。', '   ', '第三条：{{char}}在等你。'],
  }
  const list = openingsOf(card)
  ok('共 3 个开场（空白备选被过滤）', list.length === 3, String(list.length))
  ok('第 1 个是 first_mes', list[0].tag === 'first_mes')
  ok('first_mes 已替换占位符', list[0].text === '你推开门，莉安娜抬起头。', list[0].text)
  ok('备选保留原序号（跳空的显示备选3）', list[2].tag === '备选3', list[2].tag)
  ok('备选也替换占位符', list[2].text.includes('莉安娜在等你'), list[2].text)
}

/* 3. 边界 */
{
  ok('没有开场 → 空数组', openingsOf({ name: 'x' }).length === 0)
  ok('只有备选也能成清单', openingsOf({ name: 'x', alternateGreetings: ['只有备选'] })[0].tag === '备选1')
  ok('全是空白 → 空数组', openingsOf({ name: 'x', firstMes: '   ', alternateGreetings: ['  ', ''] }).length === 0)
  ok('空卡对象不炸', openingsOf(null).length === 0 && openingsOf(undefined).length === 0)
  const trimmed = openingsOf({ name: 'x', firstMes: '  有内容  ' })
  ok('首尾空白被裁掉', trimmed[0].text === '有内容', JSON.stringify(trimmed[0].text))
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(' - ' + f)
  process.exitCode = 1
}
