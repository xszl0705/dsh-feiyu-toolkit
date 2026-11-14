/**
 * 源表（主链 + 备案链）+ 每类源的取法。
 *
 * 源分四种 kind：
 *   rss         → parseFeed（RSS 2.0 / Atom 都吃）
 *   atom        → 同上，只是 arXiv 用 API 端点
 *   html-list   → 列表页取链接，再逐条抓正文
 *   imf-bundle  → IMF 报告页自带 index.md 全文（只有宿主通道可取）
 *   dbnomics    → IMF 预测数据（绕开 imf.org 的 403）
 *   wscn        → 华尔街见闻快讯 API（FT/WSJ 断档时的资讯替代）
 *
 * 每个源带 `channel` 建议：`node_direct`（默认）/ `host_web`（被 WAF 拦的）/ `proxy`（需代理的）。
 * 通道只是建议，失败会按 http 层的链继续降级。
 */
import { parseFeed, cleanSummary } from './rss.js';
import { extractArticle, listLinks, looksLikeArticle } from './html.js';

const DOW = 'https://feeds.a.dj.com/rss';
const PBC_LIST = 'http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html';
const MOF_LIST = 'http://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/';
const STATS_LIST = 'https://www.stats.gov.cn/sj/zxfb/';
const MOFCOM_LIST = 'http://www.mofcom.gov.cn/xwfb/rcxwfb/index.html';
const GOV_LIST = 'https://www.gov.cn/yaowen/liebiao/';

