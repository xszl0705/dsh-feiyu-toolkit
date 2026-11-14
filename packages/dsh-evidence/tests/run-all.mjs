/**
 * tests/run-all.mjs — 汇总运行器
 *
 * 本机没有 node 在 PATH，跑法：
 *   ELECTRON_RUN_AS_NODE=1 "<DSH_HOME>/DeepSeek Harness.exe" tests/run-all.mjs
 * 或：
 *   powershell -File <workspace>\tools\run-node.ps1 -Out <out> tests/run-all.mjs
 *
 * stdout 在 Electron 下会丢，所以结果同时落 _tmp/evidence-test.json。
 */
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');

function makeT() {
  const results = [];
  const t = {
    eq(actual, expected, label) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({ ok, label, actual: ok ? undefined : actual, expected: ok ? undefined : expected });
    },
    ok(cond, label) {
      results.push({ ok: !!cond, label });
    },
    results,
  };
  return t;
}

const files = readdirSync(casesDir).filter((f) => f.endsWith('.test.mjs')).sort();
const suites = [];

for (const file of files) {
  const mod = await import(pathToFileURL(join(casesDir, file)).href);
  const t = makeT();
  let failedToRun = null;
  try {
    await mod.run(t);
  } catch (e) {
    failedToRun = String(e && (e.stack || e.message)).slice(0, 600);
  }
  suites.push({
    name: mod.name || file,
    file,
    total: t.results.length,
    failed: t.results.filter((r) => !r.ok).length,
    runError: failedToRun,
    results: t.results,
  });
}

const allOk = suites.every((s) => !s.runError && s.failed === 0);
const summary = {
  at: new Date().toISOString(),
  allOk,
  suites: suites.map((s) => ({ name: s.name, total: s.total, failed: s.failed, runError: s.runError })),
  details: suites,
};

const outPath = join(here, '..', '..', '..', '_tmp', 'evidence-test.json');
try {
  writeFileSync(outPath, JSON.stringify(summary, null, 1), 'utf8');
} catch {
  /* 落盘失败不阻断 */
}

for (const s of suites) {
  console.log(`[${s.runError ? 'ERROR' : s.failed === 0 ? 'PASS' : 'FAIL'}] ${s.name}  ${s.total - s.failed}/${s.total}`);
  if (s.runError) console.log('  runError: ' + s.runError.split('\n')[0]);
  for (const r of s.results.filter((x) => !x.ok)) {
    console.log(`  - ${r.label}  actual=${JSON.stringify(r.actual)} expected=${JSON.stringify(r.expected)}`);
  }
}
console.log(allOk ? 'ALL_OK' : 'HAS_FAILURE');
console.log('written: ' + outPath);
process.exit(allOk ? 0 : 1);
