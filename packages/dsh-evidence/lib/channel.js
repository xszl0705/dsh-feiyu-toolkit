/**
 * lib/channel.js — 通道降级链
 *
 * 规则（docs/tech-spec-evidence.md §5.2）：
 *   1. 按 channelOrder 依次尝试，每步写 trace
 *   2. 401/403/406/412 → 查 header 表重试一次
 *   3. 连续 3 次失败 → 该 (domain, channel) 冷却 30 分钟
 *   4. 剩余时间 < 2s → 停止发新请求，返回 BUDGET_EXCEEDED
 *   5. 登录墙/验证码 → BLOCKED，不重试
 *
 * 依赖注入：fetchImpl / hostFetch / health / now 都可替换，便于离线测试。
 */
import { decodeBody, assessQuality } from './decode.js';
import { headerPolicy, shouldRetryWithPolicy } from './header-policy.js';

export const DEFAULT_CHANNELS = ['host_fetch', 'node_direct'];

export function createChannel(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    hostFetch = null,
    channels = DEFAULT_CHANNELS,
    health = new Map(),
    now = () => Date.now(),
    perRequestTimeoutMs = 8000,
    minRemainingMs = 2000,
    coolDownMs = 30 * 60 * 1000,
    failStreakLimit = 3,
  } = options;

  const key = (domain, ch) => `${domain}::${ch}`;

  function inCooldown(domain, ch) {
    const h = health.get(key(domain, ch));
    return Boolean(h?.cooldownUntil && h.cooldownUntil > now());
  }

  function note(domain, ch, ok) {
    const k = key(domain, ch);
    const prev = health.get(k) || { failStreak: 0, cooldownUntil: null };
    if (ok) {
      health.set(k, { failStreak: 0, cooldownUntil: null, lastOkAt: now() });
      return;
    }
    const failStreak = (prev.failStreak || 0) + 1;
    health.set(k, {
      failStreak,
      cooldownUntil: failStreak >= failStreakLimit ? now() + coolDownMs : prev.cooldownUntil ?? null,
      lastFailAt: now(),
    });
  }

  async function rawRequest(ch, url, policy, timeoutMs) {
    if (ch === 'host_fetch') {
      if (!hostFetch) return { skipped: true, err: 'NO_HOST_FETCH' };
      return hostFetch(url, { method: policy.method, headers: policy.headers, timeoutMs });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'NET_TIMEOUT' })), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      const res = await Promise.race([
        fetchImpl(url, {
          method: policy.method,
          headers: policy.headers,
          redirect: 'follow',
        }),
        timeout,
      ]);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, contentType: res.headers?.get?.('content-type') ?? '', bytes: buf };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @returns {Promise<{ok:boolean, code?:string, channel?:string, status?:number, text?:string,
   *   encoding?:string, quality?:object, attempts:Array}>}
   */
  async function fetchWithFallback(url, opts = {}) {
    const deadline = opts.deadlineAt ?? now() + (opts.deadlineMs ?? 15000);
    const attempts = [];
    const policy0 = headerPolicy(url);

    for (const ch of channels) {
      if (inCooldown(policy0.domain, ch)) {
        attempts.push({ ch, skipped: true, reason: 'COOLDOWN' });
        continue;
      }
      if (deadline - now() < minRemainingMs) {
        return { ok: false, code: 'BUDGET_EXCEEDED', attempts };
      }

      const timeoutMs = Math.max(1000, Math.min(perRequestTimeoutMs, deadline - now()));
      const t0 = now();
      let r;
      try {
        r = await rawRequest(ch, url, policy0, timeoutMs);
      } catch (e) {
        const code = e?.code || e?.name || 'NET_ERROR';
        attempts.push({ ch, err: String(code), ms: now() - t0 });
        note(policy0.domain, ch, false);
        continue;
      }

      if (r.skipped) {
        attempts.push({ ch, skipped: true, reason: r.err });
        continue;
      }

      // 需要 header 策略重试
      if (shouldRetryWithPolicy(r.status) && policy0.known) {
        attempts.push({ ch, status: r.status, ms: now() - t0, retriedFor: 'HEADER_POLICY' });
        try {
          r = await rawRequest(ch, url, policy0, Math.max(1000, Math.min(perRequestTimeoutMs, deadline - now())));
        } catch (e) {
          attempts.push({ ch, err: String(e?.code || e?.name), retryFailed: true });
          note(policy0.domain, ch, false);
          continue;
        }
      }

      const decoded = decodeBody(r.bytes, r.contentType);
      const quality = assessQuality(decoded.text, r.contentType);
      const rec = {
        ch,
        status: r.status,
        ms: now() - t0,
        bytes: r.bytes.length,
        encoding: decoded.encoding,
        replacementChars: decoded.replacementChars,
      };
      attempts.push(rec);

      if (r.status >= 200 && r.status < 300) {
        if (quality.loginWall || quality.captcha) {
          note(policy0.domain, ch, false);
          return { ok: false, code: 'BLOCKED', channel: ch, status: r.status, quality, attempts };
        }
        note(policy0.domain, ch, true);
        return {
          ok: true,
          channel: ch,
          status: r.status,
          // rawBytes 是**原始字节**（不是 text 的再编码）：artifact 的 sha256 与落盘都基于它
          rawBytes: r.bytes,
          contentType: r.contentType ?? '',
          text: decoded.text,
          encoding: decoded.encoding,
          encodingOk: decoded.encodingOk,
          replacementChars: decoded.replacementChars,
          mojibake: decoded.mojibake,
          quality,
          attempts,
        };
      }

      note(policy0.domain, ch, false);
      if (r.status === 429) {
        return { ok: false, code: 'RATE_LIMITED', status: r.status, attempts };
      }
    }

    return { ok: false, code: 'ALL_FAILED', attempts };
  }

  return { fetchWithFallback, health, inCooldown };
}
