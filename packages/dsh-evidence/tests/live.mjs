/**
 * tests/live.mjs — 实网冒烟（不属于 CI 必过项，单独跑）
 *
 * 验证三站真实编码路径：
 *   腾讯 qt.gtimg.cn（GBK）、东财 push2（UTF-8）、新浪 hq.sinajs.cn（403 → header 重试 → GB18030）
 */
import path from 'node:path'
import { createChannel } from '../lib/channel.js';

const TARGETS = [
  { id: 'tencent', url: 'https://qt.gtimg.cn/q=sh600519', expectZero: true },
  {
    id: 'eastmoney',
    url: 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58',
    expectZero: true,
  },
  { id: 'sina', url: 'https://hq.sinajs.cn/list=sh600519', expectZero: true },
];

const out = { at: new Date().toISOString(), results: [] };

for (const t of TARGETS) {
  const ch = createChannel({ fetchImpl: globalThis.fetch });
  try {
    const r = await ch.fetchWithFallback(t.url, { deadlineMs: 20000 });
    out.results.push({
      id: t.id,
      ok: r.ok,
      code: r.code,
      channel: r.channel,
      status: r.status,
      encoding: r.encoding,
      replacementChars: r.replacementChars,
      bytes: r.attempts?.find((a) => a.status)?.bytes,
      sample: (r.text || '').slice(0, 60),
      attempts: r.attempts,
    });
  } catch (e) {
    out.results.push({ id: t.id, ok: false, error: String(e && e.message) });
  }
}

const allOk = out.results.every((r) => r.ok === true && (r.replacementChars ?? 1) === 0);
out.allOk = allOk;

const { writeFileSync } = await import('node:fs');
writeFileSync(path.join(process.cwd(), '_tmp', 'evidence-live.json'), JSON.stringify(out, null, 1), 'utf8');

for (const r of out.results) {
  console.log(
    `${r.ok ? 'OK  ' : 'FAIL'} ${r.id.padEnd(10)} enc=${String(r.encoding).padEnd(8)} repl=${r.replacementChars} ${String(r.sample || r.error || '').slice(0, 40)}`
  );
}
console.log(allOk ? 'LIVE_ALL_OK' : 'LIVE_HAS_FAILURE');
process.exit(allOk ? 0 : 1);
