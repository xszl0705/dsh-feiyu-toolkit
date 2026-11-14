/**
 * 离线单测：全部用 fixture，不联网、不碰真实数据目录。
 * 覆盖：RSS 解析 / 正文抽取 / 通道降级与冷却 / 存档去重 / 简报结构 / 采集端到端 / 模式准入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from '../lib/rss.js';
import { extractArticle, listLinks } from '../lib/html.js';
import { createHttp } from '../lib/http.js';
import { createStore, itemId } from '../lib/store.js';
import { buildBrief } from '../lib/brief.js';
import { runCollect } from '../lib/collect.js';
import { makePresetGate, resetPresetSources } from '../lib/preset-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.message) || error) });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.message) || error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'not equal'}：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------- 1. RSS ----------
check('rss: 3 条 + 字段完整', () => {
  const feed = parseFeed(fixture('wsj-markets.xml'));
  assert(feed.ok, 'parseFeed 应成功');
  equal(feed.items.length, 3, '条目数');
  equal(feed.items[0].title, "Stocks Sink in Broad AI Rout Sparked by China's DeepSeek", '首条标题');
  assert(feed.items[0].link.startsWith('https://www.wsj.com/articles/'), 'link 应以 https 开头');
  assert(feed.items[0].publishedAt.startsWith('2025-01-27'), 'pubDate 应转 ISO：' + feed.items[0].publishedAt);
  assert(feed.items[0].summary.includes('Nvidia'), 'CDATA 摘要应解出');
});

check('rss: 空返回不抛', () => {
  const feed = parseFeed('');
  equal(feed.ok, false, '空 body 应 ok=false');
  equal(feed.error, 'EMPTY_BODY', '错误码');
});

// ---------- 2. 正文抽取 ----------
check('html: 人行 id=zoom 选择器命中', () => {
  const out = extractArticle(fixture('pbc-article.html'), { patterns: ['<div[^>]*id="zoom"[^>]*>([\\s\\S]*?)</div>'] });
  equal(out.how, 'selector', '应走选择器');
  assert(out.chars > 200, '正文应 > 200 字：' + out.chars);
  assert(out.text.includes('469.16万亿元'), '应含社融存量');
  assert(!out.text.includes('法律声明'), '不应带页脚噪声');
});

check('html: 选择器失配走最长块兜底', () => {
  const out = extractArticle(fixture('pbc-article.html'), { patterns: ['<div[^>]*id="nope"[^>]*>'] });
  equal(out.how, 'longest-block', '应走兜底');
  assert(out.chars > 200, '兜底也要够长');
});

check('html: 403 页面判为 BLOCKED', () => {
  const out = extractArticle('<html><title>Access Denied</title><body>Access Denied</body></html>', {});
  equal(out.how, 'empty', '应空');
  equal(out.reason, 'BLOCKED_OR_404', '原因');
});

// ---------- 3. 通道降级与冷却 ----------
await checkAsync('http: 403 后降级到 host_web', async () => {
  const calls = [];
  const http = createHttp({
    fetchImpl: async () => {
      calls.push('node');
      return { status: 403, text: 'Access Denied', headers: { get: () => 'text/html' } };
    },
    hostWeb: async () => {
      calls.push('host');
      return { status: 200, text: 'HOST TEXT' };
    },
  });
  const res = await http.get('https://www.imf.org/en/Publications/WEO');
  equal(res.ok, true, '应成功');
  equal(res.channel, 'host_web', '通道');
  equal(res.text, 'HOST TEXT', '正文');
  assert(calls.join(',') === 'node,host', '调用顺序：' + calls.join(','));
});

await checkAsync('http: 连续 3 次失败进冷却', async () => {
  const http = createHttp({
    fetchImpl: async () => {
      throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    },
    hostWeb: null,
  });
  for (let i = 0; i < 3; i += 1) await http.get('https://ft.com/rss/home', { channels: ['node_direct'] });
  const fourth = await http.get('https://ft.com/rss/home', { channels: ['node_direct'] });
  assert(fourth.attempts.some((row) => row.skipped === 'COOLDOWN'), '第 4 次应被冷却跳过');
});

// ---------- 4. 存档 ----------
check('store: 同日去重', () => {
  const dir = path.join(process.cwd(), '_tmp', 'econ-store-test-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createStore(dir);
  const item = { id: itemId('wsj-markets', 'https://x/1', 'T'), title: 'T', url: 'https://x/1', bodyStatus: 'summary' };
  const first = store.appendItems('2026-11-14', [item]);
  const second = store.appendItems('2026-11-14', [item]);
  equal(first.added, 1, '首次新增');
  equal(second.added, 0, '再次不新增');
  equal(second.skipped, 1, '应记跳过');
  equal(store.readItems('2026-11-14').length, 1, '落盘只有一条');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 5. 简报 ----------
check('brief: 五分区 + 缺口', () => {
  const items = [
    { id: 'a1', source: 'imf-weo', sourceLabel: 'IMF 世界经济展望', zone: 'global_outlook', title: '全球增长 3.0%', summary: '2026 年全球增长 3.0%，2027 年 3.4%', bodyStatus: 'full', bodyChars: 3200, channel: 'host_web' },
    { id: 'b1', source: 'wsj-markets', sourceLabel: 'WSJ 市场', zone: 'media', title: 'Stocks sink', summary: 'Nvidia was down 16%', bodyStatus: 'summary', bodyChars: 140 },
  ];
  const manifest = { totals: { items: 2, full: 1, summary: 1, withheld: 0, failed: 0 }, gaps: ['FT 首页：ECONNRESET（可配 proxy 或 cookie 后重试）'], sourceCount: 2, durationMs: 5000 };
  const md = buildBrief({ date: '2026-11-14', items, manifest });
  for (const zone of ['一、全球展望', '二、美国政策', '三、中国政策', '四、市场与媒体', '五、学术与央行研究']) {
    assert(md.includes(zone), '缺分区：' + zone);
  }
  assert(md.includes('本期缺口与替代'), '缺缺口段');
  assert(md.includes('FT 首页'), '缺口内容应在');
  assert(md.includes('关键数字'), '应抽到数字');
});

// ---------- 6. 采集端到端 ----------
await checkAsync('collect: 端到端（fixture 全链路）', async () => {
  const dir = path.join(process.cwd(), '_tmp', 'econ-collect-test-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createStore(dir);
  const routes = [
    { match: (url) => url === 'https://www.imf.org/en/Publications/WEO', res: { status: 200, text: fixture('imf-list.html') }, channel: 'host_web' },
    { match: (url) => url.endsWith('/index.md'), res: { status: 200, text: fixture('imf-weo.md') }, channel: 'host_web' },
    { match: (url) => url.includes('RSSMarketsMain.xml'), res: { status: 200, text: fixture('wsj-markets.xml') }, channel: 'node_direct' },
    { match: (url) => url.includes('wallstcn.com'), res: { status: 200, text: fixture('wscn-lives.json') }, channel: 'node_direct' },
    { match: (url) => url.includes('db.nomics.world'), res: { status: 200, text: JSON.stringify({ series: { docs: [{ period: ['2026', '2027', '2028'], value: [4.2, 4.0, 3.7] }] } }) }, channel: 'node_direct' },
  ];
  const http = {
    hasHostWeb: true,
    proxy: '',
    async get(url) {
      for (const route of routes) {
        if (route.match(url)) return { ok: route.res.status < 400, status: route.res.status, text: route.res.text, channel: route.channel, attempts: [] };
      }
      return { ok: false, status: 404, text: '', channel: '', attempts: [] };
    },
  };
  const config = { dailyBudgetMs: 30000, concurrency: 4, disabledSources: [] };
  const result = await runCollect({
    date: '2026-11-14',
    http,
    store,
    config,
    sourceIds: ['imf-weo', 'wsj-markets', 'wscn-global', 'imf-dbnomics'],
    force: true,
  });
  assert(!result.skipped, '不应跳过');
  const manifest = store.readManifest('2026-11-14');
  assert(manifest, 'manifest 应落盘');
  assert(manifest.totals.items >= 8, '条目数应 >= 8，实际 ' + manifest.totals.items);
  assert(manifest.totals.full >= 3, '全文条目应 >= 3，实际 ' + manifest.totals.full);
  const brief = store.readBrief('2026-11-14');
  assert(brief.includes('2026-11-14'), '简报应带日期');
  assert(brief.includes('## 一、全球展望'), '简报应有全球展望');
  const items = store.readItems('2026-11-14');
  assert(items.every((item) => item.id && item.sha256), '每条都要有 id 与 sha256');
  assert(fs.existsSync(path.join(dir, '2026-11-14', 'text')), 'text 目录应存在');
  // 同一天再跑一次不重复
  const again = await runCollect({ date: '2026-11-14', http, store, config, sourceIds: ['wsj-markets'], force: true });
  assert(again.totals.items === manifest.totals.items, '重复采集不应增加条目');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 7. 模式准入 ----------
check('gate: 只有 research 放行，判不出就藏', () => {
  resetPresetSources();
  const gate = makePresetGate(['research'], { onUnknown: 'hide' });
  equal(gate({ agent: { agentPreset: 'research' } }), true, 'research 应放行');
  equal(gate({ agent: { agentPreset: 'roleplay' } }), false, 'roleplay 应拦');
  equal(gate({ agent: { session: { projectionValues: { agentPreset: 'research' } } } }), true, '快照路径应命中');
  equal(gate({ agent: {} }), false, '判不出应 hide');
  const failOpen = makePresetGate(['research'], { onUnknown: 'show' });
  equal(failOpen({ agent: {} }), true, 'onUnknown=show 时应放行');
});

// ---------- 汇总 ----------
const passed = results.filter((row) => row.ok).length;
const failed = results.filter((row) => !row.ok);
fs.mkdirSync(path.join(process.cwd(), '_tmp'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), '_tmp', 'econ-news-test.json'), JSON.stringify({ passed, total: results.length, results }, null, 2), 'utf8');
console.log(`\n${passed}/${results.length} PASS`);
for (const row of failed) console.log(`  FAIL ${row.name}: ${row.error}`);
process.exitCode = failed.length ? 1 : 0;
