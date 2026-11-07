/**
 * load.log 追加：一行 "ISO 时间  消息"，失败静默。
 *
 * 各插件的 note(message) 只是薄包装：
 *   function note(message) { kitNote(HERE, message) }
 * 默认写 <dir>/load.log；需要子目录或自定义文件名时传 opts。
 */
import fs from 'node:fs'
import path from 'node:path'

export function note(dir, message, { file = 'load.log', mkdir = false } = {}) {
  try {
    if (mkdir) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, file), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了不影响功能
  }
}
