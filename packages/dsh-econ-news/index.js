/**
 * dsh-econ-news — 经济新闻采集与简报（研学模式专用）。
 *
 * 结构：
 *   lib/sources.js   22 个源（6 类 adapter）+ 备案链
 *   lib/http.js      三档通道（node 直连 / HTTP 代理 / 宿主 ctx.web）+ 冷却
 *   lib/html.js      正文抽取（选择器 → 最长块兜底）
 *   lib/store.js     按日存档（items.jsonl / raw / text / manifest / brief）
 *   lib/collect.js   编排（并发 + 预算 + 缺口账本）
 *   lib/brief.js     规则抽取版简报
 *   lib/scheduler.js 启动后检查当日是否已采，没采就后台跑一次
 *   lib/tools.js     5 个工具
 *   lib/preset-gate.js  per-step 准入：工具只在 preset=research 可见
 *
 * 三条硬约束：不往工作区外写、不往会话注入消息、拿不到就写缺口不编内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { createHttp } from './lib/http.js';
import { createTools } from './lib/tools.js';
import { createScheduler } from './lib/scheduler.js';
import { runCollect } from './lib/collect.js';
import { bindPresetSources, makePresetGate } from './lib/preset-gate.js';

export const name = 'dsh-econ-news';
export const version = '0.1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  enabled: true,
  dataDir: path.join(process.env.DSH_WORKSPACE || process.cwd(), 'econ-news'),
  autoCollect: true,
  autoDelayMs: 20000,
  dailyBudgetMs: 180000,
  concurrency: 4,
  maxArticlesPerSource: 12,
  proxy: '',
  ftCookie: '',
  llmProvider: '',
  disabledSources: [],
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function log(message) {
  try {
    fs.appendFileSync(path.join(HERE, 'load.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // 日志写不了不影响主流程
  }
}

function safeGet(target, key) {
  try {
    return target && typeof target.get === 'function' ? target.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 宿主 web 服务：`ctx.web.fetch({ url })`（dsh-web 的能力接缝，fetch provider 由 dsh-web-deepseek-api 提供）。
 * IMF 只能走这里（node 直连 403）。后台没有会话时可能拿不到凭据，那就抛 HOST_WEB_UNAVAILABLE，
 * 由 http 层记失败、由简报写缺口——不伪造内容。
 */
function makeHostWeb(ctx, config) {
  return async function hostWeb(url) {
    const web = safeGet(ctx, 'web');
    if (!web || typeof web.fetch !== 'function') {
      const error = new Error('web service unavailable');
      error.code = 'HOST_WEB_UNAVAILABLE';
      throw error;
    }
    const payload = { url };
    if (config.llmProvider) payload.llmProvider = config.llmProvider;
    try {
      return await web.fetch(payload);
    } catch (error) {
      const code = String(error?.code || error?.name || '');
      if (/AUTH|READY|CREDENTIAL|UNAVAILABLE/i.test(code) || !config.llmProvider) throw error;
      return await web.fetch({ url, llmProvider: 'deepseek-account' });
    }
  };
}

/** tools 服务冷启动可能没就绪：轮询到就绪，只注册一次。 */
function registerWhenToolsReady(ctx, state, callback) {
  if (state.registered || state.waiting) return;
  const started = Date.now();
  state.waiting = true;
  const tick = () => {
    const tools = safeGet(ctx, 'tools');
    if (tools && typeof tools.register === 'function') {
      if (state.registered) return;
      state.registered = true;
      state.waiting = false;
      callback(tools);
      return;
    }
    if (Date.now() - started > 60000) {
      state.waiting = false;
      log('60s 内没等到 tools 服务，工具未注册');
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

export function apply(ctx) {
  try {
    return applyInner(ctx);
  } catch (error) {
    log('apply 抛错：' + String((error && error.message) || error));
    return undefined;
  }
}

function applyInner(ctx) {
  const config = loadConfig();
  if (config.enabled === false) {
    log('config.enabled=false，跳过');
    return undefined;
  }

  const store = createStore(config.dataDir);
  const http = createHttp({
    proxy: config.proxy,
    hostWeb: makeHostWeb(ctx, config),
    health: new Map(),
  });

  const state = { registered: false, waiting: false, scheduler: null, gateLog: [] };
  const gate = makePresetGate(['research'], {
    onUnknown: 'hide',
    log: (line) => {
      state.gateLog.push(line);
      if (state.gateLog.length > 40) state.gateLog.shift();
      log(line);
    },
  });

  const presetSources = bindPresetSources(ctx);
  log(`preset sources registry=${presetSources.registry} sessions=${presetSources.sessions}`);

  const definitions = createTools({ config, store, http, log });

  registerWhenToolsReady(ctx, state, (tools) => {
    const registerAll = () => {
      const handles = [];
      for (const definition of definitions) {
        try {
          handles.push(tools.register(definition, { when: gate }));
        } catch (error) {
          log('注册工具失败 ' + definition.name + '：' + String((error && error.message) || error));
        }
      }
      log(`已注册 ${handles.length}/${definitions.length} 个工具：${definitions.map((d) => d.name).join(',')}`);
      return () => {
        for (const handle of handles) {
          try {
            handle?.dispose?.();
          } catch {
            // 卸载失败不影响禁用
          }
        }
      };
    };
    if (typeof ctx.effect === 'function') ctx.effect(registerAll);
    else registerAll();
  });

  const scheduler = createScheduler({
    config,
    store,
    log,
    run: (opts) => runCollect({ ...opts, http, store, config, log }),
  });
  state.scheduler = scheduler;
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      scheduler.start();
      return () => scheduler.stop();
    });
  } else {
    scheduler.start();
  }

  const api = {
    id: 'econ-news',
    dataDir: store.root,
    collect: (opts = {}) => runCollect({ ...opts, http, store, config, log }),
    state: () => store.readState(),
    status: () => ({ dataDir: store.root, hostWeb: http.hasHostWeb, proxy: Boolean(http.proxy), gate: state.gateLog.slice(-5) }),
    stop: () => scheduler.stop(),
  };
  try {
    if (typeof ctx.provide === 'function') ctx.provide('econ-news', api);
  } catch {
    // 宿主可能不认这个服务名
  }

  try {
    const self = safeGet(ctx, 'self');
    self?.declare?.({
      id: 'econ-news',
      package: 'dsh-econ-news',
      intent: '按日采集 IMF WEO / WSJ / FT / 中美政策 / 经济学成果，原文落盘后生成可溯源简报',
      inputs: ['date', 'sources', 'urls', 'id'],
      outputs: ['items.jsonl', 'manifest.json', 'brief.md', '原文'],
      limits: [
        '只在研学模式（preset research）可见',
        'FT 本机双通道不可达，默认记缺口',
        'WSJ 只有 RSS 摘要，正文不可达',
        'IMF 仅宿主 web 通道可取，缺凭据时降级 DBnomics',
      ],
      scope: ['owner'],
    });
  } catch {
    // self 没装不影响工具
  }

  log(`dsh-econ-news 就绪 dataDir=${store.root} pid=${process.pid}`);
  return api;
}
