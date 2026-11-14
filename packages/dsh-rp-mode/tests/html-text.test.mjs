/**
 * HTML → 纯文本单测（角色卡状态栏清洗）。
 * 跑法：node tests/html-text.test.mjs
 */
import { htmlToText, hasHtmlTags } from '../lib/html-text.js'

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

/* 1. 普通文本不动 */
ok('纯文本原样', htmlToText('窗外在下雨。') === '窗外在下雨。')
ok('含比较符不动', htmlToText('a < b 且 c > d') === 'a < b 且 c > d')
ok('空值返回空串', htmlToText(null) === '' && htmlToText(undefined) === '')
ok('无标签不误判', hasHtmlTags('她说 < 然后笑了') === false)

/* 2. 换行与块级 */
ok('<br> 转换行', htmlToText('第一行<br>第二行').includes('第一行\n第二行'))
ok('</p> 转换行', /行1\n+行2/.test(htmlToText('<p>行1</p><p>行2</p>')))
ok('<hr> 转分隔线', htmlToText('上<hr>下').includes('---'))

/* 3. 列表 */
{
  const out = htmlToText('<ul><li><strong>处境:</strong> 顶层办公室</li><li><strong>状态:</strong> 慵懒</li></ul>')
  ok('li 变 - 列表项', out.includes('- '), out)
  ok('li 数量正确', (out.match(/- /g) || []).length === 2, out)
  ok('strong 变粗体', out.includes('**处境:**'), out)
}

/* 4. details 折叠外壳（就是用户截图里那整段） */
{
  const raw =
    '<details><summary>👤 你的状态面板 / 📍 在场其他人物（点击展开/折叠）</summary>' +
    '<div style="background-color:#1A1A1A; color:#D0D0D0; padding:15px; border-radius:5px;">' +
    '<p style="margin: 5px 0;"><strong>[你]</strong></p>' +
    '<ul style="list-style-type: square; color: #ADFF2F;"><li><strong>处境:</strong> 顶层办公室，七分钟倒计时。</li></ul>' +
    '</div></details>'
  const out = htmlToText(raw)
  ok('details 外壳剥掉', !/<\/?(details|summary|div|ul|li|p)\b/i.test(out), out)
  ok('summary 标题保留', out.includes('状态面板'), out)
  ok('正文保留', out.includes('顶层办公室，七分钟倒计时'), out)
  ok('无内联样式残留', !/style=|#ADFF2F|border-radius/.test(out), out)
  ok('hasHtmlTags 判定命中', hasHtmlTags(raw) === true)
}

/* 5. 实体 */
{
  const out = htmlToText('<p>&lt;低语&gt; 他说&nbsp;&amp;笑了</p>')
  ok('实体解码', out.includes('<低语>') && out.includes('&') && !out.includes('&nbsp;'), out)
  ok('数字实体解码', htmlToText('<p>&#20320;好</p>').includes('你'))
}

/* 6. 幂等 + 异常输入 */
{
  const once = htmlToText('<div><p>甲</p><p>乙</p></div>')
  ok('幂等', htmlToText(once) === once, JSON.stringify([once, htmlToText(once)]))
  ok('无闭合标签不炸', htmlToText('<div><p>残缺').includes('残缺'))
  ok('img 丢弃', !htmlToText('<p>前<img src="x.png">后</p>').includes('img'))
}

/* 7. 空壳折叠块不产生垃圾 */
{
  const out = htmlToText('<details><summary>空</summary></details>')
  ok('空块只剩标题', out.trim().replace(/\*/g, '') === '空', JSON.stringify(out))
  ok('没有连续三个换行', !/\n{3,}/.test(htmlToText('<p>a</p><p></p><p></p><p>b</p>')))
}

/* 8. clip() 截断出来的残缺标签（cast 时真的会留这种尾巴） */
{
  const truncated = '正文一段。\n <p style="margi…'
  const out = htmlToText(truncated)
  ok('残缺开标签被清掉', !out.includes('<p'), JSON.stringify(out))
  ok('正文保留', out.includes('正文一段'), JSON.stringify(out))
  ok('比较符仍不误伤', htmlToText('他说 a < b 就好了') === '他说 a < b 就好了')
  ok('summary 标题与正文不粘连', /\*\*标题\*\*\n/.test(htmlToText('<details><summary>标题</summary><p>正文</p></details>')), JSON.stringify(htmlToText('<details><summary>标题</summary><p>正文</p></details>')))
  ok('正常加粗后接空格不插换行', !htmlToText('<li><strong>处境:</strong> 办公室</li>').includes('**\n'))
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(' - ' + f)
  process.exitCode = 1
}
