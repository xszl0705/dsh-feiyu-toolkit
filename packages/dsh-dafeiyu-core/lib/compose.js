/**
 * dsh-dafeiyu-core — 装配器（纯函数，无 I/O）
 *
 * 同一个主体，不同渠道只换「怎么说」：
 *   buildSystem({channel})      渠道完整的 system 文本
 *   buildPetTemplate()          桌宠模板（含占位符，调用方每次填）
 *   buildClientIdentity()       客户端注入段
 *   fillTemplate(tpl, vars)     占位符替换
 */

const ORDER = ['client', 'pet', 'qq', 'bili']

function channelOf(voice, channel) {
  const found = voice.channels?.[channel]
  if (found) return found
  return {
    label: channel,
    length: '按需',
    tone: '中性',
    emoji: false,
    maxChars: 0,
  }
}

export function channelNames(voice) {
  const names = new Set([...ORDER, ...Object.keys(voice.channels || {})])
  return [...names]
}

/** 渠道约束说明（同一主体、不同表达，不含任何人格改动）。 */
export function channelRules(channel, voice) {
  const cfg = channelOf(voice, channel)
  const parts = [
    `渠道：${cfg.label || channel}`,
    `长度：${cfg.length}${cfg.maxChars ? `，不超过 ${cfg.maxChars} 字` : ''}`,
    `语气：${cfg.tone}`,
    cfg.emoji ? '可以用少量表情符号' : '不用表情符号',
  ]
  return parts.join('；') + '。'
}

export function buildSystem({ channel = 'client', core }) {
  return `${core.persona}\n\n【这个渠道怎么说】\n${channelRules(channel, core.voice)}\n只改变表达的长度与媒介，不改变上面的人格、立场与记忆。`
}

export function buildPetTemplate(core) {
  const cfg = channelOf(core.voice, 'pet')
  return [
    core.persona,
    '',
    '【这一条怎么说话】',
    '你在桌宠气泡里说话（这句话会被 TTS 念出来）。',
    `长度：${cfg.length}${cfg.maxChars ? `，不超过 ${cfg.maxChars} 个字` : ''}；口语短句；可以用「呀/嘛/啦/诶」。`,
    '不要解释、不要排比、不要说教、不要用表情符号、不要加引号。',
    '场景：{{scene}}。{{away}}。{{mood}}。{{memory}}。',
    '直接输出这句话本身。',
  ].join('\n')
}

export function buildClientIdentity(core) {
  const cfg = channelOf(core.voice, 'client')
  return [
    core.persona,
    '',
    '【这个渠道怎么说】',
    `渠道：${cfg.label || '客户端'}；长度：${cfg.length}；语气：${cfg.tone}。`,
    '桌宠、QQ、B 站上的你也是同一个你——记忆、立场、对人的态度一致；只换表达方式。',
  ].join('\n')
}

export function fillTemplate(template, values = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = values[key]
    return value === undefined || value === null || value === '' ? '' : String(value)
  })
}
