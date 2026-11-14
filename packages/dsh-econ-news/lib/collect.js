/**
 * 采集编排：源级并发 → 条目落盘 → manifest → 简报 → 索引 → 状态。
 *
 * 三条硬约定：
 *   1. 永不为「拿不到」编内容：拿不到就写缺口。
 *   2. 单日预算（dailyBudgetMs）用完就停，剩余源记进 manifest.skipped。
 *   3. 同日重复跑不重复写（id = sha256(source|url|title) 前 16 位）。
 */
import { SOURCES, sourcesById, fetchSource, ZONE_ORDER } from './sources.js';
import { extractArticle } from './html.js';
import { itemId, sha256 } from './store.js';
import { buildBrief, buildSourcesTable } from './brief.js';

function todayString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function stripForStore(item) {
  const { bodyText, rawBody, ...rest } = item;
  return { rest, bodyText: bodyText || '', rawBody: rawBody || '' };
}

/** 手动投喂：给 URL 就抓，抽不出正文也保留链接与原因。 */
async function collectManual(urls, deps) {
  const items = [];
  for (const url of urls) {
    const res = await deps.http.get(url, { channels: ['node_direct', 'proxy', 'host_web'] });
    if (!res.ok) {
      items.push({ title: url, url, summary: '', publishedAt: '', author: '', bodyStatus: 'failed', bodyText: '', rawBody: '', fetchError: `HTTP_${res.status || 'FAIL'}`, zone: 'media' });
      continue;
    }
    const extracted = extractArticle(res.text, { minChars: 200 });
    items.push({
      title: extracted.text ? extracted.text.slice(0, 60) : url,
      url,
      summary: extracted.text.slice(0, 400),
      publishedAt: '',
      author: 'manual',
      bodyStatus: extracted.text ? 'full' : 'failed',
      bodyText: extracted.text,
      rawBody: res.text,
      bodyHow: extracted.how,
      fetchError: extracted.text ? '' : extracted.reason || 'EXTRACT_EMPTY',
      zone: 'media',
    });
  }
  return { ok: items.some((row) => row.bodyStatus === 'full'), items, channel: 'manual', error: items.length ? '' : 'NO_URLS', attempts: [] };
}

/**
 * @param {object} deps
 * @param {string}   [deps.date]       YYYY-MM-DD，默认今天（Asia/Shanghai）
 * @param {object}   deps.http         createHttp() 的实例
 * @param {object}   deps.store        createStore() 的实例
 * @param {object}   deps.config       配置
 * @param {string[]} [deps.sourceIds]  只跑这些源
 * @param {string[]} [deps.urls]       手动投喂
 * @param {boolean}  [deps.force]
 * @param {Function} [deps.log]
 */
