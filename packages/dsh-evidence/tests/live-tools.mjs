/**
 * tests/live-tools.mjs — 实网冒烟：ev_fetch → ev_extract 走通真实网络
 *
 * **不在 CI 必过项内**（依赖外网可达性）。跑法：
 *   powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' `
 *     -Out '<workspace>\_tmp\evidence-live-tools.txt' `
 *     '<workspace>\dsh-plugins\dsh-evidence\tests\live-tools.mjs'
 *
 * 判据：status=OK、replacementChars=0、正文长度 > 0、span 可切片；artifact 落 _tmp，不碰 ~/.dsh。
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../lib/db.js';
import { createEvidenceTools } from '../lib/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', '..', '..', '_tmp', 'evidence-live');

const TARGETS = [
  { name: '东财 utf-8', url: 'https://quote.eastmoney.com/sh600519.html' },
  { name: '腾讯 gbk', url: 'https://qt.gtimg.cn/q=sh600519' },
];

rmSync(DATA_DIR, { recursive: true, force: true });
const db = openDatabase(':memory:');
const defs = createEvidenceTools({ dataDir: DATA_DIR, budget: { deadlineMs: 20000 }, dbProvider: () => db });
const evFetch = defs.find((d) => d.name === 'ev_fetch');
const evExtract = defs.find((d) => d.name === 'ev_extract');
const evClaim = defs.find((d) => d.name === 'ev_claim');

let bad = 0;
for (const target of TARGETS) {
  const r = await evFetch.execute({ url: target.url, deadline_ms: 20000 });
  const okFetch = r.status === 'OK';
  console.log(
    `[${okFetch ? 'PASS' : 'FAIL'}] ${target.name} status=${r.status} http=${r.httpStatus ?? '-'} bytes=${r.bytes} repl=${r.replacementChars ?? '-'} art=${r.artifactId ?? '-'}`,
  );
  if (!okFetch) {
    bad += 1;
    console.log('  attempts=' + JSON.stringify(r.attempts || []));
    continue;
  }
  const e = await evExtract.execute({ artifactId: r.artifactId, maxChars: 400 });
  const okExtract = e.status === 'OK' && typeof e.text === 'string' && e.spans.every((s) => e.text.slice(s.start, s.end).length > 0);
  console.log(
    `  [${okExtract ? 'PASS' : 'FAIL'}] extract textChars=${e.textChars} spans=${e.spans?.length ?? 0} tables=${e.tables?.length ?? 0} flags=${JSON.stringify(e.qualityFlags)}`,
  );
  if (!okExtract) bad += 1;

  const c = await evClaim.execute({ text: e.text || '', as_of: '2026-11-12T00:00:00Z' });
  const okClaim = c.status === 'OK' && c.atomCount > 0;
  console.log(
    `  [${okClaim ? 'PASS' : 'FAIL'}] claim atoms=${c.atomCount ?? 0} outOfScope=${c.outOfScopeCount ?? 0} unverified=${c.unverifiedCount ?? 0} claimId=${c.claimId ?? '-'}`,
  );
  if (!okClaim) {
    bad += 1;
    console.log('    atoms[-1]=' + JSON.stringify((c.atoms || []).slice(0, 3)));
  }
}

console.log(bad === 0 ? 'LIVE_ALL_OK' : `LIVE_HAS_FAILURE(${bad})`);
console.log('dataDir: ' + DATA_DIR);
db.close();
process.exit(bad === 0 ? 0 : 1);
