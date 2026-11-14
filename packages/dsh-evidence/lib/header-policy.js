/**
 * lib/header-policy.js — 按域 header 策略表
 *
 * 来源：docs/research/00-probe-log.md 与 01/03 域的实测。
 * 规则：遇到 401/403/406/412，先查此表重试一次；命中成功则写回（P1 落库）。
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 项目联络 UA（SEC 强制要求「名称 + 邮箱」） */
export const PROJECT_UA = 'dsh-evidence/0.1 (+contact@example.com)';

export const HEADER_TABLE = {
  'hq.sinajs.cn': {
    method: 'GET',
    headers: { Referer: 'https://finance.sina.com.cn' },
    note: '裸请求 403，带 Referer 200（实测 2026-11-11）',
  },
  'qt.gtimg.cn': {
    method: 'GET',
    headers: {},
    note: '响应声明 GBK，须 gb18030 解码',
  },
  'push2.eastmoney.com': {
    method: 'GET',
    headers: {},
    note: 'UTF-8，Node 直连 200（157–188ms）',
  },
  'datacenter-web.eastmoney.com': {
    method: 'GET',
    headers: {},
    note: 'UTF-8',
  },
  'www.cninfo.com.cn': {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
      'X-Requested-With': 'XMLHttpRequest',
    },
    note: 'GET 返回 500；POST + Referer 返回 200 JSON',
  },
  'data.sec.gov': {
    method: 'GET',
    headers: { 'User-Agent': PROJECT_UA },
    note: '强制要求「名称+邮箱」UA；空 UA 或浏览器 UA 一律 403',
  },
  'stats.bis.org': {
    method: 'GET',
    headers: { Accept: 'application/json, application/xml' },
    note: '缺 Accept 返回 406',
  },
  'www.piyao.org.cn': {
    method: 'GET',
    headers: {},
    note: '必须带 www. 前缀；裸域证书 ALTNAME 不匹配',
  },
};

export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function headerPolicy(url) {
  const host = domainOf(url);
  const hit = HEADER_TABLE[host];
  return {
    domain: host,
    method: hit?.method ?? 'GET',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(hit?.headers ?? {}),
    },
    note: hit?.note ?? '',
    known: Boolean(hit),
  };
}

/** 哪些状态码值得「查表重试一次」 */
export function shouldRetryWithPolicy(status) {
  return status === 401 || status === 403 || status === 406 || status === 412;
}