export async function runCollect(deps) {
  const date = deps.date || todayString();
  const { http, store, config } = deps;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const sourceIds = Array.isArray(deps.sourceIds) ? deps.sourceIds : [];
  const urls = Array.isArray(deps.urls) ? deps.urls.filter((u) => /^https?:\/\//i.test(String(u))) : [];
  const force = Boolean(deps.force);

  const state = store.readState();
  if (!force && !sourceIds.length && !urls.length && state.lastRunDate === date) {
    return { skipped: true, reason: 'ALREADY_RAN_TODAY', date, manifest: store.readManifest(date) };
  }

  store.ensureDay(date);
  const startedAt = Date.now();
  const budgetMs = Number(config.dailyBudgetMs) > 0 ? Number(config.dailyBudgetMs) : 180000;
  const deadline = startedAt + budgetMs;
  const disabled = new Set((config.disabledSources || []).map(String));
  const sources = sourcesById(sourceIds).filter((source) => !disabled.has(source.id));
  const concurrency = Math.max(1, Math.min(8, Number(config.concurrency) || 4));

  const perSource = [];
  const skipped = [];
  const queue = [...sources];

  async function worker() {
    for (;;) {
      if (Date.now() > deadline) {
        const rest = queue.splice(0, queue.length);
        for (const source of rest) skipped.push({ id: source.id, reason: 'BUDGET_EXCEEDED' });
        return;
      }
      const source = queue.shift();
      if (!source) return;
      const t0 = Date.now();
      const result = await fetchSource(source, { http, config, log });
      perSource.push({
        id: source.id,
        label: source.label,
        zone: source.zone,
        kind: source.kind,
        ok: result.ok,
        items: result.items.length,
        channel: result.channel,
        error: result.error,
        attempts: result.attempts,
        ms: Date.now() - t0,
        optional: Boolean(source.optional),
        note: source.note || '',
        raw: result,
      });
      log(`[econ-news] ${source.id} ${result.ok ? 'ok' : 'fail'} items=${result.items.length} ch=${result.channel || '-'} ${Date.now() - t0}ms`);
    }
  }

  if (urls.length) {
    const manual = await collectManual(urls, { http, store, config, log });
    perSource.push({ id: 'manual', label: '手动投喂', zone: 'media', kind: 'manual', ok: manual.ok, items: manual.items.length, channel: manual.channel, error: manual.error, attempts: [], ms: 0, optional: false, note: '', raw: manual });
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // ---- 落盘 ----
  const collected = [];
  for (const row of perSource) {
    for (const item of row.raw.items || []) {
      const id = itemId(row.id, item.url, item.title);
      const bodyText = item.bodyText || '';
      const rawBody = item.rawBody || '';
      const record = {
        id,
        source: row.id,
        sourceLabel: row.label,
        zone: item.zone || row.zone,
        title: String(item.title || '').slice(0, 200),
        url: item.url || '',
        publishedAt: item.publishedAt || '',
        author: item.author || '',
        summary: String(item.summary || '').slice(0, 1200),
        bodyStatus: item.bodyStatus || 'summary',
        bodyChars: bodyText.length,
        bodyHow: item.bodyHow || '',
        channel: item.channel || row.channel || '',
        fetchedAt: new Date().toISOString(),
        fetchError: item.fetchError || '',
        sha256: sha256(`${row.id}|${item.url}|${item.title}|${bodyText.slice(0, 2000)}`),
        rawPath: '',
        textPath: '',
      };
      if (rawBody) record.rawPath = store.saveRaw(date, id, rawBody);
      if (bodyText) record.textPath = store.saveText(date, id, bodyText);
      collected.push(record);
    }
  }

  const { added, skipped: dupSkipped } = store.appendItems(date, collected);
  const allItems = store.readItems(date);

  // ---- 账本 ----
  const totals = { items: allItems.length, full: 0, summary: 0, withheld: 0, failed: 0 };
  for (const item of allItems) {
    if (item.bodyStatus === 'full') totals.full += 1;
    else if (item.bodyStatus === 'summary') totals.summary += 1;
    else if (item.bodyStatus === 'withheld') totals.withheld += 1;
    else totals.failed += 1;
  }

  const gaps = [];
  for (const row of perSource) {
    if (row.ok) continue;
    const tail = row.optional ? '（可配 proxy 或 cookie 后重试）' : '';
    gaps.push(`${row.label}：${row.error || '未知错误'}${tail}`);
  }
  for (const row of skipped) gaps.push(`${row.id}：预算用尽未采（${row.reason}）`);

  const byZone = {};
  for (const zone of ZONE_ORDER) {
    byZone[zone] = allItems.filter((item) => item.zone === zone).length;
  }

  const manifest = {
    date,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sourceCount: perSource.length,
    sources: perSource.map(({ raw, ...rest }) => ({ ...rest, raw: undefined, sampleError: rest.error || undefined })),
    skipped,
    totals,
    byZone,
    added,
    duplicates: dupSkipped,
    gaps,
    mode: deps.force ? 'force' : 'daily',
    hostWeb: Boolean(http.hasHostWeb),
    proxy: http.proxy ? 'configured' : '',
  };
  store.writeManifest(date, manifest);

  const brief = buildBrief({ date, items: allItems, manifest });
  store.writeBrief(date, brief, buildSourcesTable(date, allItems));
  store.updateIndex(date, { items: totals.items, full: totals.full, summary: totals.summary, gaps: gaps.length, durationMs: manifest.durationMs });
  store.writeState({ lastRunDate: date, lastResult: gaps.length ? 'partial' : 'ok', lastError: '', retryCount: 0 });

  return { skipped: false, date, manifest, totals, gaps, briefPath: `${store.dayDir(date)}\\brief.md` };
}

export { todayString, SOURCES };
