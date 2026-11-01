/**
 * 客户端图片预检索：在 LLM 请求真正发出前，把相关记忆/最近对话注入图片消息。
 * 不替换图片，只加一段隐藏的文本上下文；原生视觉继续看图。
 */
import { buildVisionContextPrompt } from './vision-context.js'

function contentHasImage(content) {
  return Array.isArray(content) && content.some((block) => block?.type === 'image')
}

function messagesHaveImage(messages) {
  return Array.isArray(messages) && messages.some((message) => contentHasImage(message?.content))
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block?.text || ''))
    .join('\n')
    .trim()
}

function lastUserText(messages) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user') {
      const text = textOf(message.content)
      if (text && !text.includes('【图片上下文】')) return text.slice(0, 500)
    }
  }
  return ''
}

function injectContext(messages, context) {
  const out = []
  let injected = false
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message || !contentHasImage(message.content)) {
      out.push(message)
      continue
    }
    const content = Array.isArray(message.content) ? message.content : []
    if (content.some((block) => block?.type === 'text' && String(block?.text || '').includes('【图片上下文】'))) {
      out.push(message)
      continue
    }
    out.push({
      ...message,
      content: [{ type: 'text', text: context.slice(0, 4000) }, ...content],
    })
    injected = true
    if (i < messages.length - 1) {
      // 只给第一条带图消息加一次；后续消息保持原样
      for (let j = i + 1; j < messages.length; j += 1) out.push(messages[j])
      break
    }
  }
  return injected ? out : messages
}

function searchMemory(ctx, question) {
  try {
    const memory = ctx.get?.('memory')
    if (!memory || typeof memory.search !== 'function') return []
    return memory.search(question, { limit: 5 }) || []
  } catch {
    return []
  }
}

function recentDialog(ctx) {
  try {
    const dialog = ctx.get?.('dialog') || ctx.get?.('dialogues')
    if (!dialog || typeof dialog.recent !== 'function') return []
    return dialog.recent({ conversation: 'owner', limit: 6 }) || []
  } catch {
    return []
  }
}

export function installClientVisionContext(ctx, { note = () => {} } = {}) {
  const rerouted = new WeakSet()
  let installed = false
  return ctx.effect(
    () =>
      ctx.on(
        'llm/stream',
        (options, next) =>
          (async function* () {
            if (rerouted.has(options) || !messagesHaveImage(options?.messages)) {
              yield* next()
              return
            }
            const question = lastUserText(options.messages)
            const memory = question ? searchMemory(ctx, question) : []
            const recent = recentDialog(ctx)
            const context = buildVisionContextPrompt({ question, memory, recent })
            const messages = injectContext(options.messages, context)
            if (messages === options.messages) {
              yield* next()
              return
            }
            const reroutedOptions = { ...options, messages }
            rerouted.add(reroutedOptions)
            note(`客户端图片上下文已注入：memory=${memory.length} recent=${recent.length}`)
            // 不能写 ctx.llm：本插件没有 inject 'llm'，cordis 的 get 陷阱会直接抛
            // "cannot get property \"llm\" without inject"，可选链也拦不住。
            // 全库其它插件统一用 ctx.get('llm') 取服务，不走 inject 检查。
            const llm = ctx.get?.('llm')
            try {
              if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
              yield* llm.stream(reroutedOptions)
            } finally {
              rerouted.delete(reroutedOptions)
            }
          })(),
        { global: true, prepend: true },
      ),
    'client-vision-context',
  )
}
