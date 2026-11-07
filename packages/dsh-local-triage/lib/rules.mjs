/**
 * L0 规则层：纯函数，不花 token、不花延迟。
 *
 * 设计原则（顺序即优先级）：
 *  1. frontier 规则先跑且偏保守 —— 误分流是能力下降，比多花几分钱严重得多
 *  2. local 规则必须极窄 —— 只放"确认类"短回复，宁漏不错
 *  3. 返回 null 表示"判不了"，交给 L1 本地模型
 *
 * 这一层在真实会话里通常能吃下 30~50% 的请求，且完全免费。
 */

export const TIERS = ['local', 'cheap', 'frontier']

// 命中即升到 frontier：需要多步、跨文件、或结果必须可靠
const FRONTIER_PATTERNS = [
  /重构|重写|迁移|架构|排查|定位|根因|为什么|原因|分析一下|分析下|规划|评估|回顾/,
  /对比|权衡|取舍|同时进行|分别/,
  /(设计|出|给|拟|制定|整理|出具).{0,8}方案|方案设计|方案(有哪些|有什么)/,
  /帮我(做|写|改|实现)(一?个|下)?(项目|模块|系统|插件|工具)/,
  /报错|崩溃|跑不起来|不生效|没反应|修复一下|打不开|占位|显示异常/,
  /检索|调研|搜集|上网搜|网上.{0,4}(方案|资料)/,
  // 系统级变更：这类即使语句很短，也不是"回一句话"能了事的
  /开机自启|自动登录|卸载|停用|禁用|设置为/,
]

// 失败类：单纯报"失败"是要排障（frontier）；
// 但"失败几次"是在问次数（cheap）——数量词优先。
const FAILURE = /失败|报错|异常/
const COUNTER = /几次|几回|多少次|几个/

// 命中降到 cheap：单点、有明确产出物、不需要跨系统
const CHEAP_PATTERNS = [
  /翻译|摘要|总结|概括|列一下|列个|统计|数一下|算一下|替换|查找|搜一下|检索一下/,
  /格式(化|转换)|转(成|为)\s*\w+|改(个)?名(字)?|重命名/,
  /怎么(用|写|读|配)|是什么|啥意思|有什么区别|区别|哪个好/,
  /写个?正则|补个?注释|几次|多少个?|提高/,
]

// local 白名单：只认"整条消息就是这个短语"。
// 这些是状态回执与社交应答，形态固定，用白名单比用模型可靠。
const LOCAL_PATTERNS = [
  /^(好|好的|好滴|嗯|嗯嗯|收到|收到啦|明白|明白了|知道了|了解|行|可以|谢谢|多谢|感谢|在吗|在不在|ok|okay|thx|thanks|hi|hello|你好|早|晚安|辛苦了|亲亲|贴贴|摸摸我的鱼|我饿了|测试|已重启|已登录|已过期|已发|未发生变化|过期|没弹)[。.!！?？~～\s]*$/i,
]

// 指代未具名对象 + 疑问：看着像一句话，其实必须看代码/文件/上文才能答。
// 实测 4B 会以 0.95 置信度把「这个函数是干什么的」判成 local —— 必须由规则拦下。
const REFERENTIAL = /这(个|段|里|些|块|行|句|份|张)|上面|刚才|前面|那个|上述/
const QUESTION = /干什么|做什么|啥意思|是什么|怎么|如何|为什么|能不能|可不可以|[吗呢？?]/

function normalize(req) {
  const text = String(req?.text ?? '').trim()
  return {
    text,
    turns: Number(req?.turns ?? 0) || 0,
    tools: Array.isArray(req?.tools) ? req.tools : [],
    attachments: Number(req?.attachments ?? 0) || 0,
  }
}

/**
 * @param {{text:string, turns?:number, tools?:string[], attachments?:number}} req
 * @param {{maxTurns?:number, maxChars?:number}} [opts]
 * @returns {{tier:string|null, why:string}}
 */
export function ruleTier(req, opts = {}) {
  const maxTurns = Number(opts.maxTurns ?? 6)
  const maxChars = Number(opts.maxChars ?? 1200)
  const r = normalize(req)

  if (!r.text) return { tier: null, why: 'empty' }

  // ---- 1. frontier（保守优先）----
  if (r.attachments > 0) return { tier: 'frontier', why: 'attachment' }
  if (r.text.length > maxChars) return { tier: 'frontier', why: 'too-long' }
  if (r.turns >= maxTurns) return { tier: 'frontier', why: 'long-conversation' }
  if (r.tools.length >= 8) return { tier: 'frontier', why: 'many-tools' }

  // 失败类要先排除"问次数"
  if (FAILURE.test(r.text) && !COUNTER.test(r.text)) {
    return { tier: 'frontier', why: 'failure' }
  }

  for (const re of FRONTIER_PATTERNS) {
    if (re.test(r.text)) return { tier: 'frontier', why: 'frontier-keyword' }
  }

  // ---- 2. 指代型提问：不能判 local（必须看上下文）----
  if (REFERENTIAL.test(r.text) && QUESTION.test(r.text)) {
    return { tier: 'cheap', why: 'referential' }
  }

  // ---- 3. local（极窄）----
  if (r.text.length <= 24) {
    for (const re of LOCAL_PATTERNS) {
      if (re.test(r.text)) return { tier: 'local', why: 'ack' }
    }
  }

  // ---- 4. cheap ----
  for (const re of CHEAP_PATTERNS) {
    if (re.test(r.text)) return { tier: 'cheap', why: 'cheap-keyword' }
  }

  return { tier: null, why: 'undecided' }
}

/**
 * 规则覆盖率诊断：给出每条规则命中的样本数，用于调阈值。
 * @param {Array<{text:string,turns?:number,tools?:string[],attachments?:number}>} samples
 */
export function ruleCoverage(samples, opts = {}) {
  const hits = {}
  let undecided = 0
  for (const sample of samples) {
    const r = ruleTier(sample, opts)
    if (!r.tier) { undecided += 1; continue }
    hits[r.why] = (hits[r.why] || 0) + 1
  }
  const total = samples.length || 1
  return { total: samples.length, hits, undecided, coverage: 1 - undecided / total }
}
