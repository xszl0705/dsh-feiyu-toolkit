/**
 * 原子写：临时文件 → fsync → rename。
 *
 * 崩溃或断电时，磁盘上要么是旧文件、要么是新文件，不会留下半截 JSON。
 * 只用于状态文件；追加日志（jsonl）不走这里。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function fsyncDir(dir) {
  // Windows 上打开目录会失败，忽略；POSIX 上让 rename 落盘
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // 平台不支持就跳过
  }
}

export function atomicWrite(file, data, encoding = 'utf8') {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  let fd
  try {
    fd = fs.openSync(tmp, 'wx')
    fs.writeFileSync(fd, data, encoding)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      if (fd !== undefined) fs.closeSync(fd)
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
    throw error
  }
  fsyncDir(dir)
  return file
}

export function atomicWriteJson(file, value, indent = 2) {
  return atomicWrite(file, JSON.stringify(value, null, indent))
}
