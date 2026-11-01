/**
 * dsh-dafeiyu-core — 单一身份来源
 *
 * 文件布局（默认 ~/.dsh/dafeiyu/core，可用 config.dir 覆盖）：
 *   persona.md   我是谁（唯一一份；所有渠道都读它）
 *   voice.json   怎么说（分渠道的长度/语气/媒介约束）
 *
 * 编译产物（~/.dsh/dafeiyu/compiled）：
 *   pet.template.txt   桌宠用的模板，{{scene}}/{{away}}/{{mood}}/{{memory}} 由调用方填
 *   client.identity.txt 客户端注入用的身份段
 *   manifest.json      persona 的 sha256 + 编译时间，用于一致性核对
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_STRENGTH = 0.9

export function dafeiyuHome() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dafeiyu')
}

export function coreDir(config = {}) {
  return config.dir ? path.resolve(String(config.dir)) : path.join(dafeiyuHome(), 'core')
}

export function compiledDir() {
  return path.join(dafeiyuHome(), 'compiled')
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function copyIfMissing(from, to) {
  if (fs.existsSync(to)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return true
}

/** 首次运行：把 assets 里的默认 persona/voice 落到数据目录（不覆盖已有）。 */
export function ensureDefaults(dir, pluginRoot) {
  const assets = path.join(pluginRoot, 'assets')
  const personaFile = path.join(dir, 'persona.md')
  const voiceFile = path.join(dir, 'voice.json')
  const created = []
  if (copyIfMissing(path.join(assets, 'persona.default.md'), personaFile)) created.push(personaFile)
  if (copyIfMissing(path.join(assets, 'voice.default.json'), voiceFile)) created.push(voiceFile)
  return { personaFile, voiceFile, created }
}

/** 读主体：persona 原文 + 解析后的 voice。文件缺失时回退到 assets 默认值。 */
export function loadCore(dir, pluginRoot) {
  ensureDefaults(dir, pluginRoot)
  const assets = path.join(pluginRoot, 'assets')
  const persona =
    readText(path.join(dir, 'persona.md')) || readText(path.join(assets, 'persona.default.md'))
  let voice
  try {
    voice = JSON.parse(readText(path.join(dir, 'voice.json'), readText(path.join(assets, 'voice.default.json'), '{}')))
  } catch {
    voice = { strength: DEFAULT_STRENGTH, channels: {} }
  }
  if (!voice.channels) voice.channels = {}
  if (typeof voice.strength !== 'number') voice.strength = DEFAULT_STRENGTH
  return { persona: persona.trim(), voice }
}

export function personaHash(persona) {
  return crypto.createHash('sha256').update(String(persona)).digest('hex')
}
