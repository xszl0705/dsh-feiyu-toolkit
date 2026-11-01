import { lifecycle } from './lib/lifecycle.js'
/**
 * dsh-dafeiyu-core — 主入口
 *
 * 做三件事：
 *   1. 首次运行把默认 persona.md / voice.json 落到 ~/.dsh/dafeiyu/core
 *   2. 编译出各渠道的模板（compiled/pet.template.txt、client.identity.txt、manifest.json）
 *   3. 客户端侧挂一段 systemPrompt，让对话里也是同一份人格
 *
 * 不注册工具、不改宿主行为；persona.md 改动会在下次读取时自动重编译。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClientIdentity, buildPetTemplate, buildSystem } from './lib/compose.js'
import { compiledDir, coreDir, ensureDefaults, loadCore, personaHash } from './lib/persona.js'

export const name = 'dsh-dafeiyu-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  dir: '',
  clientHintOrder: 55,
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function note(message) {
  try {
    fs.appendFileSync(path.join(HERE, 'load.log'), new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch {
    // 日志写不了也不能影响加载
  }
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // ignore
  }
}

const STATE_KEY = Symbol.for('dsh-dafeiyu-core.state')

function state(ctx) { return lifecycle(ctx, () => ({ ready: false })) }

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = String((error && error.message) || error)
    safeLog(ctx, 'warn', 'dsh-dafeiyu-core 加载失败：' + message)
    note('apply 抛错：' + message)
    return undefined
  }
}

function applyInner(ctx) {
  const st = state(ctx)
  if (st.ready) return
  const config = loadConfig()
  const dir = coreDir(config)

  const created = ensureDefaults(dir, HERE)
  if (created.created.length) note('已生成默认主体文件：' + created.created.join(', '))

  let core = loadCore(dir, HERE)
  let manifest = compile(core, dir)

  // 客户端身份段：读编译产物；persona.md 改了就重编译
  const clientText = () => {
    try {
      const personaFile = path.join(dir, 'persona.md')
      const mtime = fs.statSync(personaFile).mtimeMs
      if (mtime > manifest.compiledAt) {
        core = loadCore(dir, HERE)
        manifest = compile(core, dir)
        note('persona.md 已更新，重编译渠道模板')
      }
      return fs.readFileSync(path.join(compiledDir(), 'client.identity.txt'), 'utf8')
    } catch (error) {
      safeLog(ctx, 'warn', 'dsh-dafeiyu-core: 读编译产物失败，用内存版本：' + String((error && error.message) || error))
      return buildClientIdentity(core)
    }
  }

  // systemPrompt 服务可能比本插件晚就绪（宿主按依赖图加载），
  // 所以和 tools 服务一样：没等到就 250ms 重试，最多等 60 秒。
  mountClientSection(ctx, config, clientText)

  // 把人格版本报给 self：「同一个我」现在有指纹可查了
  try {
    const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
    if (typeof self?.declare === 'function') {
      self.declare({
        id: 'core',
        package: 'dsh-dafeiyu-core',
        intent: '人格与渠道模板：加载人格文件、按渠道组装系统提示词',
        limits: ['只负责组装与加载，不改人格内容', '不访问网络'],
        failureModes: [{ code: 'PERSONA_MISSING', meaning: '人格文件缺失，退回默认人格', retry: '自动补齐默认文件' }],
        scope: ['owner', 'group', 'private'],
        state: () => ({
          personaHash: String(manifest?.personaHash || '').slice(0, 10),
          channels: (manifest?.channels || []).length,
          compiledAt: Number(manifest?.compiledAt) || 0,
        }),
      })
    }
  } catch {
    // self 没装不影响人格加载
  }

  st.ready = true
  safeLog(ctx, 'info', `dsh-dafeiyu-core ready（persona ${manifest.personaHash.slice(0, 10)}，${manifest.channels.join('/')}）`)
  note(`dsh-dafeiyu-core: 主体 ${manifest.personaHash.slice(0, 10)}，渠道模板 ${manifest.channels.join('/')}，root=${dir}`)
}

function mountClientSection(ctx, config, clientText) {
  const st = state(ctx)
  if (st.sectionMounted) return
  try {
    const systemPrompt = ctx.get?.('systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const register = () =>
        systemPrompt.section({
          name: 'dafeiyu:identity',
          order: Number(config.clientHintOrder) || 55,
          text: clientText,
        })
      if (typeof ctx.effect === 'function') ctx.effect(register)
      else register()
      st.sectionMounted = true
      note('客户端身份段已挂载（systemPrompt.section）')
      return
    }
  } catch (error) {
    note('客户端身份段挂载失败：' + String((error && error.message) || error))
    return
  }

  if (!st.sectionSince) st.sectionSince = Date.now()
  if (Date.now() - st.sectionSince > 60000) {
    note('60s 内没等到 systemPrompt.section，客户端身份段跳过（桌宠模板已生成）')
    return
  }
  if (st.sectionWaiting) return
  st.sectionWaiting = true
  st.later(() => {
    st.sectionWaiting = false
    try {
      mountClientSection(ctx, config, clientText)
    } catch (error) {
      note('重试挂载身份段时抛错：' + String((error && error.message) || error))
    }
  }, 250)
}

/**
 * 从 persona.md 里读可选的人格维度块。
 *
 * 约定（不写也可以，没有就返回 null）：
 * <!-- persona-dims
 * {"extraversion":0.8,"agreeableness":0.7,"conscientiousness":0.5,"neuroticism":0.45,"openness":0.65}
 * -->
 *
 * 有这块之后，mood 插件就不用去读桌宠 config 里那份数值了——人格只有一处定义。
 */
export function readPersonaDims(personaText) {
  try {
    const match = String(personaText || '').match(/<!--\s*persona-dims\s*\n([\s\S]*?)-->/)
    if (!match) return null
    const parsed = JSON.parse(match[1].trim())
    if (!parsed || typeof parsed !== 'object') return null
    const out = {}
    for (const key of ['extraversion', 'agreeableness', 'conscientiousness', 'neuroticism', 'openness']) {
      const value = Number(parsed[key])
      if (Number.isFinite(value)) out[key] = Math.min(1, Math.max(0, value))
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

function compile(core, dir) {
  const out = compiledDir()
  const personaFile = path.join(dir, 'persona.md')
  let compiledAt = Date.now()
  try {
    compiledAt = Math.max(compiledAt, fs.statSync(personaFile).mtimeMs)
  } catch {
    // ignore
  }
  const hash = personaHash(core.persona)
  const channels = Object.keys(core.voice.channels || {})
  writeFile(path.join(out, 'pet.template.txt'), buildPetTemplate(core))
  writeFile(path.join(out, 'client.identity.txt'), buildClientIdentity(core))
  // 每个渠道一份完整身份段：适配器（QQ/B 站等）直接读，不用各自拼人格
  for (const channel of channels) {
    writeFile(path.join(out, `identity.${channel}.txt`), buildSystem({ channel, core }))
  }
  const manifest = {
    personaHash: hash,
    strength: core.voice.strength,
    channels,
    personaLines: core.persona.split('\n').length,
    // 人格数值（可选）。mood 读这里，不再读桌宠 config，人格只有一处定义。
    personaDims: readPersonaDims(core.persona),
    compiledAt,
  }
  writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
