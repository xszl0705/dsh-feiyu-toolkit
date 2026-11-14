/**
 * 存档层：每天一个目录，原文与提取文本分开放，索引与状态各一份。
 *
 *   <dataDir>/index.json          每日一行索引（只留 60 天）
 *   <dataDir>/state.json          调度状态（lastRunDate / lastResult / 重试）
 *   <dataDir>/<date>/manifest.json  本次采集的账本（源级成败、通道、缺口）
 *   <dataDir>/<date>/items.jsonl    每条一行（含 bodyStatus / sha256 / 落盘路径）
 *   <dataDir>/<date>/raw/<id>.html  原始响应
 *   <dataDir>/<date>/text/<id>.md   提取后的正文
 *   <dataDir>/<date>/brief.md       简报
 *   <dataDir>/<date>/brief.sources.md 溯源表
 *
 * 所有写入都是「先写临时文件再 rename」，避免中途崩溃留下半个 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function itemId(source, url, title) {
  return sha256(`${source}|${url}|${title}`).slice(0, 16);
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function createStore(dataDir) {
  const root = path.resolve(String(dataDir || ''));

  const dayDir = (date) => path.join(root, date);
  const fileOf = (date, name) => path.join(dayDir(date), name);

  function ensureDay(date) {
    fs.mkdirSync(path.join(dayDir(date), 'raw'), { recursive: true });
    fs.mkdirSync(path.join(dayDir(date), 'text'), { recursive: true });
  }

  function readItems(date) {
    try {
      const text = fs.readFileSync(fileOf(date, 'items.jsonl'), 'utf8');
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 追加并按 id 去重（同日重复采集不会写两遍）。 */
  function appendItems(date, items) {
    if (!items.length) return { added: 0, skipped: 0 };
    ensureDay(date);
    const seen = new Set(readItems(date).map((it) => it.id));
    const fresh = [];
    let skipped = 0;
    for (const item of items) {
      if (!item.id || seen.has(item.id)) {
        skipped += 1;
        continue;
      }
      seen.add(item.id);
      fresh.push(item);
    }
    if (fresh.length) {
      fs.appendFileSync(fileOf(date, 'items.jsonl'), fresh.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf8');
    }
    return { added: fresh.length, skipped };
  }

  function saveRaw(date, id, body) {
    ensureDay(date);
    const file = path.join(dayDir(date), 'raw', `${id}.html`);
    writeAtomic(file, String(body ?? ''));
    return file;
  }

  function saveText(date, id, text) {
    ensureDay(date);
    const file = path.join(dayDir(date), 'text', `${id}.md`);
    writeAtomic(file, String(text ?? ''));
    return file;
  }

  function readText(date, id) {
    try {
      return fs.readFileSync(path.join(dayDir(date), 'text', `${id}.md`), 'utf8');
    } catch {
      return '';
    }
  }

  function writeManifest(date, manifest) {
    ensureDay(date);
    writeAtomic(fileOf(date, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  function readManifest(date) {
    return readJsonSafe(fileOf(date, 'manifest.json'), null);
  }

  function writeBrief(date, markdown, sourcesMarkdown = '') {
    ensureDay(date);
    writeAtomic(fileOf(date, 'brief.md'), markdown);
    if (sourcesMarkdown) writeAtomic(fileOf(date, 'brief.sources.md'), sourcesMarkdown);
  }

  function readBrief(date) {
    try {
      return fs.readFileSync(fileOf(date, 'brief.md'), 'utf8');
    } catch {
      return '';
    }
  }

  function readState() {
    return readJsonSafe(path.join(root, 'state.json'), {
      lastRunDate: '',
      lastResult: '',
      lastError: '',
      retryCount: 0,
      updatedAt: '',
    });
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
    fs.mkdirSync(root, { recursive: true });
    writeAtomic(path.join(root, 'state.json'), JSON.stringify(next, null, 2));
    return next;
  }

  function readIndex() {
    return readJsonSafe(path.join(root, 'index.json'), { days: [] });
  }

  /** 索引只留最近 60 天，更早的目录内容不动（按月归档是 P2）。 */
  function updateIndex(date, summary) {
    const index = readIndex();
    const days = (index.days || []).filter((row) => row.date !== date);
    days.push({ date, ...summary });
    days.sort((a, b) => (a.date < b.date ? 1 : -1));
    const kept = days.slice(0, 60);
    fs.mkdirSync(root, { recursive: true });
    writeAtomic(path.join(root, 'index.json'), JSON.stringify({ days: kept }, null, 2));
    return kept;
  }

  function listDays() {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => (a < b ? 1 : -1));
    } catch {
      return [];
    }
  }

  return {
    root,
    dayDir,
    ensureDay,
    readItems,
    appendItems,
    saveRaw,
    saveText,
    readText,
    writeManifest,
    readManifest,
    writeBrief,
    readBrief,
    readState,
    writeState,
    readIndex,
    updateIndex,
    listDays,
  };
}
