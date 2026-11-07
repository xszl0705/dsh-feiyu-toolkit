/**
 * qq(action=send) 的发送层：把一条消息按「文字 / 图片 / 语音 / 文件」组合发出去。
 *
 * 2026-11-04 从 index.js 抽出来（阶段 2.1 拆 qq）：这里只负责「怎么发」，
 * 不碰事件解析、放行判断、图片入库。config / runtime / note 全部由调用方传入，
 * HTTP 与 TTS 可以通过 deps 注入，便于单测。
 *
 * 两条通道的区别（别合并）：
 *  - 纯文字且执行层可用 → 走 runtime.exec（幂等落盘；结果未知只进对账，绝不自动重发）
 *  - 其它（图/语音/文件/混合） → 直接发消息段，失败就如实报，不重试
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendSegments, uploadFile, localFileUrl } from './send.js'
import { synthesizeSpeech } from './tts.js'
import { cleanReply } from './prompt.js'

/** 只接受已存在的本机绝对路径；给了 maxMb 就顺手卡大小。 */
export function resolveExisting(p, label, maxMb) {
  const abs = path.resolve(p)
  if (!fs.existsSync(abs)) throw new Error(`${label}不存在：${abs}`)
  const mb = fs.statSync(abs).size / 1048576
  if (maxMb && mb > maxMb) throw new Error(`${label} ${mb.toFixed(1)}MB，超过 ${maxMb}MB 上限`)
  return abs
}

export async function runSendAction({ action = 'send', args = {}, config = {}, runtime = {}, note = () => {}, deps = {} } = {}) {
  const tts = deps.tts || synthesizeSpeech
  const segmentsOf = deps.sendSegments || sendSegments
  const uploadOf = deps.uploadFile || uploadFile

  const kind = args?.kind === 'group' ? 'group' : 'private'
  const targetId = String(args?.targetId || '')
  const text = cleanReply(args?.text, config.maxReplyChars)
  const imagePath = String(args?.image || '').trim()
  const voicePathInput = String(args?.voice || '').trim()
  let voicePath = voicePathInput
  const sayText = String(args?.say || '').trim()
  const filePath = String(args?.file || '').trim()
  const notes = []
  let tmpWav = ''
  try {
    if (!text && !imagePath && !voicePath && !filePath && !sayText) {
      return { action, ok: false, detail: 'text / image / voice / say / file 至少给一个' }
    }
    // 纯文字走执行层：非幂等，崩溃后只进 unknown 对账，绝不自动重发
    if (text && !imagePath && !voicePathInput && !filePath && !sayText && runtime.exec) {
      const sent = await runtime.exec.send({ kind, targetId, text })
      if (sent.ok) return { action, ok: true, detail: `文字已发送 retcode=${sent.retcode ?? 0}` }
      return {
        action,
        ok: false,
        detail: sent.unknown ? '发送结果未知（可能已发出，待对账）' : '发送失败：' + (sent.reason || sent.status),
      }
    }
    if (!voicePath && sayText) {
      // 优先走本机 SSVO 网关（uni-voice，自然音色）；网关不可用时回退 SAPI
      tmpWav = path.join(os.tmpdir(), `dafeiyu-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
      const synthesized = await tts(sayText, tmpWav, config, note)
      const via = synthesized.via === 'ssvo' ? `ssvo/${synthesized.engine || '?'}` : 'sapi'
      notes.push(`TTS ${Math.round(synthesized.size / 1024)}KB ${via}`)
      voicePath = tmpWav
    } else if (voicePath && sayText) {
      notes.push('voice 与 say 同时给，已用 voice')
    }
    const segments = []
    if (text) segments.push({ type: 'text', data: { text } })
    if (imagePath) segments.push({ type: 'image', data: { file: localFileUrl(resolveExisting(imagePath, '图片', 20)) } })
    if (voicePath) segments.push({ type: 'record', data: { file: localFileUrl(resolveExisting(voicePath, '语音文件', 20)) } })
    if (segments.length) {
      const r = await segmentsOf({ httpUrl: config.httpUrl, token: config.accessToken, kind, targetId, segments, timeoutMs: 30000 })
      notes.push(`消息段 ${r.ok ? 'ok' : 'fail'} retcode=${r.retcode}`)
      if (!r.ok) return { action, ok: false, detail: notes.join('；') }
    }
    if (filePath) {
      const r = await uploadOf({ httpUrl: config.httpUrl, token: config.accessToken, kind, targetId, filePath: resolveExisting(filePath, '文件') })
      notes.push(`文件 ${r.ok ? 'ok' : 'fail'} retcode=${r.retcode}`)
      if (!r.ok) return { action, ok: false, detail: notes.join('；') }
    }
    return { action, ok: true, detail: notes.join('；') }
  } catch (error) {
    return { action, ok: false, detail: String((error && error.message) || error) }
  } finally {
    if (tmpWav) { try { fs.unlinkSync(tmpWav) } catch { /* 临时 wav 已被移走或删掉，忽略 */ } }
  }
}