export const SOURCES = [
  // ---------------- 全球展望 ----------------
  {
    id: 'imf-weo',
    zone: 'global_outlook',
    label: 'IMF 世界经济展望',
    kind: 'imf-bundle',
    channel: 'host_web',
    url: 'https://www.imf.org/en/Publications/WEO',
    include: '/en/publications/weo/issues/20\\d\\d/',
    limit: 3,
    needsBody: true,
    note: 'node 直连 403（Akamai），只有宿主 ctx.web 能过；报告页自带 index.md 全文',
  },
  {
    id: 'imf-dbnomics',
    zone: 'global_outlook',
    label: 'IMF WEO 预测数据（DBnomics）',
    kind: 'dbnomics',
    channel: 'node_direct',
    dataset: 'IMF/WEO:2025-04',
    series: [
      { key: 'CHN.NGDP_RPCH', label: '中国实际 GDP 增速' },
      { key: 'USA.NGDP_RPCH', label: '美国实际 GDP 增速' },
      { key: 'WLD.NGDP_RPCH', label: '全球实际 GDP 增速' },
    ],
    note: 'imf.org 取不到时的数据层备案，实测 200',
  },

  // ---------------- 媒体 ----------------
  { id: 'wsj-world', zone: 'media', label: 'WSJ 国际', kind: 'rss', channel: 'node_direct', url: `${DOW}/RSSWorldNews.xml`, limit: 20 },
  { id: 'wsj-markets', zone: 'media', label: 'WSJ 市场', kind: 'rss', channel: 'node_direct', url: `${DOW}/RSSMarketsMain.xml`, limit: 20 },
  { id: 'wsj-usbiz', zone: 'media', label: 'WSJ 美国商业', kind: 'rss', channel: 'node_direct', url: `${DOW}/WSJcomUSBusiness.xml`, limit: 20 },
  { id: 'wsj-opinion', zone: 'media', label: 'WSJ 评论', kind: 'rss', channel: 'node_direct', url: `${DOW}/RSSOpinion.xml`, limit: 15 },
  { id: 'wsj-tech', zone: 'media', label: 'WSJ 科技', kind: 'rss', channel: 'node_direct', url: `${DOW}/RSSWSJD.xml`, limit: 20 },
  {
    id: 'ft-home',
    zone: 'media',
    label: 'FT 首页',
    kind: 'rss',
    channel: 'proxy',
    url: 'https://www.ft.com/rss/home',
    limit: 20,
    optional: true,
    note: '本机 node 与宿主均不可达（ECONNRESET/超时），仅在配置 proxy 或 cookie 后可用',
  },
  {
    id: 'ft-world',
    zone: 'media',
    label: 'FT 国际',
    kind: 'rss',
    channel: 'proxy',
    url: 'https://www.ft.com/rss/world',
    limit: 20,
    optional: true,
  },
  {
    id: 'wscn-global',
    zone: 'media',
    label: '华尔街见闻 国际快讯（FT/WSJ 备案）',
    kind: 'wscn',
    channel: 'node_direct',
    url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=20',
    limit: 20,
    note: '实测 200，含路透署名，作为 FT/WSJ 断档时的资讯替代',
  },

  // ---------------- 美国政策 ----------------
  { id: 'fed-press', zone: 'us_policy', label: '美联储 全部新闻稿', kind: 'rss', channel: 'node_direct', url: 'https://www.federalreserve.gov/feeds/press_all.xml', limit: 20 },
  { id: 'fed-monetary', zone: 'us_policy', label: '美联储 货币政策', kind: 'rss', channel: 'node_direct', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', limit: 15 },
  { id: 'fed-speeches', zone: 'us_policy', label: '美联储 讲话', kind: 'rss', channel: 'node_direct', url: 'https://www.federalreserve.gov/feeds/speeches.xml', limit: 15 },
  { id: 'bea', zone: 'us_policy', label: '美国经济分析局', kind: 'rss', channel: 'node_direct', url: 'https://apps.bea.gov/rss/rss.xml', limit: 20 },
  { id: 'ustr', zone: 'us_policy', label: '美国贸易代表办公室', kind: 'rss', channel: 'node_direct', url: 'https://ustr.gov/rss.xml', limit: 10 },

  // ---------------- 中国政策 ----------------
  {
    id: 'pboc',
    zone: 'cn_policy',
    label: '中国人民银行 新闻发布',
    kind: 'html-list',
    channel: 'node_direct',
    url: PBC_LIST,
    include: '/goutongjiaoliu/113456/113469/20\\d{13}/index\\.html',
    articlePatterns: ['<div[^>]*id="zoom"[^>]*>([\\s\\S]*?)</div>'],
    limit: 8,
    needsBody: true,
  },
  {
    id: 'mof',
    zone: 'cn_policy',
    label: '财政部 财政新闻',
    kind: 'html-list',
    channel: 'node_direct',
    url: MOF_LIST,
    include: '/caizhengxinwen/20\\d{4}/t20\\d{6}_\\d+\\.(?:htm|html)',
    articlePatterns: ['<div[^>]*class="[^"]*TRS_Editor[^"]*"[^>]*>([\\s\\S]*?)</div>'],
    limit: 8,
    needsBody: true,
  },
  {
    id: 'stats',
    zone: 'cn_policy',
    label: '国家统计局 数据发布',
    kind: 'html-list',
    channel: 'node_direct',
    url: STATS_LIST,
    include: '/sj/zxfb/20\\d{4}/t20\\d{6}_\\d+\\.html',
    articlePatterns: [
      '<div[^>]*class="[^"]*detail-content[^"]*"[^>]*>([\\s\\S]*?)</div>',
      '<div[^>]*id="mainText"[^>]*>([\\s\\S]*?)</div>',
      '<div[^>]*class="[^"]*TRS_Editor[^"]*"[^>]*>([\\s\\S]*?)</div>',
    ],
    limit: 8,
    needsBody: true,
  },
  {
    id: 'mofcom',
    zone: 'cn_policy',
    label: '商务部 日常新闻发布',
    kind: 'html-list',
    channel: 'node_direct',
    url: MOFCOM_LIST,
    include: 'xwfb/',
    exclude: 'index\\.html$|/xwfb/?$',
    articlePatterns: ['<div[^>]*class="[^"]*(?:artCon|TRS_Editor|content)[^"]*"[^>]*>([\\s\\S]*?)</div>'],
    limit: 6,
    needsBody: true,
  },
  {
    id: 'gov-yaowen',
    zone: 'cn_policy',
    label: '中国政府网 要闻',
    kind: 'html-list',
    channel: 'node_direct',
    url: GOV_LIST,
    include: '/yaowen/',
    exclude: 'liebiao|index',
    articlePatterns: [
      '<div[^>]*id="UCAP-CONTENT"[^>]*>([\\s\\S]*?)</div>',
      '<div[^>]*class="[^"]*pages_content[^"]*"[^>]*>([\\s\\S]*?)</div>',
    ],
    limit: 8,
    needsBody: true,
  },

  // ---------------- 学术与央行研究 ----------------
  { id: 'nber', zone: 'research', label: 'NBER 工作论文', kind: 'rss', channel: 'node_direct', url: 'https://www.nber.org/rss/new.xml', limit: 12 },
  {
    id: 'arxiv-econ',
    zone: 'research',
    label: 'arXiv 经济学（econ.GN）',
    kind: 'atom',
    channel: 'node_direct',
    url: 'https://export.arxiv.org/api/query?search_query=cat:econ.GN&sortBy=submittedDate&sortOrder=descending&max_results=12',
    limit: 12,
  },
  { id: 'ecb', zone: 'research', label: '欧洲央行 新闻与讲话', kind: 'rss', channel: 'node_direct', url: 'https://www.ecb.europa.eu/rss/press.html', limit: 15 },
];

export const ZONE_LABELS = {
  global_outlook: '一、全球展望（IMF）',
  us_policy: '二、美国政策与数据',
  cn_policy: '三、中国政策与数据',
  media: '四、市场与媒体（WSJ / FT）',
  research: '五、学术与央行研究',
};

export const ZONE_ORDER = ['global_outlook', 'us_policy', 'cn_policy', 'media', 'research'];

export function sourcesById(ids) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!set.size) return SOURCES;
  return SOURCES.filter((source) => set.has(source.id));
}

