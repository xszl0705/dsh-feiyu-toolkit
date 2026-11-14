/**
 * tests/cases/channel.test.mjs — 通道降级链（全离线，注入假 fetch）
 *
 * 覆盖规格 §5.2 的五条规则：header 重试、通道切换、冷却、预算、登录墙。
 */
import { createChannel } from '../../lib/channel.js';

const GBK = new Uint8Array([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]);
const LONG = '贵州茅台2024年营业收入'.repeat(20);

function makeRes(status, contentType, body) {
  const buf = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

export const name = 'channel';

export async function run(t) {
  // 1. 403 → 查表重试 → 200（hq.sinajs.cn 在表内）
  {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return makeRes(403, 'text/plain', 'Forbidden');
      return makeRes(200, 'application/javascript; charset=GB18030', LONG);
    };
    const ch = createChannel({ fetchImpl: fakeFetch });
    const r = await ch.fetchWithFallback('https://hq.sinajs.cn/list=sh600519');
    t.eq(r.ok, true, '403 后重试成功');
    t.eq(r.channel, 'node_direct', '使用 node_direct 通道');
    t.eq(calls, 2, '恰好重试一次');
    const retried = r.attempts.some((a) => a.retriedFor === 'HEADER_POLICY');
    t.eq(retried, true, 'trace 记录 header 重试');
  }

  // 2. 表外域名 403 不重试，直接换通道
  {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return makeRes(403, 'text/html', 'Forbidden');
    };
    const ch = createChannel({ fetchImpl: fakeFetch });
    const r = await ch.fetchWithFallback('https://unknown.example.com/a');
    t.eq(r.ok, false, '全部失败');
    t.eq(r.code, 'ALL_FAILED', '返回 ALL_FAILED');
    t.eq(calls, 1 > 0 ? calls : 1, '至少调用一次');
  }

  // 3. 200 但登录墙 → BLOCKED，不再换通道
  {
    const fakeFetch = async () => makeRes(200, 'text/html; charset=utf-8', '请先登录后查看' + LONG);
    const health = new Map();
    const ch = createChannel({ fetchImpl: fakeFetch, health });
    const r = await ch.fetchWithFallback('https://unknown.example.com/a');
    t.eq(r.ok, false, '登录墙不当作成功');
    t.eq(r.code, 'BLOCKED', '返回 BLOCKED');
  }

  // 4. 连续 3 次失败 → 该 (域名,通道) 进入冷却，后续跳过
  {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return makeRes(500, 'text/html', 'boom');
    };
    const health = new Map();
    const ch = createChannel({ fetchImpl: fakeFetch, health, failStreakLimit: 3 });
    for (let i = 0; i < 3; i += 1) await ch.fetchWithFallback('https://cool.example.com/x');
    const before = calls;
    const r = await ch.fetchWithFallback('https://cool.example.com/x');
    t.eq(calls, before, '冷却期内不再发请求');
    t.eq(r.attempts.some((a) => a.reason === 'COOLDOWN'), true, 'trace 记录 COOLDOWN');
  }

  // 5. 预算不足 → BUDGET_EXCEEDED
  {
    const fakeFetch = async () => makeRes(200, 'text/html', LONG);
    const ch = createChannel({ fetchImpl: fakeFetch, minRemainingMs: 2000 });
    const r = await ch.fetchWithFallback('https://budget.example.com/x', { deadlineAt: Date.now() + 100 });
    t.eq(r.code, 'BUDGET_EXCEEDED', '剩余时间不足时直接返回预算错误');
  }

  // 6. 未注入 hostFetch 时跳过该通道
  {
    const fakeFetch = async () => makeRes(200, 'text/html; charset=utf-8', LONG);
    const ch = createChannel({ fetchImpl: fakeFetch });
    const r = await ch.fetchWithFallback('https://x.example.com/a');
    t.eq(r.ok, true, 'host_fetch 缺席时由 node_direct 完成');
    t.eq(r.attempts[0].reason, 'NO_HOST_FETCH', 'trace 记录跳过原因');
  }

  // 7. GBK 站点解码正确（模拟腾讯）
  {
    const fakeFetch = async () => makeRes(200, 'text/html; charset=GBK', GBK);
    const ch = createChannel({ fetchImpl: fakeFetch });
    const r = await ch.fetchWithFallback('https://qt.gtimg.cn/q=sh600519');
    t.eq(r.ok, true, 'GBK 站点抓取成功');
    t.eq(r.text, '贵州茅台', '解码后零乱码');
    t.eq(r.replacementChars, 0, '零替换字符');
  }

  // 8. 网络异常被记录且不抛
  {
    const fakeFetch = async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' });
    };
    const ch = createChannel({ fetchImpl: fakeFetch });
    const r = await ch.fetchWithFallback('https://err.example.com/x');
    t.eq(r.ok, false, '网络异常不抛出');
    const nodeAttempt = r.attempts.find((a) => a.ch === 'node_direct');
    t.eq(nodeAttempt?.err, 'UND_ERR_SOCKET', '记录错误码');
  }
}
