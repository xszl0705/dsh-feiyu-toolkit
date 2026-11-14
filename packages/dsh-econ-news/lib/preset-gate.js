/**
 * preset 准入层：把本插件工具限制在指定 agent preset（研学模式 = research）。
 *
 * 机制（读宿主源码确认，非猜测）：
 *   `tools.register(definition, { when })` 的 when 是 **per-step 准入条件**，
 *   宿主每步装配工具前逐个 await；返回 false 则该步不出现，抛错会让该步失败。
 *   所以这里全 try/catch，绝不冒泡。
 *
 * preset 的可靠读取顺序（与 dsh-evidence/lib/preset-scope.js 同一套结论）：
 *   1. `agentPresets.composedPreset(agent.ctx)` —— 活组合，切模式后立即生效
 *   2. `agentPresets.presetForSession(session)` —— 跟随 agent-preset/selected 事件
 *   3. 会话快照 `projectionValues.agentPreset`（按 session id 精确匹配）
 *   4. agent 上零散的旧字段
 * 创建时快照的 `session.header.agentPreset` 在用户切模式后仍是旧值，只作最后兜底。
 */

let presetRegistry = null;
let sessionSource = null;
let boundCtx = null;
const announced = new Set();

function safeGet(target, path) {
  let cursor = target;
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined;
    try {
      cursor = cursor[key];
    } catch {
      return undefined;
    }
  }
  return cursor;
}

function bindOnce(ctx) {
  presetRegistry = null;
  sessionSource = null;
  try {
    const reg = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null;
    if (reg && (typeof reg.presetForSession === 'function' || typeof reg.composedPreset === 'function')) {
      presetRegistry = reg;
    }
  } catch {
    presetRegistry = null;
  }
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
      sessionSource = () => sessions.list.getSnapshot();
    }
  } catch {
    sessionSource = null;
  }
  return { registry: presetRegistry !== null, sessions: sessionSource !== null };
}

export function bindPresetSources(ctx) {
  boundCtx = ctx || null;
  return bindOnce(ctx);
}

function presetFromSessions(agent) {
  if (typeof sessionSource !== 'function') return '';
  try {
    const snap = sessionSource();
    const byId = snap && snap.byId;
    if (!byId) return '';
    const sid = String(safeGet(agent, ['session', 'id']) || safeGet(agent, ['session', 'sessionId']) || '');
    if (!sid || !byId[sid]) return '';
    const row = byId[sid];
    const direct = safeGet(row, ['projectionValues', 'agentPreset']);
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const alt = safeGet(row, ['agentPreset']) || safeGet(row, ['preset']);
    return typeof alt === 'string' ? alt.trim() : '';
  } catch {
    return '';
  }
}

export function resolveAgentPreset(agent) {
  if (!agent || typeof agent !== 'object') return '';
  for (const ctx of [safeGet(agent, ['ctx']), boundCtx]) {
    try {
      const registry = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null;
      const live = registry && typeof registry.composedPreset === 'function' ? registry.composedPreset(safeGet(agent, ['ctx'])) : '';
      if (typeof live === 'string' && live.trim()) return live.trim();
      const projected = registry && typeof registry.presetForSession === 'function' ? registry.presetForSession(safeGet(agent, ['session'])) : '';
      if (typeof projected === 'string' && projected.trim()) return projected.trim();
    } catch {
      // 服务形状不稳，继续走下一来源
    }
  }
  if (presetRegistry === null && sessionSource === null && boundCtx !== null) bindOnce(boundCtx);

  const candidates = [
    safeGet(agent, ['session', 'projectionValues', 'agentPreset']),
    safeGet(agent, ['projectionValues', 'agentPreset']),
    presetFromSessions(agent),
    safeGet(agent, ['session', 'header', 'agentPreset']),
    safeGet(agent, ['session', 'header', 'preset']),
    safeGet(agent, ['session', 'preset']),
    safeGet(agent, ['session', 'agentPreset']),
    safeGet(agent, ['agentPreset']),
    safeGet(agent, ['preset']),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * 造 when 条件：只有 allow 里的模式能看到这些工具。
 * onUnknown：`hide`（默认，宁缺勿滥）/ `show`（判不出就放行）。
 */
export function makePresetGate(presets, options = {}) {
  const allow = new Set(
    (Array.isArray(presets) ? presets : []).map((v) => String(v == null ? '' : v).trim()).filter(Boolean),
  );
  const onUnknown = options.onUnknown === 'show' ? 'show' : 'hide';
  const log = typeof options.log === 'function' ? options.log : () => {};

  return function presetGate(context) {
    try {
      if (allow.size === 0) return true;
      const preset = resolveAgentPreset(context && context.agent);
      const verdict = !preset ? onUnknown === 'show' : allow.has(preset);
      const line = `gate preset=${preset || '?'} allow=${[...allow].join('|')} → ${verdict ? 'show' : 'hide'}`;
      if (!announced.has(line)) {
        announced.add(line);
        if (announced.size > 64) announced.clear();
        log(line);
      }
      return verdict;
    } catch (error) {
      try {
        log('gate throw: ' + String((error && error.message) || error));
      } catch {
        // 诊断失败不影响判定
      }
      return onUnknown === 'show';
    }
  };
}

export function resetPresetSources() {
  presetRegistry = null;
  sessionSource = null;
  boundCtx = null;
  announced.clear();
}