function normalizeRssItems(items) {
  return items.map((item) => ({
    title: item.title,
    url: item.link,
    summary: cleanSummary(item.summary).slice(0, 800),
    publishedAt: item.publishedAt,
    author: item.author,
    bodyStatus: 'summary',
  }));
}

async function fetchRss(source, deps) {
  const res = await deps.http.get(source.url, { channels: [source.channel, 'node_direct'], headers: source.headers });
  if (!res.ok) return { ok: false, items: [], channel: res.channel, error: `HTTP_${res.status || 'FAIL'}`, attempts: res.attempts };
  const feed = parseFeed(res.text);
  if (!feed.ok) return { ok: false, items: [], channel: res.channel, error: feed.error, attempts: res.attempts };
  const items = normalizeRssItems(feed.items).slice(0, source.limit || 20);
  return { ok: items.length > 0, items, channel: res.channel, error: items.length ? '' : 'NO_ITEMS', attempts: res.attempts };
}

async function fetchHtmlList(source, deps) {
  const list = await deps.http.get(source.url, { channels: [source.channel, 'node_direct'], headers: source.headers });
  if (!list.ok) return { ok: false, items: [], channel: list.channel, error: `LIST_HTTP_${list.status || 'FAIL'}`, attempts: list.attempts };
  let links = listLinks(list.text, {
    baseUrl: source.url,
    include: source.include,
    exclude: source.exclude,
    limit: (source.limit || 8) * 2,
  });
  if (!links.length) {
    links = listLinks(list.text, { baseUrl: source.url, exclude: source.exclude, limit: (source.limit || 8) * 2 }).filter((row) =>
      looksLikeArticle(row.url),
    );
  }
  links = links.slice(0, source.limit || 8);
  if (!links.length) return { ok: false, items: [], channel: list.channel, error: 'NO_LINKS', attempts: list.attempts };

  const items = [];
  for (const link of links) {
    const article = await deps.http.get(link.url, { channels: [source.channel, 'node_direct'], headers: source.headers });
    if (!article.ok) {
      items.push({ title: link.text, url: link.url, summary: '', publishedAt: '', author: '', bodyStatus: 'failed', bodyText: '', fetchError: `HTTP_${article.status || 'FAIL'}` });
      continue;
    }
    const extracted = extractArticle(article.text, { patterns: source.articlePatterns, minChars: 200 });
    items.push({
      title: link.text,
      url: link.url,
      summary: extracted.text.slice(0, 400),
      publishedAt: '',
      author: '',
      bodyStatus: extracted.text ? 'full' : 'failed',
      bodyText: extracted.text,
      bodyHow: extracted.how,
      fetchError: extracted.text ? '' : extracted.reason || 'EXTRACT_EMPTY',
    });
  }
  return { ok: items.some((item) => item.bodyStatus === 'full'), items, channel: list.channel, error: '', attempts: list.attempts };
}

/** IMF：列表页 → 每期报告页 → 该页的 index.md（Markdown 全文）。 */
async function fetchImfBundle(source, deps) {
  const list = await deps.http.get(source.url, { channels: ['host_web', 'node_direct'] });
  if (!list.ok) return { ok: false, items: [], channel: list.channel, error: `LIST_HTTP_${list.status || 'FAIL'}`, attempts: list.attempts };

  const links = listLinks(list.text, { baseUrl: source.url, include: source.include, limit: source.limit || 3 });
  if (!links.length) return { ok: false, items: [], channel: list.channel, error: 'NO_LINKS', attempts: list.attempts };

  const items = [];
  for (const link of links) {
    const mdUrl = link.url.replace(/\/+$/, '') + '/index.md';
    const md = await deps.http.get(mdUrl, { channels: ['host_web', 'node_direct'] });
    const raw = await deps.http.get(link.url, { channels: ['host_web', 'node_direct'] });
    const body = md.ok && md.text.trim().length > 200 ? md.text : raw.ok ? extractArticle(raw.text, { minChars: 200 }).text : '';
    items.push({
      title: link.text,
      url: link.url,
      summary: body ? body.replace(/\s+/g, ' ').slice(0, 400) : '',
      publishedAt: '',
      author: 'IMF',
      bodyStatus: body ? 'full' : 'failed',
      bodyText: body,
      bodyHow: md.ok ? 'markdown' : 'html',
      fetchError: body ? '' : 'IMF_BODY_EMPTY',
      rawBody: md.ok ? md.text : raw.ok ? raw.text : '',
    });
  }
  return { ok: items.some((item) => item.bodyStatus === 'full'), items, channel: list.channel, error: '', attempts: list.attempts };
}

