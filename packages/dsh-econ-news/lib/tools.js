/**
 * 五个工具。全部只读本插件数据目录；唯一的写操作是 collect（写当日存档）。
 *
 * 参数与返回都做了收敛：read 强制分页（单次 ≤ 6000 字符），避免把十几万字的
 * IMF 全文一次灌进上下文（历史实测：read 类工具占工具 token 的 44%）。
 */
import { runCollect, todayString } from './collect.js';
import { SOURCES, ZONE_ORDER, ZONE_LABELS } from './sources.js';

const STATUS_LABEL = { full: '全文', summary: '摘要', withheld: '被拦', failed: '失败' };

function fmtItemLine(item, index) {
  const parts = [
    `${index + 1}. ${item.title || '（无标题）'}`,
    `   ${item.sourceLabel || item.source} · ${item.zone} · ${STATUS_LABEL[item.bodyStatus] || item.bodyStatus} ${item.bodyChars || 0}字`,
    item.url ? `   ${item.url}` : '',
    `   id ${item.id}${item.publishedAt ? ' · ' + String(item.publishedAt).slice(0, 16) : ''}`,
  ];
  return parts.filter(Boolean).join('\n');
}

export function createTools(deps) {
  const { config, store, http, log } = deps;
  const now = deps.now || (() => new Date());

  function resolveDate(input) {
    const raw = String(input || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return todayString(now());
  }

  /** ---------- econ_news_collect ---------- */
  const collect = {
    name: 'econ_news_collect',
    description:
      '采集经济新闻：IMF 世界经济展望、WSJ、FT、中美经济部门政策、经济学研究成果。默认抓今天、跑全部源；也可只跑指定源，或用 urls 手工投喂文章链接（FT/WSJ 正文抓不到时的兜底）。同一天重复调用不会重复落盘。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天（Asia/Shanghai）' },
        sources: { type: 'array', items: { type: 'string' }, description: '只跑这些源 id，如 ["imf-weo","pboc"]；省略=全部' },
        force: { type: 'boolean', description: '当天已采过也重跑（默认 false）' },
        urls: { type: 'array', items: { type: 'string' }, description: '手动投喂的文章链接，会抓正文并入当日库' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
          totals: { type: 'object' },
          gaps: { type: 'array' },
          briefPath: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.skipped) {
          return [{ type: 'text', text: `${value.date} 已采集过（${value.reason}）。要重跑请加 force: true。` }];
        }
        const totals = value?.totals || {};
        const lines = [
          `采集完成 ${value.date}：共 ${totals.items ?? 0} 条（全文 ${totals.full ?? 0} / 摘要 ${totals.summary ?? 0} / 被拦 ${totals.withheld ?? 0} / 失败 ${totals.failed ?? 0}）`,
          `简报：${value.briefPath}`,
        ];
        const gaps = value?.gaps || [];
        if (gaps.length) {
          lines.push(`缺口 ${gaps.length} 项：`);
          for (const gap of gaps.slice(0, 8)) lines.push('  - ' + gap);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 200000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const result = await runCollect({
        date: resolveDate(args?.date),
        http,
        store,
        config,
        log,
        sourceIds: Array.isArray(args?.sources) ? args.sources : [],
        urls: Array.isArray(args?.urls) ? args.urls : [],
        force: Boolean(args?.force),
      });
      if (result.skipped) return { date: result.date, skipped: true, reason: result.reason };
      return {
        date: result.date,
        skipped: false,
        totals: result.totals,
        gaps: result.gaps,
        briefPath: result.briefPath,
      };
    },
  };

  /** ---------- econ_news_brief ---------- */
  const brief = {
    name: 'econ_news_brief',
    description: '取某一日的经济简报（默认今天）。简报分五个区：全球展望 / 美国 / 中国 / 市场与媒体 / 学术，末尾附本期缺口与替代。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        format: { type: 'string', enum: ['md', 'json'], description: 'md=简报正文（默认），json=账本摘要' },
      },
    },
    output: {
      schema: { type: 'object', properties: { date: { type: 'string' }, text: { type: 'string' }, manifest: { type: 'object' } } },
      render: (_args, value) => [{ type: 'text', text: value?.text || '该日还没有简报，先跑 econ_news_collect。' }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const date = resolveDate(args?.date);
      const manifest = store.readManifest(date);
      if (args?.format === 'json') {
        return {
          date,
          text: JSON.stringify({ date, totals: manifest?.totals || {}, gaps: manifest?.gaps || [], sources: (manifest?.sources || []).map((s) => ({ id: s.id, ok: s.ok, items: s.items, error: s.error })) }, null, 2),
          manifest: manifest || {},
        };
      }
      const text = store.readBrief(date);
      return { date, text: text || '', manifest: manifest || {} };
    },
  };

  /** ---------- econ_news_list ---------- */
  const list = {
    name: 'econ_news_list',
    description: '列某一日采集到的条目（源 / 标题 / 区 / 正文状态 / 字数 / id），可按 zone 过滤。用 econ_news_read 取某条原文。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        zone: { type: 'string', enum: ZONE_ORDER, description: '只列这个区' },
        limit: { type: 'number', description: '最多几条，默认 40' },
      },
    },
    output: {
      schema: { type: 'object', properties: { date: { type: 'string' }, total: { type: 'number' }, items: { type: 'array' } } },
      render: (_args, value) => {
        if (!value?.items?.length) return [{ type: 'text', text: `${value?.date || ''} 没有条目。先跑 econ_news_collect。` }];
        const head = `${value.date}：${value.total} 条${value.total > value.items.length ? `（显示前 ${value.items.length} 条）` : ''}`;
        return [{ type: 'text', text: [head, ...value.items.map((item, i) => fmtItemLine(item, i))].join('\n') }];
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const date = resolveDate(args?.date);
      const limit = Math.max(1, Math.min(200, Number(args?.limit) || 40));
      let items = store.readItems(date);
      if (args?.zone) items = items.filter((item) => item.zone === args.zone);
      const total = items.length;
      return {
        date,
        total,
        items: items.slice(0, limit).map((item) => ({
          id: item.id,
          title: item.title,
          source: item.source,
          sourceLabel: item.sourceLabel,
          zone: item.zone,
          bodyStatus: item.bodyStatus,
          bodyChars: item.bodyChars,
          url: item.url,
          publishedAt: item.publishedAt,
        })),
      };
    },
  };

  /** ---------- econ_news_read ---------- */
  const read = {
    name: 'econ_news_read',
    description:
      '读某条新闻的原文全文（落盘后的提取文本），强制分页：单次最多 6000 字符，用 offset 继续往后读。摘要级的条目（WSJ）只有 RSS 摘要，会明确告知。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id（econ_news_list 里的 id）' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        offset: { type: 'number', description: '起始字符偏移，默认 0' },
        limit: { type: 'number', description: '本次最多返回多少字符，默认 6000，上限 12000' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, total: { type: 'number' }, nextOffset: { type: 'number' } } },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }];
        const head = [
          `${value.title || ''}`,
          `${value.sourceLabel || value.source} · ${value.bodyStatus} · 共 ${value.total} 字 · 本次 ${value.text.length} 字（offset ${value.offset}${value.nextOffset ? ` → 用 offset ${value.nextOffset} 继续` : '，已到末尾'}）`,
          value.url ? value.url : '',
          '',
        ]
          .filter(Boolean)
          .join('\n');
        return [{ type: 'text', text: head + '\n' + value.text }];
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const date = resolveDate(args?.date);
      const id = String(args?.id || '').trim();
      if (!id) return { error: '要给 id（用 econ_news_list 拿）' };
      const items = store.readItems(date);
      const item = items.find((row) => row.id === id);
      if (!item) return { error: `${date} 里没有 id=${id} 的条目` };
      const text = store.readText(date, id) || item.summary || '';
      if (!text) {
        return { error: `id=${id} 没有落盘正文（状态 ${item.bodyStatus}${item.fetchError ? '，' + item.fetchError : ''}），原文见 raw/${id}.html` };
      }
      const offset = Math.max(0, Number(args?.offset) || 0);
      const limit = Math.max(200, Math.min(12000, Number(args?.limit) || 6000));
      const slice = text.slice(offset, offset + limit);
      return {
        id,
        title: item.title,
        source: item.source,
        sourceLabel: item.sourceLabel,
        bodyStatus: item.bodyStatus,
        url: item.url,
        total: text.length,
        offset,
        nextOffset: offset + slice.length < text.length ? offset + slice.length : 0,
        text: slice,
      };
    },
  };

  /** ---------- econ_news_status ---------- */
  const status = {
    name: 'econ_news_status',
    description: '看采集状态：今天采过没、下次自动采集时间、各源最近一次成败与通道、通道冷却情况、数据目录与天数。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { date: { type: 'string' }, state: { type: 'object' }, sources: { type: 'array' } } },
      render: (_args, value) => {
        const lines = [`今天 ${value.date} ｜ lastRun ${value.state.lastRunDate || '从未'} ｜ 结果 ${value.state.lastResult || '-'} ｜ 数据目录 ${value.dataDir}`];
        lines.push(`自动采集 ${value.autoCollect ? `开（启动后 ${Math.round(value.autoDelayMs / 1000)}s 检查）` : '关'} ｜ 最近天数 ${value.days} ｜ 宿主导入通道 ${value.hostWeb ? '可用' : '不可用'} ｜ 代理 ${value.proxy ? '已配' : '未配'}`);
        if (value.lastManifest) {
          const totals = value.lastManifest.totals || {};
          lines.push(`最近一次 ${value.lastManifest.date}：${totals.items ?? 0} 条（全文 ${totals.full ?? 0} / 摘要 ${totals.summary ?? 0} / 失败 ${totals.failed ?? 0}），缺口 ${(value.lastManifest.gaps || []).length}`);
        }
        lines.push('源状态：');
        for (const row of value.sources || []) {
          lines.push(`  ${row.ok ? '✓' : '✗'} ${row.id.padEnd(14)} ${row.items} 条  ${row.channel || '-'}  ${row.error || ''}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const date = todayString(now());
      const state = store.readState();
      const lastManifest = store.readManifest(state.lastRunDate || date) || store.readManifest(date);
      return {
        date,
        dataDir: store.root,
        state,
        autoCollect: config.autoCollect !== false,
        autoDelayMs: Number(config.autoDelayMs) || 20000,
        days: store.listDays().length,
        hostWeb: Boolean(http.hasHostWeb),
        proxy: http.proxy || '',
        lastManifest: lastManifest || null,
        sources: (lastManifest?.sources || []).map((row) => ({ id: row.id, ok: row.ok, items: row.items, channel: row.channel, error: row.error })),
        catalog: SOURCES.map((source) => ({ id: source.id, zone: source.zone, label: source.label, kind: source.kind, optional: Boolean(source.optional) })),
        zoneLabels: ZONE_LABELS,
      };
    },
  };

  return [collect, brief, list, read, status];
}
