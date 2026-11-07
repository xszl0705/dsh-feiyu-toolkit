/**
 * 本地模型调用层。
 *
 * 三条纪律（照 mind-loop 已验证的形态，加了熔断）：
 *  1. think:false —— qwen3 默认带思考模式，会把预算全烧在思维链上，本地侧最大的一处浪费
 *  2. 超时必须短 —— 让用户多等 2 秒去省 2 分钱是亏的
 *  3. 失败一律 fail-open，永不把异常抛给主流程
 */

const circuit = { fails: 0, openUntil: 0 }

export function circuitState() {
  return {
    fails: circuit.fails,
    open: Date.now() < circuit.openUntil,
    openUntil: circuit.openUntil ? new Date(circuit.openUntil).toISOString() : null,
  }
}

export function resetCircuit() {
  circuit.fails = 0
  circuit.openUntil = 0
}

function bump(threshold = 3, openMs = 60000) {
  circuit.fails += 1
  if (circuit.fails >= threshold) circuit.openUntil = Date.now() + openMs
}

function extractJSON(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

/**
 * 调 Ollama 并保证返回一个 JSON 对象，否则抛错（由上层 fail-open 兜住）。
 * @returns {Promise<{parsed:object, usage:{prompt:number,out:number}|null, totalMs:number|null}>}
 */
export async function chatJSON({
  endpoint = 'http://127.0.0.1:11434',
  model = 'qwen3:4b',
  messages,
  numCtx = 1024,
  numPredict = 64,
  timeoutMs = 1500,
  keepAlive = '30m',
  temperature = 0,
  circuitOpts = {},
} = {}) {
  if (Date.now() < circuit.openUntil) {
    const err = new Error('circuit-open')
    err.code = 'CIRCUIT_OPEN'
    throw err
  }

  const startedAt = Date.now()
  let res
  try {
    res = await fetch(`${String(endpoint).replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        think: false,
        keep_alive: keepAlive,
        options: {
          temperature,
          top_p: 0.9,
          num_ctx: numCtx,
          num_predict: numPredict,
        },
        messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    bump(circuitOpts.failThreshold, circuitOpts.openMs)
    const err = new Error(error?.name === 'TimeoutError' ? 'timeout' : `fetch-failed:${error?.message || error}`)
    err.code = 'LOCAL_UNAVAILABLE'
    throw err
  }

  if (!res.ok) {
    bump(circuitOpts.failThreshold, circuitOpts.openMs)
    const err = new Error(`ollama-${res.status}`)
    err.code = 'LOCAL_HTTP'
    throw err
  }

  const data = await res.json().catch(() => null)
  const text = data?.message?.content || ''
  const parsed = extractJSON(text)
  if (!parsed) {
    bump(circuitOpts.failThreshold, circuitOpts.openMs)
    const err = new Error('not-json')
    err.code = 'LOCAL_BAD_OUTPUT'
    throw err
  }

  circuit.fails = 0
  return {
    parsed,
    usage: {
      prompt: Number(data?.prompt_eval_count ?? 0),
      out: Number(data?.eval_count ?? 0),
    },
    totalMs: Number(data?.total_duration ?? 0) / 1e6 || Date.now() - startedAt,
  }
}
