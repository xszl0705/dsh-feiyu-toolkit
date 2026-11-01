/**
 * dsh-qq-adapter 自检（纯逻辑 + 本地假服务，不连 QQ）。
 *   node tests/smoke.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, 'tests', '.tmp-qq')

let pass = 0
let fail = 0
const problems = []
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    problems.push(`${label} ${detail}`)
    console.log(`  FAIL ${label} ${detail}`)
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
process.env.DSH_HOME = TMP

const { parseEvent, shouldAnswer, RateLimiter, extractText } = await import(
  `file://${path.join(ROOT, 'lib', 'onebot.js').replace(/\\/g, '/')}`
)
const { buildPrompt, cleanReply } = await import(
  `file://${path.join(ROOT, 'lib', 'prompt.js').replace(/\\/g, '/')}`
)
const { sendOneBot, setGroupAddRequest } = await import(`file://${path.join(ROOT, 'lib', 'send.js').replace(/\\/g, '/')}`)
const { appendChat } = await import(`file://${path.join(ROOT, 'lib', 'chatlog.js').replace(/\\/g, '/')}`)
const { handleEvent } = await import(`file://${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`)

const SELF = '10001'
const privateMsg = {
  post_type: 'message',
  message_type: 'private',
  self_id: SELF,
  user_id: '20002',
  message_id: 'm1',
  raw_message: '在吗',
  message: [{ type: 'text', data: { text: '在吗' } }],
  sender: { nickname: '老王' },
}
const groupAtMsg = {
  post_type: 'message',
  message_type: 'group',
  self_id: SELF,
  user_id: '20002',
  group_id: '30003',
  message_id: 'm2',
  message: [
    { type: 'at', data: { qq: SELF, name: '大肥鱼' } },
    { type: 'text', data: { text: ' 说句好听的' } },
  ],
  sender: { card: '群名片' },
}
const groupNoAtMsg = { ...groupAtMsg, message_id: 'm3', message: [{ type: 'text', data: { text: '随便聊' } }] }

console.log('\n[事件解析]')
{
  const priv = parseEvent(privateMsg, SELF)
  check('私聊事件', priv?.kind === 'private' && priv.text === '在吗' && priv.senderName === '老王', JSON.stringify(priv))
  const group = parseEvent(groupAtMsg, SELF)
  check('群聊事件识别 @', group?.kind === 'group' && group.atSelf === true && group.groupId === '30003', JSON.stringify(group))
  check('非 @ 群消息 atSelf=false', parseEvent(groupNoAtMsg, SELF)?.atSelf === false)
  check('自己发的忽略', parseEvent({ ...privateMsg, user_id: SELF }, SELF) === null)
  check('非消息事件忽略', parseEvent({ post_type: 'notice' }, SELF) === null)
  check('空消息忽略', parseEvent({ ...privateMsg, message: [], raw_message: '' }, SELF) === null)
  check('富媒体占位', extractText([{ type: 'image', data: {} }, { type: 'text', data: { text: '看图' } }]) === '[图片]看图')
}

console.log('\n[过滤与限速]')
{
  const config = { allowPrivate: true, groups: ['30003'], requireAtInGroup: true }
  check('私聊放行', shouldAnswer(parseEvent(privateMsg, SELF), config) === true)
  check('白名单群 + @ 放行', shouldAnswer(parseEvent(groupAtMsg, SELF), config) === true)
  check('白名单群不 @ 忽略', shouldAnswer(parseEvent(groupNoAtMsg, SELF), config) === false)
  const wakeConfig = { ...config, groupTrigger: 'wake', wakeWords: ['虚的鱼'] }
  const wakeMsg = { ...groupNoAtMsg, message_id: 'm4', message: [{ type: 'text', data: { text: '虚的鱼 出来' } }] }
  check('群唤醒词放行', shouldAnswer(parseEvent(wakeMsg, SELF), wakeConfig) === true)
  check('群无唤醒词忽略', shouldAnswer(parseEvent(groupNoAtMsg, SELF), wakeConfig) === false)
  check('at_me 兜底识别', parseEvent({ ...groupAtMsg, at_me: true }, SELF)?.atSelf === true)
  check('非白名单群忽略', shouldAnswer(parseEvent({ ...groupAtMsg, group_id: '99999' }, SELF), config) === false)
  check('白名单为空不接群', shouldAnswer(parseEvent(groupAtMsg, SELF), { ...config, groups: [] }) === false)
  check('关掉私聊后忽略私聊', shouldAnswer(parseEvent(privateMsg, SELF), { ...config, allowPrivate: false }) === false)

  const limiter = new RateLimiter(3)
  const now = 1_000_000
  const results = [0, 1, 2, 3].map((i) => limiter.allow('private:20002', now + i))
  check('每分钟限速生效', results.slice(0, 3).every(Boolean) && results[3] === false, JSON.stringify(results))
  check('窗口滑过后恢复', limiter.allow('private:20002', now + 61_000) === true)
}

console.log('\n[提示词与清洗]')
{
  const identity = '我是大肥鱼。\n【这个渠道怎么说】QQ；不超过 120 字。'
  const prompt = buildPrompt({ identity, event: parseEvent(groupAtMsg, SELF) })
  check('提示词含身份与原文', prompt.includes('我是大肥鱼') && prompt.includes('说句好听的') && prompt.includes('群'))
  const long = cleanReply('“' + '好'.repeat(200) + '”', 50)
  check('超长截断并去引号', long.length <= 50 && long.endsWith('…') && !long.startsWith('“'), `${long.length}`)
  check('代码块被清掉', cleanReply('```js\nconsole.log(1)\n``` 嗯') === '嗯')
}

console.log('\n[端到端编排（假模型 + 假发送）]')
{
  const sent = []
  const logs = []
  const deps = {
    config: { allowPrivate: true, groups: ['30003'], requireAtInGroup: true, maxReplyChars: 120 },
    identity: '我是大肥鱼。',
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: '在呢，' }
        yield { type: 'text-delta', text: '你说吧。' }
      })(),
    },
    send: async (payload) => (sent.push(payload), { ok: true }),
    log: (row) => logs.push(row),
    limiter: new RateLimiter(10),
  }
  const reply = await handleEvent(parseEvent(privateMsg, SELF), deps)
  check('生成并发送回复', reply === '在呢，你说吧。' && sent[0]?.kind === 'private' && sent[0]?.targetId === '20002', JSON.stringify({ reply, sent }))
  check('写入 chatlog', logs[0]?.text === reply && logs[0]?.target === 'private:20002', JSON.stringify(logs))

  const quiet = await handleEvent(parseEvent(groupNoAtMsg, SELF), deps)
  check('不满足条件不回复', quiet === null && sent.length === 1)

  const limited = new RateLimiter(1)
  await handleEvent(parseEvent(privateMsg, SELF), { ...deps, limiter: limited })
  const blocked = await handleEvent(parseEvent({ ...privateMsg, message_id: 'm9' }, SELF), { ...deps, limiter: limited })
  check('限速后不回复', blocked === null)
}

console.log('\n[HTTP 发送]')
{
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const ok = await sendOneBot({
    httpUrl: `http://127.0.0.1:${port}`,
    token: 'secret-token',
    kind: 'group',
    targetId: '30003',
    text: '测试一句',
  })
  check('发送成功', ok.ok === true, JSON.stringify(ok))
  check('走 send_group_msg 且带 token', received[0]?.url === '/send_group_msg' && received[0]?.auth === 'Bearer secret-token', JSON.stringify(received[0]))
  check('payload 正确', received[0]?.body?.group_id === 30003 && received[0]?.body?.message === '测试一句', JSON.stringify(received[0]?.body))

  const join = await setGroupAddRequest({
    httpUrl: `http://127.0.0.1:${port}`,
    flag: 'flag-1',
    subType: 'invite',
    approve: true,
  })
  check('群邀请同意走 set_group_add_request', join.ok === true && received[1]?.url === '/set_group_add_request', JSON.stringify(received[1]))
  check('群邀请参数正确', received[1]?.body?.flag === 'flag-1' && received[1]?.body?.approve === true && received[1]?.body?.sub_type === 'invite', JSON.stringify(received[1]?.body))
  await new Promise((resolve) => server.close(resolve))
}

console.log('\n[chatlog 落盘]')
{
  appendChat({ channel: 'qq', moment: 'private', text: '在呢', target: 'private:20002' })
  const dir = path.join(TMP, 'pet-diary', 'chats')
  const files = fs.readdirSync(dir)
  const line = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8').trim())
  check('channel 为 qq 且带 target', line.channel === 'qq' && line.target === 'private:20002', JSON.stringify(line))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) for (const item of problems) console.log(` - ${item}`)
process.exitCode = fail > 0 ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100)
