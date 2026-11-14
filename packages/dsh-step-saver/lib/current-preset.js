/** Read live composition before immutable creation headers. No current-session fallback. */
const contexts = new Set();
const safe = read => { try { return read(); } catch { return undefined; } };
const value = input => typeof input === 'string' ? input.trim() : '';
export function bindCurrentPresetContext(ctx) {
  contexts.add(ctx);
  return () => contexts.delete(ctx);
}
export function currentPreset(agent) {
  if (!agent || typeof agent !== 'object') return '';
  const actx = safe(() => agent.ctx);
  for (const ctx of [actx, ...contexts]) {
    const registry = safe(() => ctx?.get?.('agentPresets'));
    const live = value(safe(() => registry?.composedPreset?.(actx)));
    if (live) return live;
    const projected = value(safe(() => registry?.presetForSession?.(agent.session)));
    if (projected) return projected;
  }
  for (const read of [
    () => agent.session.projectionValues.agentPreset, () => agent.projectionValues.agentPreset,
    () => agent.session.header.agentPreset, () => agent.session.agentPreset,
    () => agent.agentPreset, () => agent.preset,
  ]) { const hit = value(safe(read)); if (hit) return hit; }
  return '';
}
