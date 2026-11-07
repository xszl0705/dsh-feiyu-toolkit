/**
 * dsh-memory-unified — 检索/判定引擎（纯函数 + 一点统计，不引模型、不联网）
 *
 * 中文没有空格，所以 tokenizer 走「ASCII 词 + 连续汉字 bigram」：
 *   "回答要短一点" → [回答, 答要, 要短, 短一, 一点, 回答要短一点]
 *
 * 0.3 的改动（对应设计说明书 P0）：
 *   1. 拒答闸：没有任何词面命中的条目直接跳过，不再靠 importance 底分凑数
 *   2. 敏感信息硬否决：judge 命中机密正则时直接 keep=false
 *   3. SimHash + 汉明距离 + Jaccard，用于写入去重/知识更新判定
 */

const STOPWORDS = new Set([
  '的', '了', '是', '在', '就', '和', '与', '也', '都', '很', '我', '你', '他', '她', '它',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'it', 'this', 'that',
])

const PUNCT = /[\s,.;:!?，。；：！？、"'“”‘’()（）\[\]{}<>《》/\\|`~@#$%^&*+=_-]+/u

/** 默认拒答阈值：低于这个分数就当没查到。 */
export const DEFAULT_MIN_SCORE = 0.08

export function assertMemorySafe(text) {
  const value = String(text || '').trim()
  if (!value || judgeWorthiness(value).blocked) {
    const error = new Error(!value ? 'MEMORY_EMPTY' : 'MEMORY_SENSITIVE')
    error.code = error.message
    throw error
  }
  return value
}

export function tokenize(text) {
  const raw = String(text || '').toLowerCase()
  const tokens = new Set()
  for (const chunk of raw.split(PUNCT)) {
    if (!chunk) continue
    if (/^[a-z0-9][a-z0-9._-]*$/.test(chunk)) {
      if (chunk.length > 1 && !STOPWORDS.has(chunk)) tokens.add(chunk)
      continue
    }
    // 汉字串：保留整串 + 相邻二字
    const cjk = chunk.replace(/[^\u4e00-\u9fff]/g, '')
    if (cjk.length >= 2) {
      if (cjk.length <= 8 && !STOPWORDS.has(cjk)) tokens.add(cjk)
      for (let i = 0; i < cjk.length - 1; i += 1) {
        const bigram = cjk.slice(i, i + 2)
        if (!STOPWORDS.has(bigram)) tokens.add(bigram)
      }
    } else if (cjk.length === 1 && !STOPWORDS.has(cjk)) {
      tokens.add(cjk)
    }
  }
  return [...tokens]
}

/** 查询词命中权重之和（长度≥2 记 1，单字记 0.4）。 */
export function hitWeight(queryTokens, targetTokens) {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0
  const target = new Set(targetTokens)
  let hit = 0
  for (const token of queryTokens) {
    if (target.has(token)) hit += token.length >= 2 ? 1 : 0.4
  }
  return hit
}

export function overlapScore(queryTokens, targetTokens) {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0
  const hit = hitWeight(queryTokens, targetTokens)
  return hit / Math.sqrt(queryTokens.length * targetTokens.length)
}

function isActive(item) {
  return !item.status || item.status === 'active'
}

/** 在全部文件夹里检索，返回按分数排序的命中条目。无词面命中即拒答。 */
export function searchFolders(folders, query, { limit = 8, minScore = DEFAULT_MIN_SCORE, includeInactive = false, visibility = '' } = {}) {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []
  const wantVisibility = String(visibility || '').trim()
  const hits = []
  for (const folder of folders) {
    const folderTokens = tokenize([folder.name, ...(folder.keywords || [])].join(' '))
    const folderScore = overlapScore(queryTokens, folderTokens)
    for (const item of folder.items || []) {
      if (!includeInactive && !isActive(item)) continue
      if (wantVisibility && (item.visibility || 'private') !== wantVisibility) continue
      const itemTokens = tokenize([item.text, ...(item.keywords || []), item.category || ''].join(' '))
      const hit = hitWeight(queryTokens, itemTokens)
      if (hit <= 0) continue // 拒答闸：一个词都没命中就别拿出来
      const overlap = overlapScore(queryTokens, itemTokens)
      const score = overlap + folderScore * 0.5 + (item.importance || 0.5) * 0.05
      if (score < minScore) continue
      hits.push({
        folder: folder.name,
        folderId: folder.id,
        id: item.id,
        text: item.text,
        category: item.category,
        importance: item.importance,
        createdAt: item.createdAt,
        score: Number(score.toFixed(4)),
        hitRatio: Number((hit / queryTokens.length).toFixed(3)),
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
  return hits.slice(0, limit)
}

/** 找与某条记忆关键词重叠的其它记忆。 */
export function relatedItems(folders, { id, text }, { limit = 6 } = {}) {
  let anchor = null
  for (const folder of folders) {
    const found = (folder.items || []).find((item) => item.id === id)
    if (found) {
      anchor = { item: found, folder }
      break
    }
  }
  const anchorText = text || (anchor ? anchor.item.text : '')
  const anchorTokens = tokenize([anchorText, ...(anchor ? anchor.item.keywords || [] : [])].join(' '))
  if (anchorTokens.length === 0) return []
  const out = []
  for (const folder of folders) {
    for (const item of folder.items || []) {
      if (!isActive(item)) continue
      if (anchor && item.id === anchor.item.id) continue
      const score = overlapScore(anchorTokens, tokenize([item.text, ...(item.keywords || [])].join(' ')))
      if (score > 0.01) {
        out.push({ folder: folder.name, id: item.id, text: item.text, score: Number(score.toFixed(4)), createdAt: item.createdAt })
      }
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

const SENSITIVE = /(密码|密钥|api[\s_-]?key|secret|token|身份证|银行卡|信用卡|私钥|password)/i

/** 「这条值不值得记」的启发式判定（敏感信息直接否决）。 */
export function judgeWorthiness(text) {
  const value = String(text || '').trim()

  if (SENSITIVE.test(value)) {
    return {
      keep: false,
      blocked: true,
      score: 0,
      reasons: ['疑似敏感信息（密码/密钥/证件/银行卡），默认拒绝写入记忆库'],
    }
  }

  const reasons = []
  let score = 0

  if (value.length >= 12) {
    score += 0.3
    reasons.push('信息量够（≥12 字）')
  } else {
    reasons.push('太短，可能只是寒暄')
  }

  if (/(记住|以后|下次|每次|不要|必须|禁止|偏好|习惯|我是|我叫|我的|记住我)/.test(value)) {
    score += 0.35
    reasons.push('含长期约定/偏好用语')
  }
  if (/(今天|刚才|临时|这次|现在)/.test(value)) {
    score -= 0.2
    reasons.push('含临时性时间词，可能很快过时')
  }
  if (/[?？]$/.test(value)) {
    score -= 0.15
    reasons.push('是一条提问')
  }
  if (/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}/.test(value)) {
    score += 0.1
    reasons.push('带具体时间点')
  }

  const rounded = Math.max(0, Math.min(1, Number(score.toFixed(2))))
  return { keep: rounded >= 0.4, score: rounded, reasons }
}

// ---------------------------------------------------------------- SimHash

function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = (1n << 64n) - 1n
  for (let i = 0; i < str.length; i += 1) {
    hash ^= BigInt(str.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash
}

/** 64 位 SimHash（bigram 特征）。返回 BigInt。 */
export function simhash64(text) {
  const tokens = tokenize(text)
  if (tokens.length === 0) return 0n
  const vec = new Array(64).fill(0)
  for (const token of tokens) {
    const h = fnv1a64(token)
    for (let bit = 0; bit < 64; bit += 1) {
      vec[bit] += ((h >> BigInt(bit)) & 1n) === 1n ? 1 : -1
    }
  }
  let out = 0n
  for (let bit = 0; bit < 64; bit += 1) {
    if (vec[bit] > 0) out |= 1n << BigInt(bit)
  }
  return out
}

/** 两个 SimHash 的汉明距离。 */
export function hamming64(a, b) {
  let x = BigInt(a) ^ BigInt(b)
  let count = 0
  while (x) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

/** 两个 token 集合的 Jaccard 相似度。 */
export function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens)
  const b = new Set(bTokens)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}
