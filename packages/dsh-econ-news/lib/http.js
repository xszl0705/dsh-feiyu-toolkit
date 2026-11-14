/**
 * 通道层：node 直连 / HTTP 代理 / 宿主 web 服务，三档降级 + 冷却。
 *
 * 实测依据（2026-11-14，本机）：
 *   · IMF 主站 node 直连 403（Akamai），宿主 web_fetch 200 → 只能用宿主通道
 *   · WSJ 的 feeds.a.dj.com 可直连；wsj.com 文章页两条通道都不通
 *   · FT 直连 ECONNRESET，是否有代理决定能不能取
 * 所以链顺序可配：默认 `node_direct`，源上标 `channel: 'host_web'` 的直接走宿主。
 *
 * 冷却：同一 (domain, channel) 连续 3 次失败 → 30 分钟内不再尝试。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class HttpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** 宿主 ctx.web.fetch 的返回形状不稳，这里做多形状归一。 */
export function normalizeHostResult(result) {
  if (result === null || result === undefined) return { status: 0, text: '' };
  if (typeof result === 'string') return { status: 200, text: result };
  const status = Number(result.status ?? result.statusCode ?? result.httpStatus ?? 0);
  const body =
    result.text ??
    result.content ??
    result.body ??
    result.markdown ??
    (result.data && (result.data.text ?? result.data.content ?? result.data.markdown)) ??
    '';
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return { status: status || (text ? 200 : 0), text };
}

function proxyBasicAuth(url) {
  if (!url.username) return {};
  const raw = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}`;
  return { 'proxy-authorization': 'Basic ' + Buffer.from(raw).toString('base64') };
}

/** 解 chunked body（代理隧道里服务器常常不给 length）。 */
function dechunk(buffer, headers) {
  const encoding = String(headers['transfer-encoding'] || '').toLowerCase();
  if (!encoding.includes('chunked')) return buffer;
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = parseInt(buffer.slice(offset, lineEnd).toString('ascii').trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    parts.push(buffer.slice(start, start + size));
    offset = start + size + 2;
  }
  return parts.length ? Buffer.concat(parts) : buffer;
}

/** 直读 443 的 CONNECT 隧道：没有 undici 可用，只能手写。 */
function proxyGet(urlStr, proxyStr, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  const target = new URL(urlStr);
  const proxy = new URL(proxyStr);
  const headers = { host: target.hostname, 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', connection: 'close', ...(options.headers || {}) };

  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxy.hostname,
      port: proxy.port || 8080,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: proxyBasicAuth(proxy),
    });
    connect.setTimeout(timeoutMs, () => connect.destroy(new HttpError('PROXY_TIMEOUT', 'proxy connect timeout')));
    connect.on('error', (error) => reject(new HttpError('PROXY_FAILED', String(error?.message || error))));
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new HttpError('PROXY_DENIED', 'CONNECT ' + res.statusCode));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        const path = target.pathname + target.search;
        const head = [`GET ${path} HTTP/1.1`, `Host: ${target.hostname}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
        tlsSocket.write(head);
      });
      const chunks = [];
      tlsSocket.on('data', (chunk) => chunks.push(chunk));
      tlsSocket.on('error', (error) => reject(new HttpError('PROXY_TLS_FAILED', String(error?.message || error))));
      tlsSocket.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const split = raw.indexOf('\r\n\r\n');
          if (split < 0) throw new HttpError('PROXY_BAD_RESPONSE', 'no header terminator');
          const headText = raw.slice(0, split).toString('utf8');
          const body = raw.slice(split + 4);
          const status = Number((headText.match(/^HTTP\/\d\.\d\s+(\d+)/) || [, 0])[1]);
          const headerMap = {};
          for (const line of headText.split('\r\n').slice(1)) {
            const idx = line.indexOf(':');
            if (idx > 0) headerMap[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
          const decoded = dechunk(body, headerMap).toString('utf8');
          resolve({ status, text: decoded });
        } catch (error) {
          reject(error instanceof HttpError ? error : new HttpError('PROXY_BAD_RESPONSE', String(error?.message || error)));
        }
      });
    });
    connect.end();
  });
}

