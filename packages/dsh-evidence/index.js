/** Evidence tools: one root registration, per-step admission, read-only diagnostics. */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createEvidenceTools } from './lib/tools.js';
import { bindPresetSources, makePresetGate, resolveAgentPreset } from './lib/preset-scope.js';

export const name = 'dsh-evidence';
export const version = '0.12.0';
export const inject = ['tools'];

function safe(read, fallback = undefined) { try { return read() ?? fallback; } catch { return fallback; } }
function disposeAll(items) {
  for (const dispose of items.reverse()) { try { dispose(); } catch {} }
}
export function apply(ctx) {
  const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  if (cfg.enabled === false) return;
  const dataDir = cfg.dataDir || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'dafeiyu', 'evidence');
  const logFile = cfg.diagnosticLog || join(dataDir, 'mode-diagnostic.log');
  const log = (event, detail = {}) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version, event, ...detail }) + '\n');
    } catch {}
  };
  bindPresetSources(ctx);
  const toolGate = cfg.toolGate || { presets: ['research'], onUnknown: 'hide' };
  const gate = makePresetGate(toolGate.presets || ['research'], { onUnknown: toolGate.onUnknown, log: line => log('gate', { line }) });
  const searchImpl = (() => {
    for (const key of ['webSearch', 'search']) {
      const s = safe(() => ctx.get(key));
      if (typeof s === 'function') return (query, options) => s(query, options);
      if (typeof s?.search === 'function') return (query, options) => s.search(query, options);
    }
    return null;
  })();
  const definitions = createEvidenceTools({ ...cfg, dataDir, searchImpl });
  // Dependency injection makes this service available before apply. No global lock:
  // the owning Cordis effect determines lifetime and supports unload/reload.
  try {
    const tools = ctx.tools;
    ctx.effect(() => {
      const disposers = [];
      try {
        for (const definition of definitions) disposers.push(tools.register(definition, { when: gate }));
      } catch (error) {
        disposeAll(disposers);
        log('registration-failed', { error: String(error?.message || error), registered: 0 });
        throw error;
      }
      log('registered', { count: disposers.length, names: definitions.map(d => d.name), searchBackend: !!searchImpl });
      return () => disposeAll(disposers);
    }, 'evidence.register');
  } catch (error) {
    // Keep the host available, but never report success after a partial registration.
    log('apply-failed', { error: String(error?.message || error) });
    return;
  }
  // Diagnostics do not create tools. required=true survives persona runtime suppression.
  ctx.inject(['systemPrompt'], pctx => {
    const seen = new WeakMap();
    return pctx.systemPrompt.context({
      name: 'dsh-evidence:agent-probe', order: 900, required: true,
      text(context) {
        try {
          const agent = context.agent;
          if (!agent || typeof agent !== 'object') return '';
          const preset = resolveAgentPreset(agent);
          const tools = safe(() => agent.ctx.tools) || safe(() => agent.ctx.get('tools'));
          const visible = safe(() => tools.definitions(agent).map(d => d.name), []);
          const admitted = safe(() => [...context.toolSet.view(agent).keys()], null);
          const signature = JSON.stringify([preset, visible, admitted]);
          if (seen.get(agent) !== signature) {
            seen.set(agent, signature);
            log('agent-tools', { sessionId: safe(() => agent.session.id, safe(() => agent.id, 'unknown')), preset,
              visible, admitted, missingEvidence: definitions.map(d => d.name).filter(n => !(admitted || []).includes(n)) });
          }
        } catch (error) { log('probe-failed', { error: String(error?.message || error) }); }
        return '';
      },
    });
  });
}
