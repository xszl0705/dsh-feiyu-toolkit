/**
 * lib/tools.js — ev_fetch / ev_extract 的工具定义
 *
 * 设计：
 *   1. 定义集中在这里，`index.js` 只负责「等 tools 服务就绪 → register」，方便离线测试
 *   2. 依赖全部可注入（fetchImpl / hostFetch / dbProvider / now），测试不联网、不碰 ~/.dsh
 *   3. 任何异常都在 execute 内落成 `{status:'ERROR'}`，绝不把异常抛回宿主
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, nowISO } from './db.js';
import { createChannel } from './channel.js';
import { decodeBody } from './decode.js';
import { extract } from './parse.js';
import { saveArtifact, loadArtifact, writeParsed } from './artifact.js';
import { extractAtoms, saveClaim } from './claim.js';
import { runSearch } from './search.js';
import { compareNumeric } from './numeric.js';
import { judgeV1, saveVerdict } from './verdict.js';
import { verifyClaim } from './verify.js';

/** ev_extract 单次返回的正文上限（字符）。原文不截断，这里只限「回给模型的那一段」 */
export const DEFAULT_EXTRACT_CHARS = 8000;

function traceIdFor(fetchedAt, url) {
  const compact = String(fetchedAt).replace(/[-:TZ]/g, '');
  const tail = createHash('sha256').update(String(url)).digest('hex').slice(0, 6);
  return `tr_${compact}_${tail}`;
}

function writeTrace(dataDir, fetchedAt, traceId, payload) {
  const path = join(dataDir, 'traces', String(fetchedAt).slice(0, 7), traceId + '.json');
  mkdirSync(join(dataDir, 'traces', String(fetchedAt).slice(0, 7)), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 1), 'utf8');
  return path;
}

