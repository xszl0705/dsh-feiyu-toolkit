/**
 * 视觉任务的上下文包：图片 + 问题 + 相关记忆 + 最近对话。
 * 原则：先对齐上下文，再看图；没有依据就说记不清。
 */
export function buildVisionContextPrompt({ question = '', memory = [], recent = [], knowledge = [], groupRecent = [] } = {}) {
  const memoryBlock = memory.length
    ? `\n【相关记忆（只有确定相关才用）】\n${memory.slice(0, 5).map((m) => `- ${String(m.text || m.summary || '').slice(0, 120)}`).join('\n')}`
    : ''
  const recentBlock = recent.length
    ? `\n【最近对话】\n${recent.slice(-6).map((r) => `${r.role === 'user' ? '对方' : '你'}：${String(r.text || '').slice(0, 100)}`).join('\n')}`
    : ''
  const knowledgeBlock = knowledge.length
    ? `\n【群知识（有来源才用）】\n${knowledge.slice(0, 3).map((k) => `- ${String(k.text || k.summary || '').slice(0, 120)}`).join('\n')}`
    : ''
  const groupBlock = groupRecent.length
    ? `\n【最近群聊】\n${groupRecent.slice(-10).map((m) => `- ${m.speaker || '某人'}：${String(m.text || '').slice(0, 100)}`).join('\n')}`
    : ''
  return [
    '【图片上下文】',
    '你在看图回答。先对齐上下文，再看图；不要把图外猜测当事实。',
    String(question || '描述这张图。'),
    memoryBlock,
    recentBlock,
    knowledgeBlock,
    groupBlock,
    '',
    '看图要求：先逐字读出图中文字/数字，再描述布局、对象、异常和结论；看不清就说看不清，不要泛泛而谈。',
    '如果图片内容和记忆/上下文冲突，以当前图片为准，并说明冲突；没有依据的部分说记不清。',
  ]
    .filter(Boolean)
    .join('\n')
}
