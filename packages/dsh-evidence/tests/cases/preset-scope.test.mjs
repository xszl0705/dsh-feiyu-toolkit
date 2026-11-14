/**
 * tests/cases/preset-scope.test.mjs — preset 准入层
 *
 * 全部离线：伪造 registry 与会话快照，覆盖三条来源的优先级、fail 策略与「when 绝不抛错」。
 */
import {
  bindPresetSources,
  resolveAgentPreset,
  makePresetGate,
  resetPresetSources,
} from '../../lib/preset-scope.js';

export const name = 'preset-scope';

function fakeCtx({ sessionPreset = null, snapshot = null } = {}) {
  const services = {
    agentPresets: {
      presetForSession(session) {
        if (sessionPreset === 'THROW') throw new Error('registry boom');
        return sessionPreset;
      },
    },
  };
  if (snapshot) {
    services.sessions = { list: { getSnapshot: () => snapshot } };
  }
  return { get: (key) => services[key] };
}

export async function run(t) {
  // 1. registry 权威：跟随 agent-preset/selected
  resetPresetSources();
  bindPresetSources(fakeCtx({ sessionPreset: 'research' }));
  t.eq(resolveAgentPreset({ session: { id: 's1' } }), 'research', 'registry 优先给出 research');

  // 2. registry 返回 null → 回退 agent 上的旧字段
  resetPresetSources();
  bindPresetSources(fakeCtx({ sessionPreset: null }));
  t.eq(
    resolveAgentPreset({ session: { id: 's1', header: { agentPreset: 'standard' } } }),
    'standard',
    'registry 空值时回退 session.header.agentPreset',
  );

  // 3. registry 抛错 → 不传播，回退后备链
  resetPresetSources();
  bindPresetSources(fakeCtx({ sessionPreset: 'THROW' }));
  t.eq(
    resolveAgentPreset({ session: { id: 's1', header: { preset: 'roleplay' } } }),
    'roleplay',
    'registry 抛错时静默回退',
  );

  // 4. 会话快照按 session id 精确匹配
  resetPresetSources();
  bindPresetSources(
    fakeCtx({
      sessionPreset: null,
      snapshot: { byId: { s2: { projectionValues: { agentPreset: 'lean' } } } },
    }),
  );
  t.eq(resolveAgentPreset({ session: { id: 's2' } }), 'lean', '快照按 id 命中 lean');
  t.eq(resolveAgentPreset({ session: { id: 'other' } }), '', 'id 不匹配时不拿 current 兜底');

  // 5. 什么来源都没有 → 空串（调用方据此走 onUnknown）
  resetPresetSources();
  t.eq(resolveAgentPreset({}), '', '无来源返回空串');
  t.eq(resolveAgentPreset(null), '', 'agent 为 null 不抛错');

  // 6. gate：只放行白名单
  resetPresetSources();
  bindPresetSources(fakeCtx({ sessionPreset: 'research' }));
  const lines = [];
  const gate = makePresetGate(['research'], { log: (line) => lines.push(line) });
  t.eq(gate({ agent: { session: { id: 's1' } } }), true, 'research 放行');
  t.eq(lines.length > 0, true, 'gate 打了诊断行');

  bindPresetSources(fakeCtx({ sessionPreset: 'standard' }));
  t.eq(gate({ agent: { session: { id: 's3' } } }), false, 'standard 拒绝');

  // 7. 判不出 preset：默认 hide（fail-closed）
  resetPresetSources();
  t.eq(gate({ agent: {} }), false, '判不出时默认不暴露');
  t.eq(gate(null), false, 'context 为 null 不抛错且不暴露');

  // 8. onUnknown=show 时 fail-open
  const openGate = makePresetGate(['research'], { onUnknown: 'show' });
  t.eq(openGate({ agent: {} }), true, 'onUnknown=show 时判不出也暴露');

  // 9. 空白名单 = 不设限
  const freeGate = makePresetGate([], {});
  t.eq(freeGate({ agent: {} }), true, '白名单为空时不设限');

  // 10. when 内抛错不传播（宿主会把异常当 ToolActivationError 让该步失败）
  const boomGate = makePresetGate(['research'], {
    log: () => {
      throw new Error('log boom');
    },
  });
  let threw = false;
  let verdict = null;
  try {
    verdict = boomGate({ agent: { session: { id: 's1' } } });
  } catch {
    threw = true;
  }
  t.eq(threw, false, 'gate 自身不抛错');
  t.eq(verdict, false, '出错时按 hide 处理');

  // 11. 白名单里的空白项被忽略
  const trimmed = makePresetGate(['  research  ', ''], {});
  resetPresetSources();
  bindPresetSources(fakeCtx({ sessionPreset: 'research' }));
  t.eq(trimmed({ agent: { session: { id: 's1' } } }), true, '白名单项去空格后仍命中');

  resetPresetSources();
}
