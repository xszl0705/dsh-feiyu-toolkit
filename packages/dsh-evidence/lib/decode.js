/**
 * lib/decode.js — 响应解码
 *
 * 硬规则（实测得出，见 docs/research/00-probe-log.md）：
 *   1. 禁用 Response.text()：它固定按 UTF-8 解码、忽略 charset 声明
 *   2. 一律 arrayBuffer + TextDecoder(按 charset 声明)
 *   3. 出现 U+FFFD 则回退 gb18030 / big5，取替换字符最少者
 *   4. 终端显示不算证据；判定只读返回值
 */

const REPLACEMENT = '\uFFFD';

/** 常见的服务端固化乱码模式（不是编码问题，是数据本身坏了） */
const MOJIBAKE_PATTERNS = [
  /锟斤拷/,
  /锼斤拷/,
  /\uFFFD{2,}/,
  /Ã[¤¥¦§¨©ª«¬]/,
  /â€[\u0099\u009C\u009D]/,
];

export function countReplacements(text) {
  if (!text) return 0;
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT) n += 1;
  return n;
}

export function parseCharset(contentType) {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType || '');
  return m ? m[1].toLowerCase() : null;
}

export function looksMojibake(text) {
  if (!text) return false;
  return MOJIBAKE_PATTERNS.some((re) => re.test(text));
}

function tryDecode(buf, enc) {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} contentType 响应的 Content-Type
 * @returns {{text:string, encoding:string, declared:string|null, replacementChars:number, encodingOk:boolean, mojibake:boolean}}
 */
export function decodeBody(bytes, contentType) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const declared = parseCharset(contentType);
  const first = declared || 'utf-8';

  let best = tryDecode(buf, first) ?? '';
  let bestBad = countReplacements(best);
  let bestEnc = first;

  if (bestBad > 0) {
    for (const enc of ['gb18030', 'big5', 'utf-8']) {
      if (enc === first) continue;
      const cand = tryDecode(buf, enc);
      if (cand === null) continue;
      const bad = countReplacements(cand);
      if (bad < bestBad) {
        best = cand;
        bestBad = bad;
        bestEnc = enc;
      }
    }
  }

  return {
    text: best,
    encoding: bestEnc,
    declared,
    replacementChars: bestBad,
    encodingOk: bestBad === 0,
    mojibake: looksMojibake(best),
  };
}

/**
 * 按 charsest 解码后做一次「体检」：空体、登录墙、验证码
 * @returns {{isArticle:boolean, loginWall:boolean, captcha:boolean, tooShort:boolean}}
 */
export function assessQuality(text, contentType) {
  const t = String(text || '');
  const len = t.trim().length;
  const lower = t.toLowerCase();
  return {
    isArticle: /html|xml|text/i.test(contentType || '') && len > 200,
    loginWall:
      /请(先)?登录|登录后(查看|继续)|sign in to continue|log in to view/i.test(t),
    captcha: /验证码|人机验证|captcha|are you a robot|安全检查/i.test(t) || /cf-challenge/i.test(lower),
    tooShort: len < 120,
  };
}