/** DBnomics：一个数据条目，body 写成人能读的几行。 */
async function fetchDbnomics(source, deps) {
  const lines = [];
  const items = [];
  for (const series of source.series || []) {
    const url = `https://api.db.nomics.world/v22/series/${source.dataset}/${series.key}?observations=1`;
    const res = await deps.http.get(url, { channels: ['node_direct'], headers: { accept: 'application/json' } });
    if (!res.ok) {
      lines.push(`- ${series.label}（${series.key}）：取数失败 HTTP ${res.status || 'FAIL'}`);
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      lines.push(`- ${series.label}（${series.key}）：返回不是 JSON`);
      continue;
    }
    const doc = json?.series?.docs?.[0];
    const periods = doc?.period || [];
    const values = doc?.value || [];
    const tail = periods.map((p, i) => `${p}: ${values[i]}`).slice(-4);
    const body = [`数据集 ${source.dataset} · ${series.label}（${series.key}）`, ...tail.map((row) => `- ${row}`)].join('\n');
    items.push({
      title: `${series.label}：${tail.join('，')}`,
      url,
      summary: body,
      publishedAt: '',
      author: 'IMF / DBnomics',
      bodyStatus: 'full',
      bodyText: body,
      bodyHow: 'json',
    });
  }
  if (!items.length) return { ok: false, items: [], channel: 'node_direct', error: 'DBNOMICS_EMPTY', attempts: [] };
  return { ok: true, items, channel: 'node_direct', error: '', attempts: [] };
}

/** 华尔街见闻快讯：字段 content_text / display_time / id。 */
async function fetchWscn(source, deps) {
  const res = await deps.http.get(source.url, { channels: ['node_direct'], headers: { accept: 'application/json' } });
  if (!res.ok) return { ok: false, items: [], channel: res.channel, error: `HTTP_${res.status || 'FAIL'}`, attempts: res.attempts };
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { ok: false, items: [], channel: res.channel, error: 'NOT_JSON', attempts: res.attempts };
  }
  const raw = json?.data?.items || json?.data?.data || json?.items || [];
  const items = raw.slice(0, source.limit || 20).map((row) => {
    const text = String(row.content_text || row.content || row.title || '').replace(/\s+/g, ' ').trim();
    const ts = Number(row.display_time || row.created_at || 0);
    return {
      title: text.slice(0, 60),
      url: String(row.uri || row.url || '') || `wscn://live/${row.id ?? ''}`,
      summary: text.slice(0, 800),
      publishedAt: ts ? new Date(ts * 1000).toISOString() : '',
      author: '华尔街见闻',
      bodyStatus: text.length > 120 ? 'full' : 'summary',
      bodyText: text.length > 120 ? text : '',
      bodyHow: 'api',
    };
  });
  return { ok: items.length > 0, items, channel: res.channel, error: items.length ? '' : 'NO_ITEMS', attempts: res.attempts };
}

const ADAPTERS = {
  rss: fetchRss,
  atom: fetchRss,
  'html-list': fetchHtmlList,
  'imf-bundle': fetchImfBundle,
  dbnomics: fetchDbnomics,
  wscn: fetchWscn,
};

/**
 * 取一个源。永远 resolve，不抛——失败信息进 error 字段。
 * @returns {Promise<{ ok:boolean, items:Array, channel:string, error:string, attempts:Array }>}
 */
export async function fetchSource(source, deps) {
  const adapter = ADAPTERS[source.kind];
  if (!adapter) return { ok: false, items: [], channel: '', error: 'UNKNOWN_KIND:' + source.kind, attempts: [] };
  try {
    const result = await adapter(source, deps);
    return { ok: Boolean(result.ok), items: result.items || [], channel: result.channel || '', error: result.error || '', attempts: result.attempts || [] };
  } catch (error) {
    return { ok: false, items: [], channel: '', error: 'THROW:' + String((error && error.message) || error).slice(0, 160), attempts: [] };
  }
}