function asString(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * @param {{
 *   dataDir: string,
 *   channelOrder?: string[],
 *   budget?: {deadlineMs?: number, maxPages?: number},
 *   textRawLimitBytes?: number,
 *   extractChars?: number,
 *   fetchImpl?: Function,
 *   hostFetch?: Function|null,
 *   health?: Map,
 *   dbProvider?: () => object,
 * }} deps
 * @returns {Array<object>} 工具定义（可直接喂 tools.register）
 */
export function createEvidenceTools(deps) {
  const {
    dataDir,
    channelOrder = ['host_fetch', 'node_direct'],
    budget = {},
    textRawLimitBytes = 2 * 1024 * 1024,
    extractChars = DEFAULT_EXTRACT_CHARS,
    fetchImpl = globalThis.fetch,
    hostFetch = null,
    searchImpl = null,
    health = new Map(),
    dbProvider = null,
  } = deps || {};

  const deadlineDefault = Number(budget.deadlineMs) > 0 ? Number(budget.deadlineMs) : 15000;

  let cachedDb = null;
  function getDb() {
    if (cachedDb) return cachedDb;
    cachedDb = typeof dbProvider === 'function' ? dbProvider() : openDatabase(join(dataDir, 'evidence.db'));
    return cachedDb;
  }

  /** ev_verify 用的抓取：走同一条通道降级链，并把原文落成 artifact（sha256 供证据指认） */
  async function fetchPage(url) {
    const channel = createChannel({
      fetchImpl,
      hostFetch,
      channels: channelOrder,
      health,
      now: () => Date.now(),
    });
    const fetchedAt = nowISO();
    const result = await channel.fetchWithFallback(url, { deadlineMs: deadlineDefault });
    if (!result.ok) return { ok: false, code: result.code || 'ALL_FAILED' };
    const rawBytes = result.rawBytes ?? new TextEncoder().encode(result.text ?? '');
    const parsed = extract(result.text ?? '', { target: 'article' });
    const saved = saveArtifact({
      db: getDb(),
      dataDir,
      url,
      fetchedAt,
      channel: result.channel,
      httpStatus: result.status,
      contentType: result.contentType ?? '',
      bytes: rawBytes,
      text: parsed.text,
      quality: result.quality,
      dataAsOf: fetchedAt,
      status: result.mojibake ? 'MOJIBAKE' : 'OK',
    });
    return {
      ok: true,
      text: result.text ?? '',
      artifactId: saved.id,
      sha256: saved.sha256,
      fetchedAt,
      channel: result.channel,
      httpStatus: result.status,
      dedup: saved.dedup,
    };
  }

  const evFetch = {
    name: 'ev_fetch',
    description:
      '抓取单个 URL：走通道降级链（host_fetch → node_direct），原文落 artifact 文件、索引进 evidence.db，返回结构与质量摘要。' +
      '只负责「拿到原文并留痕」，正文抽取用 ev_extract。命中同 sha256 时不重复落盘，返回既有 artifactId 并标 dedup=true。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL（含 http/https 协议）' },
        expect: {
          type: 'string',
          enum: ['article', 'pdf', 'json', 'auto'],
          description: '声明期望的内容类型，默认 auto（按 article 处理，JSON 体自动识别）',
        },
        as_of: { type: 'string', description: '只接受 fetched_at ≤ as_of 的信息（P0 仅回填 dataAsOf，不做时间过滤）' },
        deadline_ms: { type: 'number', description: '本次抓取预算（毫秒），默认取 config.budget.deadlineMs' },
      },
      required: ['url'],
    },
    execute: async (args = {}) => {
      try {
        const url = asString(args?.url).trim();
        if (!url) return { status: 'BAD_URL', message: 'url 必填' };
        if (!/^https?:\/\//i.test(url)) return { status: 'BAD_URL', message: '只接受 http/https URL' };

        const deadlineMs = Number(args?.deadline_ms) > 0 ? Number(args.deadline_ms) : deadlineDefault;
        const channel = createChannel({
          fetchImpl,
          hostFetch,
          channels: channelOrder,
          health,
          now: () => Date.now(),
        });
        const fetchedAt = nowISO();
        const result = await channel.fetchWithFallback(url, { deadlineMs });
        const traceId = traceIdFor(fetchedAt, url);
        const trace = {
          url,
          fetchedAt,
          channels: channelOrder,
          ok: Boolean(result.ok),
          code: result.code ?? null,
          channel: result.channel ?? null,
          attempts: result.attempts || [],
        };
        let tracePath = null;
        try {
          tracePath = writeTrace(dataDir, fetchedAt, traceId, trace);
        } catch {
          tracePath = null; // trace 落盘失败不阻断主流程，返回里 traceId 仍可查
        }

        if (!result.ok) {
          return {
            status: result.code || 'ALL_FAILED',
            channel: result.channel ?? null,
            httpStatus: result.status ?? null,
            bytes: 0,
            sha256: null,
            quality: result.quality ?? null,
            dataAsOf: fetchedAt,
            traceId,
            tracePath,
            attempts: result.attempts || [],
          };
        }

        const rawBytes = result.rawBytes ?? new TextEncoder().encode(result.text ?? '');
        const parsed = extract(result.text ?? '', { target: args?.expect === 'json' ? 'json' : 'article' });
        const saved = saveArtifact({
          db: getDb(),
          dataDir,
          url,
          fetchedAt,
          channel: result.channel,
          httpStatus: result.status,
          contentType: result.contentType ?? '',
          bytes: rawBytes,
          text: parsed.text,
          quality: result.quality,
          dataAsOf: fetchedAt,
          status: result.mojibake ? 'MOJIBAKE' : 'OK',
        });

        return {
          status: 'OK',
          artifactId: saved.id,
          dedup: saved.dedup,
          channel: result.channel,
          httpStatus: result.status,
          bytes: rawBytes.length,
          sha256: saved.sha256,
          encoding: result.encoding,
          replacementChars: result.replacementChars,
          quality: result.quality,
          dataAsOf: fetchedAt,
          textChars: parsed.text.length,
          qualityFlags: parsed.qualityFlags,
          attempts: result.attempts || [],
          traceId,
          tracePath,
        };
      } catch (e) {
        return { status: 'ERROR', code: String(e?.code || e?.name || 'ERROR'), message: String(e?.message || e) };
      }
    },
  };

  const evExtract = {
    name: 'ev_extract',
    description:
      '对已有 artifact 做正文/表格/JSON 抽取：返回 text（可截断，默认 8000 字符）、tables、json、spans（可直接用于 quote 定位）与 qualityFlags。' +
      '解析结果同时落 parsed/*.json 并回填 artifacts.parsed_path。原始字节只从 artifact 读，不重新联网。',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'ev_fetch 返回的 artifactId（art_ 前缀）' },
        target: {
          type: 'string',
          enum: ['article', 'table', 'json', 'auto'],
          description: '抽取目标，默认 article',
        },
        maxChars: { type: 'number', description: '回给模型的正文上限（字符），默认 8000；超出标 TEXT_TRUNCATED' },
      },
      required: ['artifactId'],
    },
    execute: async (args = {}) => {
      try {
        const id = asString(args?.artifactId).trim();
        if (!id) return { status: 'BAD_ARGUMENT', message: 'artifactId 必填' };
        const db = getDb();
        const row = loadArtifact(db, id);
        if (!row) return { status: 'NOT_FOUND', artifactId: id };

        const bytes = readFileSync(row.raw_path);
        const decoded = decodeBody(bytes, row.content_type ?? '');
        const target = asString(args?.target) || 'article';
        const parsed = extract(decoded.text, { target: target === 'auto' ? 'article' : target });

        const capRaw = Number(args?.maxChars);
        const cap = capRaw > 0 ? Math.floor(capRaw) : extractChars;
        const flags = [...parsed.qualityFlags];
        let text = parsed.text;
        if (text.length > cap) {
          text = text.slice(0, cap);
          flags.push('TEXT_TRUNCATED');
        }
        const spans = parsed.spans.filter((s) => s.end <= text.length);

        let parsedPath = null;
        try {
          parsedPath = writeParsed({ db, dataDir, row, parsed });
        } catch {
          parsedPath = null;
        }

        return {
          status: 'OK',
          artifactId: id,
          url: row.url,
          fetchedAt: row.fetched_at,
          encoding: decoded.encoding,
          textChars: parsed.text.length,
          text,
          tables: parsed.tables,
          json: parsed.json ?? null,
          spans,
          qualityFlags: [...new Set(flags)],
          storedBytes: Number(row.bytes) || 0,
          storedLimitBytes: textRawLimitBytes,
          parsedPath,
        };
      } catch (e) {
        return { status: 'ERROR', code: String(e?.code || e?.name || 'ERROR'), message: String(e?.message || e) };
      }
    },
  };

  const evClaim = {
    name: 'ev_claim',
    description:
      '把一段声明文本拆成可证伪的原子（atoms）：每个 atom 都带原文 span（拿不到 span 直接丢弃）；' +
      '含数字的句子拆成 numeric atom（value / unit / scale / period / basis，一句三个数字就是三个 atom）；' +
      '观点 / 预测 / 规范 / 传闻进 outOfScope；缺 unit 或 basis 的 numeric 进 unverified，不静默丢。' +
      '纯规则、不调模型，同输入两次结果一致；claim 落 claims + claim_atoms，重复调用幂等。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要分解的声明文本（原样，span 落在它上面）' },
        as_of: { type: 'string', description: '信息时点，默认取当前时间；参与 claimId 计算' },
      },
      required: ['text'],
    },
    execute: async (args = {}) => {
      try {
        const text = asString(args?.text);
        if (!text.trim()) return { status: 'BAD_ARGUMENT', message: 'text 必填' };
        const asOf = asString(args?.as_of) || nowISO();
        const parsed = extractAtoms(text, { asOf });
        const saved = saveClaim({ db: getDb(), text, asOf, atoms: parsed.atoms });
        return {
          status: 'OK',
          claimId: saved.claimId,
          inserted: saved.inserted,
          asOf,
          atomCount: parsed.atoms.length,
          outOfScopeCount: parsed.outOfScope.length,
          unverifiedCount: parsed.unverified.length,
          atoms: parsed.atoms,
          outOfScope: parsed.outOfScope,
          unverified: parsed.unverified,
        };
      } catch (e) {
        return { status: 'ERROR', code: String(e?.code || e?.name || 'ERROR'), message: String(e?.message || e) };
      }
    },
  };

  const evSearch = {
    name: 'ev_search',
    description:
      '检索薄封装 + 同源归并：把 query 交给外部检索后端，返回按「同一篇稿」归并后的簇' +
      '（clusterId / level / leadOnly / members）与 coverage。' +
      '不承诺检索全面性（P0 的 saturation 恒为 unknown）；UGC 平台（雪球/股吧/微博/知乎/公众号）只作线索（leadOnly=true、等级 E）。' +
      '检索后端未接入时如实返回 SEARCH_UNAVAILABLE，不假装「搜到 0 条」。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索式' },
        limit: { type: 'number', description: '最多取几条候选，默认 8' },
      },
      required: ['query'],
    },
    execute: async (args = {}) => {
      try {
        const result = await runSearch({
          query: asString(args?.query),
          limit: Number(args?.limit) || undefined,
          searchImpl,
        });
        if (!result.ok) {
          return { status: result.code || 'SEARCH_FAILED', message: result.message ?? null };
        }
        return {
          status: 'OK',
          query: result.query,
          candidateCount: result.candidates.length,
          clusterCount: result.clusters.length,
          clusters: result.clusters,
          candidates: result.candidates,
          coverage: result.coverage,
        };
      } catch (e) {
        return { status: 'ERROR', code: String(e?.code || e?.name || 'ERROR'), message: String(e?.message || e) };
      }
    },
  };

  const evVerify = {
    name: 'ev_verify',
    description:
      '一条声明走完整核验：拆原子 → 生成 2–3 条检索式 → 检索并按同源归并成簇 → 每簇抓最优成员落 artifact → 抽取正文 → ' +
      '比对数字与文本 → 规则判决（judgeV1）→ 不变量校验 → 落 claims/verdicts。' +
      'UGC 簇只进 leads 不进证据；检索后端缺失时 degraded=true、gaps 带 SEARCH_UNAVAILABLE，判决只能弃权。' +
      'sources 给了 URL 就**不再自己检索**（研学模式里通常先用 web_search 挑候选，再把 URL 交进来）。' +
      '不承诺全面性：coverage.saturation 恒 unknown。',
    parameters: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: '待核验的声明文本' },
        depth: { type: 'string', enum: ['quick', 'deep'], description: 'quick 取 3 簇各 1 篇；deep 取 6 簇各 2 篇并加官方站定向检索' },
        as_of: { type: 'string', description: '信息时点（ISO8601），默认当前时间' },
        sources: { type: 'array', items: { type: 'string' }, description: '指定来源 URL；提供后直接抓取取证，不再自动检索' },
      },
      required: ['claim'],
    },
    execute: async (args = {}) => {
      try {
        const claim = asString(args?.claim);
        if (!claim.trim()) return { status: 'BAD_ARGUMENT', message: 'claim 必填' };
        return await verifyClaim(
          { claim, depth: asString(args?.depth) || 'quick', asOf: asString(args?.as_of), sources: args?.sources },
          {
            extractAtoms,
            saveClaim,
            runSearch,
            searchImpl,
            fetchPage,
            compareNumeric,
            judgeV1,
            saveVerdict,
            db: getDb(),
            nowISO,
          },
        );
      } catch (e) {
        return { status: 'ERROR', code: String(e?.code || e?.name || 'ERROR'), message: String(e?.message || e) };
      }
    },
  };

  // ★0.8.2：宿主 `tools.register()` 第一件事就是校验 `definition.output` 是对象且有 `render` 函数
  //   （`@deepseek-ai/dsh-tools/lib/index.js:434-437`，缺了直接抛 TypeError）。
  //   2026-11-12 探针实测：不加这个字段时五路注册全失败（`[probe] … ok=0/5`），
  //   而旧代码把异常吞在 warn 里，日志照样打「registered」，于是 ev_* 从 0.6.0 起就没进过会话。
  //   渲染风格与 rp-mode / 官方 tool-web 一致：把返回值 JSON 成一条 text。
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
  return [evFetch, evExtract, evClaim, evSearch, evVerify].map((definition) =>
    definition.output ? definition : { ...definition, output },
  );
}
