/** The installed DSH LLM contract accepts GenerateOptions.signal. */
export async function collectStream(llm, options, { timeoutMs = 30000, signal, onUsage } = {}) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason || new Error('llm cancelled'))
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('llm timeout')), timeoutMs)
  let iterator, abortHandler
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(controller.signal.reason)
    if (controller.signal.aborted) abortHandler()
    else controller.signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([(async () => {
      controller.signal.throwIfAborted()
      iterator = llm.stream({ ...options, signal: controller.signal })[Symbol.asyncIterator]()
      let text = ''
      while (true) {
        const chunk = await iterator.next()
        controller.signal.throwIfAborted()
        if (chunk.done) break
        const value = chunk.value
        if (value?.type === 'text-delta') text += String(value.text ?? value.delta ?? '')
        else if (value?.type === 'text') text += String(value.text ?? '')
        else if (value?.type === 'usage') onUsage?.(value.usage)
        else if (value?.type === 'finish' && value.reason?.kind && value.reason.kind !== 'stop') throw new Error('llm finish: ' + value.reason.kind)
      }
      return text
    })(), aborted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', abortHandler)
    if (controller.signal.aborted) {
      try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* cancellation is already reported */ }
    }
  }
}
