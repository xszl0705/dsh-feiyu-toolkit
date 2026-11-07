/**
 * OneBot 11 HTTP 调用（SnowLuma / NapCat 的 HTTP 服务默认在 3000）。
 *
 * 文本走 send_private_msg / send_group_msg；
 * 图文混排走「消息段数组」；文件走 upload_private_file / upload_group_file。
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

/** 把本地绝对路径转成 OneBot 认的 file:// URL（正斜杠，不做 URL 编码，中文路径也能过）。 */
export function localFileUrl(absPath) {
  const normalized = String(absPath || '').trim().replace(/\\/g, '/')
  if (!normalized) throw new Error('路径为空')
  if (/^file:\/\//i.test(normalized)) return normalized
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${withSlash}`
}

/** 图文混排：segments 是 OneBot v11 消息段数组。 */
export async function sendSegments({ httpUrl, token, kind, targetId, segments, timeoutMs = 20000 }) {
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const params = kind === 'group'
    ? { group_id: Number(targetId) || targetId, message: segments }
    : { user_id: Number(targetId) || targetId, message: segments }
  return callOneBot({ httpUrl, token, action, params, timeoutMs })
}

/** 上传本地文件（私聊/群），比走消息段更稳，适合任意类型的文件。 */
export async function uploadFile({ httpUrl, token, kind, targetId, filePath, name, timeoutMs = 60000 }) {
  const abs = String(filePath || '').trim()
  if (!abs) throw new Error('文件路径为空')
  const fileName = String(name || abs.split(/[\\/]/).pop() || 'file')
  if (kind === 'group') {
    return callOneBot({
      httpUrl,
      token,
      action: 'upload_group_file',
      params: { group_id: Number(targetId) || targetId, file: `file:///${abs.replace(/\\/g, '/').replace(/^\/+/, '')}`, name: fileName, folder: '/' },
      timeoutMs,
    })
  }
  return callOneBot({
    httpUrl,
    token,
    action: 'upload_private_file',
    params: { user_id: Number(targetId) || targetId, file: `file:///${abs.replace(/\\/g, '/').replace(/^\/+/, '')}`, name: fileName },
    timeoutMs,
  })
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
