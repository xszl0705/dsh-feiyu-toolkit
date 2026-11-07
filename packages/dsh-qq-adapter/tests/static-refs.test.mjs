/**
 * 静态引用检查：index.js / lib/pipeline.js 里调用的函数，必须在本文件定义或 import。
 *
 * 2026-11-04 为什么加：2.1 拆 index 时漏搬了 pushHistory / connect / visionService /
 * autostartService，四个都是「运行时才炸」——单测全绿，重启后 apply 直接抛错、QQ 起不来。
 * 这里用正则做粗筛，误报用白名单排除（内置对象、get 访问器、函数参数名）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const FILES = ['index.js', 'lib/pipeline.js']

const BUILTINS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await',
  'void', 'delete', 'instanceof', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw',
  'case', 'break', 'continue', 'yield', 'super', 'import', 'export', 'async', 'class',
  'const', 'let', 'var', 'Boolean', 'Number', 'String', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'Promise', 'Map', 'Set', 'Symbol', 'RegExp', 'Error', 'TypeError', 'parseInt',
  'parseFloat', 'isNaN', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'globalThis', 'process', 'console', 'decodeURIComponent', 'encodeURIComponent',
  'WebSocket',
])

function extractParams(src) {
  const names = new Set()
  // function 声明：从名字后的 '(' 开始做括号配对（参数默认值里可能带 Date.now()）
  for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$]*\s*\(/g)) {
    let i = m.index + m[0].length
    const start = i
    let depth = 1
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') depth -= 1
      i += 1
    }
    for (const n of src.slice(start, i - 1).matchAll(/[A-Za-z_$][\w$]*/g)) names.add(n[0])
  }
  // 箭头函数参数（一般没有嵌套括号）
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(n[0])
  }
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1])
  return names
}

function collect(src) {
  const imported = new Set()
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]/g)) {
    const spec = m[1]
    const def = spec.match(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/)
    if (def) imported.add(def[1])
    const named = spec.match(/\{([^}]*)\}/)
    if (named) {
      for (const n of named[1].split(',')) {
        const t = n.trim().split(/\s+as\s+/).pop()
        if (t && /^[A-Za-z_$][\w$]*$/.test(t)) imported.add(t)
      }
    }
  }

  const defined = new Set()
  for (const m of src.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
  for (const n of extractParams(src)) defined.add(n)
  // get 访问器：`get memory() {`
  for (const m of src.matchAll(/\bget\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1])

  const calls = new Set()
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1])

  return [...calls].filter((n) => !defined.has(n) && !imported.has(n) && !BUILTINS.has(n))
}

for (const rel of FILES) {
  test(`${rel} 没有未定义调用`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const undef = collect(src)
    assert.deepEqual(undef, [], `疑似未定义调用：${undef.join(', ')}（若为误报，加到 BUILTINS 或让命名可被识别）`)
  })
}
