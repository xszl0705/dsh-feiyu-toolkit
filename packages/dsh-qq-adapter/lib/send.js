/**
 * OneBot 11 HTTP 调用（NapCat 的 HTTP 服务默认在 3000）。
 */

export async function callOneBot({ httpUrl, token, action, params = {}, timeoutMs = 10000 }) {
  const base = String(httpUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('httpUrl 为空')
  const headers = { 'content-type': 'application/json' }
  const accessToken = String(token || '').trim()
  if (accessToken) headers.authorization = `Bearer ${accessToken}`

  const response = await fetch(`${base}/${String(action || '').replace(/^\/+/, '')}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const ok = response.ok && (payload?.status === 'ok' || payload?.retcode === 0)
  return { ok, status: response.status, retcode: payload?.retcode ?? null, payload }
}

export async function sendOneBot({ httpUrl, token, kind, targetId, text, timeoutMs = 10000 }) {
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const params = kind === 'group'
    ? { group_id: Number(targetId) || targetId, message: text }
    : { user_id: Number(targetId) || targetId, message: text }
  return callOneBot({ httpUrl, token, action, params, timeoutMs })
}

/** 同意/拒绝入群邀请或加群请求。 */
export async function setGroupAddRequest({ httpUrl, token, flag, subType = 'invite', approve = true, reason = '' }) {
  return callOneBot({
    httpUrl,
    token,
    action: 'set_group_add_request',
    params: { flag, sub_type: subType, approve, reason },
    timeoutMs: 10000,
  })
}