/** 直连（支持 http:// 与 https://）。 */
async function directGet(url, options = {}) {
  if (typeof options.fetchImpl === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    try {
      const res = await options.fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': UA, accept: '*/*', ...(options.headers || {}) },
      });
      const text = await res.text();
      return { status: res.status, text };
    } finally {
      clearTimeout(timer);
    }
  }
  const target = new URL(url);
  const mod = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: options.method || 'GET', headers: { 'user-agent': UA, accept: '*/*', ...(options.headers || {}) }, timeout: options.timeoutMs || 15000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          directGet(new URL(res.headers.location, url).toString(), options).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new HttpError('NET_TIMEOUT', 'request timeout')));
    req.on('error', (error) => reject(new HttpError(String(error?.code || 'NET_ERROR'), String(error?.message || error))));
    req.end();
  });
}

const FAIL_STREAK_LIMIT = 3;
const COOLDOWN_MS = 30 * 60 * 1000;

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || '');
  }
}

/**
 * @param {object} options
 * @param {Function} [options.fetchImpl] node 直连用的 fetch
 * @param {string}   [options.proxy]     http://user:pass@host:port
 * @param {Function} [options.hostWeb]   (url, opts) => {status,text}，由宿主 ctx.web 注入
 * @param {Map}      [options.health]    冷却表（测试可注入）
 * @param {Function} [options.now]
 */
export function createHttp(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const proxy = String(options.proxy || '').trim();
  const hostWeb = typeof options.hostWeb === 'function' ? options.hostWeb : null;
  const health = options.health instanceof Map ? options.health : new Map();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;

  const keyOf = (host, channel) => `${host}::${channel}`;

  function inCooldown(host, channel) {
    const row = health.get(keyOf(host, channel));
    return Boolean(row && row.cooldownUntil && row.cooldownUntil > now());
  }

  function note(host, channel, ok, reason) {
    const key = keyOf(host, channel);
    const prev = health.get(key) || { failStreak: 0, cooldownUntil: null };
    if (ok) {
      health.set(key, { failStreak: 0, cooldownUntil: null, lastOkAt: now() });
      return;
    }
    const failStreak = (prev.failStreak || 0) + 1;
    health.set(key, {
      failStreak,
      cooldownUntil: failStreak >= FAIL_STREAK_LIMIT ? now() + COOLDOWN_MS : prev.cooldownUntil || null,
      lastFailAt: now(),
      lastReason: reason || '',
    });
  }

  async function once(channel, url, opts) {
    if (channel === 'host_web') {
      if (!hostWeb) throw new HttpError('HOST_WEB_UNAVAILABLE', 'no host web service');
      const raw = await hostWeb(url, { timeoutMs: opts.timeoutMs || timeoutMs });
      const normalized = normalizeHostResult(raw);
      return normalized;
    }
    if (channel === 'proxy') {
      if (!proxy) throw new HttpError('NO_PROXY', 'proxy not configured');
      return proxyGet(url, proxy, { timeoutMs: opts.timeoutMs || timeoutMs, headers: opts.headers });
    }
    return directGet(url, { ...opts, fetchImpl, timeoutMs: opts.timeoutMs || timeoutMs });
  }

  /**
   * @param {string} url
   * @param {{ channels?: string[], timeoutMs?: number, headers?: object }} [opts]
   * @returns {Promise<{ ok:boolean, status:number, text:string, channel:string, attempts:Array }>}
   */
  async function get(url, opts = {}) {
    const host = hostOf(url);
    const channels = Array.isArray(opts.channels) && opts.channels.length ? opts.channels : ['node_direct', 'host_web'];
    const attempts = [];
    for (const channel of channels) {
      if (inCooldown(host, channel)) {
        attempts.push({ channel, skipped: 'COOLDOWN' });
        continue;
      }
      try {
        const res = await once(channel, url, opts);
        attempts.push({ channel, status: res.status, bytes: res.text ? res.text.length : 0 });
        if (res.status >= 200 && res.status < 300 && res.text) {
          note(host, channel, true);
          return { ok: true, status: res.status, text: res.text, channel, attempts };
        }
        note(host, channel, false, String(res.status));
        if (res.status === 401 || res.status === 403 || res.status === 406 || res.status === 412) {
          // 被拦：这一档不用再试同一域名，交给下一档
          continue;
        }
      } catch (error) {
        const code = String(error?.code || error?.name || 'NET_ERROR');
        attempts.push({ channel, error: code });
        note(host, channel, false, code);
        if (code === 'NO_PROXY' || code === 'HOST_WEB_UNAVAILABLE') continue;
      }
    }
    return { ok: false, status: 0, text: '', channel: '', attempts };
  }

  return { get, health, inCooldown, proxy, hasHostWeb: Boolean(hostWeb) };
}
