/**
 * qq 的工具注册层：qq(action=…) 与 sticker(...) 两个工具的定义与 execute。
 *
 * 2026-11-04 从 index.js 的 applyInner 抽出来（阶段 2.1 拆 qq）：这里只管工具面，
 * 不碰连接、事件处理、图片入库流程。config / runtime / st / note 全部由调用方传入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { toolsOrRetry } from 'dsh-plugin-kit/wait-for-tools'
import { runSendAction } from './send-action.js'
import { readImageBlock, newestAttachmentImage } from './client-image-library.js'

export function registerQqTools({ ctx, st, config, runtime, note }) {
  const tools = toolsOrRetry(ctx, st, () => registerQqTools({ ctx, st, config, runtime, note }), {
    warn: (seconds) => note(`${seconds}s 内没等到 tools 服务，qq 未注册`),
    log: (message) => note(message),
  })
  if (!tools) return
  if (st.toolsRegistry !== tools) {
    st.toolsRegistry = tools
    ctx.effect(() => {
      const handles = []
      handles.push(
        tools.register({
          name: 'qq',
          description: 'QQ：action=status 看连接与收发计数 / send 手动发一条（kind=private|group，targetId 是 QQ 号/群号，text 是内容）/ reconcile 处理发送结果未知的记录（不带 id 列出待对账；带 id+decision=sent|not-sent 人工裁定）。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['status', 'send', 'reconcile'], description: '要做的事' },
              id: { type: 'string', description: 'reconcile 用：待对账记录 id（省略则只列出，不裁定）' },
              decision: { type: 'string', enum: ['sent', 'not-sent'], description: 'reconcile 用：sent=确认已发出，not-sent=确认没发出' },
              kind: { type: 'string', description: 'send 用：private 或 group' },
              targetId: { type: 'string', description: 'send 用：QQ 号 / 群号' },
              text: { type: 'string', description: 'send 用：要发的文字（可省略，只发图/文件时不用给）' },
              image: { type: 'string', description: 'send 用：本地图片绝对路径（png/jpg/gif/webp，≤20MB），会和 text 一起发' },
              voice: { type: 'string', description: 'send 用：本地语音文件绝对路径（wav/amr/silk，≤20MB）；SnowLuma 会自动转 SILK' },
              say: { type: 'string', description: 'send 用：要朗读的文字，插件优先走本机 SSVO 语音网关（uni-voice，自然音色），网关不可用时回退 Windows SAPI（与 voice 二选一）' },
              file: { type: 'string', description: 'send 用：本地文件绝对路径，走 upload_private_file / upload_group_file' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                action: { type: 'string' }, enabled: { type: 'boolean' }, connected: { type: 'boolean' },
                wsUrl: { type: 'string' }, replied: { type: 'number' }, ignored: { type: 'number' },
                queued: { type: 'number' }, lastError: { type: 'string' }, ok: { type: 'boolean' },
                execDone: { type: 'number' }, execFailed: { type: 'number' }, execUnknown: { type: 'number' }, execPending: { type: 'number' },
                detail: { type: 'string' }, error: { type: 'string' },
              },
            },
            render: (_args, v) => [{
              type: 'text',
              text: v.action === 'send'
                ? (v.ok ? '已发送' : '发送失败：' + v.detail)
                : v.action === 'reconcile'
                  ? v.detail
                  : (v.enabled
                    ? `QQ：${v.connected ? '已连接' : '未连接'}（${v.wsUrl}），已回复 ${v.replied} 条，忽略 ${v.ignored} 条，交微心跳 ${v.queued} 条${v.lastError ? '，最近错误：' + v.lastError : ''}${v.execUnknown ? `，执行层待对账 ${v.execUnknown} 条` : ''}`
                    : 'QQ 适配器已停用（config.enabled=false）'),
            }],
          },
          timeoutMs: 15000,
          isConcurrencySafe: () => false,
          execute: async (args) => {
            const action = String(args?.action || 'status')
            if (action === 'status') {
              let exec = null
              try {
                exec = runtime.exec?.stats?.() || null
              } catch {
                exec = null
              }
              return {
                action,
                enabled: Boolean(st.config?.enabled),
                connected: st.connected,
                wsUrl: st.config?.wsUrl || '',
                replied: st.replied,
                ignored: st.ignored,
                queued: st.queued,
                lastError: st.lastError,
                execDone: exec?.done || 0,
                execFailed: exec?.failed || 0,
                execUnknown: exec?.unknown || 0,
                execPending: exec?.pending || 0,
              }
            }
            if (action === 'reconcile') {
              const exec = runtime.exec
              if (!exec || typeof exec.listUnknown !== 'function') {
                return { action, ok: false, detail: '执行层未启用（node:sqlite 不可用或 execLayer.enabled=false）' }
              }
              const wantId = String(args?.id || '').trim()
              const decision = String(args?.decision || '').trim()
              if (!wantId) {
                const rows = exec.listUnknown({ limit: 20 })
                if (!rows.length) return { action, ok: true, detail: '没有待对账记录' }
                const lines = rows.map((r) => {
                  const where = r.channel === 'group' ? '群' : '私聊'
                  const raw = String(r.text || '')
                  const text = raw.slice(0, 40) + (raw.length > 40 ? '…' : '')
                  return `${r.id} ${where} ${r.targetId}：${text}（试过 ${r.attempts} 次，${r.updatedAt}，${r.lastError || '无错误'})`
                })
                const total = exec.stats?.().unknown || rows.length
                return {
                  action,
                  ok: true,
                  detail: `待对账 ${total} 条（最多列 20 条）；先看 QQ 上到底有没有发出去，再裁定：\n${lines.join('\n')}\nqq(action=reconcile, id=…, decision=sent|not-sent)`,
                }
              }
              if (!decision) return { action, ok: false, detail: '给了 id 就要给 decision=sent|not-sent' }
              const r = exec.reconcile(wantId, decision)
              if (!r.ok) {
                return { action, ok: false, detail: `对账失败：${r.reason}${r.status ? '（当前状态 ' + r.status + '）' : ''}` }
              }
              return {
                action,
                ok: true,
                detail: `已裁定 ${r.id} → ${decision === 'sent' ? 'done（确认已发出）' : 'failed（确认未发出；要补发请手动 qq(send)）'}`,
              }
            }
            if (action === 'send') {
              // 发送层已抽到 lib/send-action.js：这里只传运行时依赖，不再自己拼消息段
              return runSendAction({ action, args, config, runtime, note })
            }
            return { ok: false, action, error: '未知 action：' + action }
          },
        }),
      )
      handles.push(
        tools.register({
          name: 'sticker',
          description: '图片/表情包/GIF 库：list 看最近收到的图或已收藏，search 按描述找，save 收藏（不给 id 就用最近收到的那张；也可以给 path 或 attachment 直接收一张外部图），forget 删除，path 取文件绝对路径（拿去 qq(action=send,image=…) 发出去），stats 看库统计。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'search', 'save', 'forget', 'path', 'stats'], description: '要做的事' },
              id: { type: 'string', description: '图片 id；save 省略时用最近收到的那张，path 省略时同' },
              path: { type: 'string', description: 'save 用：本机图片绝对路径（客户端拖图没入库时可指到这里）' },
              attachment: { type: 'string', description: 'save 用：DSH 附件 id（~/.dsh/attachments/v1/objects 里那串 sha256）' },
              query: { type: 'string', description: 'search 用：描述 / 标签 / 来源昵称关键词' },
              saved: { type: 'boolean', description: 'list 用：true 只看已收藏，false 只看最近档' },
              limit: { type: 'number', description: 'list / search 返回条数，默认 10' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' }, id: { type: 'string' }, path: { type: 'string' }, detail: { type: 'string' } },
            },
            render: (_args, value) => [{ type: 'text', text: value.ok ? value.detail : '图片库：' + value.detail }],
          },
          timeoutMs: 15000,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            const lib = runtime.imageLibrary
            if (!lib) return { ok: false, detail: '图片库已关闭（config.imageLibrary.enabled=false）' }
            const action = String(args?.action || 'list')
            const fallbackId = String(st.lastImage?.ids?.[0] || '')
            const format = (items) => items
              .map((x) => [
                x.id,
                x.saved ? '已收藏' : '最近',
                x.animated ? 'GIF/动图' : '',
                x.width && x.height ? `${x.width}x${x.height}` : '',
                `${Math.round((Number(x.bytes) || 0) / 1024)}KB`,
                x.tags?.length ? `[${x.tags.join(',')}]` : '',
                String(x.caption || '').slice(0, 60),
                x.path,
              ].filter(Boolean).join(' '))
              .join('\n')
            try {
              if (action === 'stats') return { ok: true, detail: JSON.stringify(lib.stats()) }
              if (action === 'list' || action === 'search') {
                const items = lib.list({
                  saved: typeof args?.saved === 'boolean' ? args.saved : undefined,
                  query: action === 'search' ? String(args?.query || '') : '',
                  limit: Number(args?.limit) || 10,
                })
                return { ok: true, detail: items.length ? format(items) : '库里没有匹配的图' }
              }
              if (action === 'path') {
                const item = lib.get(String(args?.id || fallbackId))
                return item ? { ok: true, id: item.id, path: item.path, detail: item.path } : { ok: false, detail: '没找到这张图' }
              }
              if (action === 'save') {
                const explicitId = String(args?.id || '')
                if (explicitId) {
                  const item = lib.update(explicitId, { saved: true })
                  return { ok: true, id: item.id, path: item.path, detail: `已收藏 ${item.id}：${item.path}` }
                }
                const fromFile = String(args?.path || '').trim()
                if (fromFile) {
                  const abs = path.resolve(fromFile)
                  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, detail: `文件不存在：${abs}` }
                  const saved = lib.remember({
                    bytes: fs.readFileSync(abs),
                    saved: true,
                    source: { channel: 'client', kind: 'file', name: path.basename(abs) },
                  })
                  if (!saved.ok) return { ok: false, detail: `这张图存不了（${saved.reason}）` }
                  return { ok: true, id: saved.record.id, path: saved.path, detail: `已收藏 ${saved.record.id}：${saved.path}` }
                }
                const attachmentId = String(args?.attachment || '').trim()
                if (attachmentId) {
                  const image = readImageBlock({ type: 'image', attachment: { id: attachmentId } })
                  if (!image?.bytes?.length) return { ok: false, detail: `找不到附件：${attachmentId}` }
                  const saved = lib.remember({
                    bytes: image.bytes,
                    mediaType: image.mediaType,
                    saved: true,
                    source: { channel: 'client', kind: 'attachment', messageId: attachmentId },
                  })
                  if (!saved.ok) return { ok: false, detail: `这张图存不了（${saved.reason}）` }
                  return { ok: true, id: saved.record.id, path: saved.path, detail: `已收藏 ${saved.record.id}：${saved.path}` }
                }
                if (!fallbackId) {
                  // 兜底：附件目录里最近两小时上传的图（拖图/粘贴都会先落成附件）
                  const newest = newestAttachmentImage(undefined, { maxAgeMs: 2 * 60 * 60 * 1000 })
                  if (!newest?.bytes?.length) {
                    return { ok: false, detail: '最近两小时没在附件目录里找到图片：把图拖进对话（或发到 QQ）后再让我存，也可以给 path / attachment / id' }
                  }
                  const savedNewest = lib.remember({
                    bytes: newest.bytes,
                    mediaType: newest.mediaType,
                    saved: true,
                    source: { channel: 'client', kind: 'attachment', messageId: newest.attachmentId || '' },
                  })
                  if (!savedNewest.ok) return { ok: false, detail: `这张图存不了（${savedNewest.reason}）` }
                  st.lastImage = { ids: [savedNewest.record.id], at: Date.now(), conversation: 'client' }
                  return { ok: true, id: savedNewest.record.id, path: savedNewest.path, detail: `已收藏 ${savedNewest.record.id}：${savedNewest.path}` }
                }
                const item = lib.update(fallbackId, { saved: true })
                return { ok: true, id: item.id, path: item.path, detail: `已收藏 ${item.id}：${item.path}` }
              }
              if (action === 'forget') {
                const id = String(args?.id || '')
                if (!id) return { ok: false, detail: 'forget 需要 id' }
                return lib.forget(id) ? { ok: true, id, detail: `已删除 ${id}` } : { ok: false, detail: '没找到这张图' }
              }
              return { ok: false, detail: '未知 action：' + action }
            } catch (error) {
              return { ok: false, detail: String((error && error.message) || error) }
            }
          },
        }),
      )
      return () => {
        for (const handle of handles) {
          try {
            handle?.dispose?.()
          } catch {
            // ignore
          }
        }
      }
    })
  }
}
