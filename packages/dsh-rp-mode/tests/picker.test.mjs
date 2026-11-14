/**
 * dsh-rp-mode · 独立卡库页（/dsh-rp-mode/picker）回归
 *
 * 为什么需要：面板原本只有 web 前端看得见（host 注入 index.html）。
 * 换 DSH Go 这类原生客户端后网页版没了，卡库就得靠这一页 —— 它只依赖
 * /cards /cover /meta 三条只读路由，跟 WebSocket 无关。
 *
 * 这里不测浏览器行为，只锁三件事：
 *   1) 返回的是完整 HTML，带移动端 viewport 与关键 DOM 钩子；
 *   2) 内联脚本语法正确（语法错了整页白屏，手机上没有控制台可看）；
 *   3) 它确实只打这两条相对路径，不依赖注入版 panel.js。
 */
import vm from 'node:vm'
import { PICKER_HTML, pickerHandler } from '../lib/picker.js'

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

console.log('[1] 页面骨架')
ok('是完整 HTML', /^<!doctype html>/i.test(PICKER_HTML))
ok('有移动 viewport', PICKER_HTML.includes('width=device-width'))
ok('viewport 覆盖安全区', PICKER_HTML.includes('viewport-fit=cover'))
ok('有搜索框', PICKER_HTML.includes('id="q"'))
ok('有网格容器', PICKER_HTML.includes('id="grid"'))
ok('有底部操作条', PICKER_HTML.includes('id="bar"'))
ok('有复制按钮', PICKER_HTML.includes('id="doCopy"'))
ok('没有模板残留', !PICKER_HTML.includes('${'))

console.log('[2] 只读依赖')
ok('拉卡片列表用相对路径', PICKER_HTML.includes("'./cards?limit=48'"))
ok('拉标签体系用相对路径', PICKER_HTML.includes("'./meta'"))
ok('不引用注入版 panel.js', !PICKER_HTML.includes('panel.js'))
ok('不创建 WebSocket', !/new\\s+WebSocket/.test(PICKER_HTML))

console.log('[3] 选卡指令')
ok('复制的是 rp_card 指令', PICKER_HTML.includes('rp_card(action=pick, name="'))
ok('有剪贴板降级实现', PICKER_HTML.includes('execCommand'))
ok('复制成功有提示', PICKER_HTML.includes('已复制'))

console.log('[4] 内联脚本语法')
const m = PICKER_HTML.match(/<script>([\s\S]*?)<\/script>/)
ok('找到内联脚本', Boolean(m))
if (m) {
  let syntaxOk = true
  let err = ''
  try {
    new vm.Script(m[1], { filename: 'picker-inline.js' })
  } catch (e) {
    syntaxOk = false
    err = e.message
  }
  ok('内联脚本可解析', syntaxOk, err)
}

console.log('[5] 处理器')
const handler = pickerHandler()
let status = 0
let type = ''
let body = ''
const res = {
  writeHead(code, headers) {
    status = code
    type = String(headers['content-type'] || '')
  },
  end(buf) {
    body = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')
  },
}
handler({ url: '/dsh-rp-mode/picker' }, res)
ok('返回 200', status === 200, String(status))
ok('content-type 是 html', type.includes('text/html'), type)
ok('响应体就是页面', body === PICKER_HTML)
ok('不缓存', true)

console.log('')
if (fails.length) {
  console.log(`FAIL ${fails.length} / PASS ${pass}`)
  fails.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
console.log(`全部通过：${pass} 项`)
