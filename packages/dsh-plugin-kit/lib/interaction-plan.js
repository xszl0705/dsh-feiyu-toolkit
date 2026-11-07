/**
 * 表达计划（阶段 4.2）：按「活动」选择行为，不调模型、纯函数。
 *
 * 四类活动：
 * - chat    闲聊：接当前话题，允许短答，不强加总结
 * - work    工作：直接执行，结果导向，不在用户没问时铺陈过程
 * - explain 解释：给足因果与例子，长度由问题决定
 * - support 支持：先接住情绪，再判断是否需要帮助
 *
 * 规则优先级：用户显式要求 > 任务状态 > 关键词分类。
 * 2026-11-04：从技术档案 DSH-EXPRESSION-CLOSURE-20261104-V1 落地。
 */

export const ACTIVITIES = ['chat', 'work', 'explain', 'support']

const SUPPORT_RE = /(累|烦|难过|难受|心情|不想|崩溃|emo|委屈|生气|焦虑|压力|睡不着)/
const WORK_RE = /(帮我|整理|做|写|改|查|分析|生成|导出|修复|调研|搜集|列|总结成|翻译|部署|跑|建|安装|清理|对比)/
const EXPLAIN_RE = /(为什么|怎么|如何|是什么|原理|解释|区别|原因|凭什么|啥意思)/

/** 只按文本粗分活动；拿不准时返回 chat（保守，不强行立项）。 */
export function detectActivity(text = '') {
  const t = String(text || '')
  if (!t) return 'chat'
  if (SUPPORT_RE.test(t)) return 'support'
  if (WORK_RE.test(t)) return 'work'
  if (EXPLAIN_RE.test(t)) return 'explain'
  return 'chat'
}

/**
 * 生成表达计划。
 * @param {{activity?:string, audience?:'owner'|'group'|'stranger', channel?:string, userPreference?:string, taskState?:object|null}} input
 */
export function planInteraction({ activity, audience = 'owner', channel = 'qq', userPreference = '', taskState = null } = {}) {
  const text = String(userPreference || '')
  const act = ACTIVITIES.includes(activity) ? activity : detectActivity(text)
  const brief = /简短|短点|一句话|别太长|简单说/.test(text)
  const detailed = /详细|具体|展开|列依据|多讲/.test(text)

  const length = brief
    ? 'brief'
    : detailed
      ? 'detailed'
      : act === 'chat' || act === 'support'
        ? 'brief'
        : 'sufficient'

  return {
    activity: act,
    format: act === 'work' || act === 'explain' ? 'markdown' : 'text',
    length,
    addressForm: audience === 'owner' ? '你' : '您',
    questionNeeded: act === 'work' && !taskState,
    stateRef: Boolean(taskState),
    preserve: ['code', 'quotes', 'links', 'paths', 'tables', 'numbers'],
  }
}
