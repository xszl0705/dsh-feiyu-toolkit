/**
 * 离线回归集（50 条）。
 *
 * ⚠️ 重要：这批样本是"按真实会话形态构造的"，不是从真实日志里抽的。
 * 它只能证明规则与提示词的形状对不对，不能代替真实样本。
 * 上线前必须用真实会话替换/扩充到 100 条以上，重点补"模糊地带"。
 *
 * expect 的标注口径：
 *   local    —— 一句话确认即可，不需要工具与外部知识
 *   cheap    —— 单步、有明确产出物、不跨系统
 *   frontier —— 多步规划、跨文件、或结果必须高可靠
 */

const LONG = Array.from({ length: 60 }, (_, i) => `第${i + 1}段：这里是用户粘贴的一大段日志内容，包含时间戳、模块名和堆栈信息。`).join('')

export const GOLDEN = [
  // ---------- local（20）----------
  { id: 'g01', text: '好', turns: 1, expect: 'local' },
  { id: 'g02', text: '好的谢谢', turns: 1, expect: 'local' },
  { id: 'g03', text: '嗯', turns: 2, expect: 'local' },
  { id: 'g04', text: '收到', turns: 3, expect: 'local' },
  { id: 'g05', text: '在吗', turns: 1, expect: 'local' },
  { id: 'g06', text: 'OK', turns: 1, expect: 'local' },
  { id: 'g07', text: '谢谢', turns: 1, expect: 'local' },
  { id: 'g08', text: '晚安', turns: 1, expect: 'local' },
  { id: 'g09', text: '行', turns: 2, expect: 'local' },
  { id: 'g10', text: '知道了', turns: 1, expect: 'local' },
  { id: 'g11', text: '可以', turns: 1, expect: 'local' },
  { id: 'g12', text: '你好', turns: 1, expect: 'local' },
  { id: 'g13', text: '嗯嗯', turns: 4, expect: 'local' },
  { id: 'g14', text: '明白了', turns: 1, expect: 'local' },
  { id: 'g15', text: 'hi', turns: 1, expect: 'local' },
  { id: 'g16', text: '多谢', turns: 1, expect: 'local' },
  { id: 'g17', text: '早', turns: 1, expect: 'local' },
  { id: 'g18', text: '了解', turns: 1, expect: 'local' },
  { id: 'g19', text: '收到啦', turns: 2, expect: 'local' },          // 规则抓不到的边界样本
  { id: 'g20', text: '行吧那就这样', turns: 2, expect: 'local' },    // 规则抓不到的边界样本

  // ---------- frontier（15）----------
  { id: 'g21', text: '帮我重构一下这个模块，拆成三个文件', turns: 1, expect: 'frontier' },
  { id: 'g22', text: '排查一下为什么启动失败', turns: 1, expect: 'frontier' },
  { id: 'g23', text: '把整个插件从 CommonJS 迁移到 ESM', turns: 1, expect: 'frontier' },
  { id: 'g24', text: '设计一个降消耗方案，要能落地', turns: 1, expect: 'frontier' },
  { id: 'g25', text: '对比 vLLM 和 SGLang 的吞吐，给个选型建议', turns: 1, expect: 'frontier' },
  { id: 'g26', text: '这个报错怎么解决：Error: EACCES permission denied', turns: 1, expect: 'frontier' },
  { id: 'g27', text: '帮我写个完整的 QQ 机器人插件', turns: 1, expect: 'frontier' },
  { id: 'g28', text: '分析这段代码的性能瓶颈在哪', turns: 1, expect: 'frontier' },
  { id: 'g29', text: LONG, turns: 1, expect: 'frontier' },
  { id: 'g30', text: '继续', turns: 8, expect: 'frontier' },
  { id: 'g31', text: '看看这张图里写了什么', turns: 1, attachments: 1, expect: 'frontier' },
  { id: 'g32', text: '把刚才那些工具都用一遍', turns: 1, tools: ['a','b','c','d','e','f','g','h','i'], expect: 'frontier' },
  { id: 'g33', text: '先看看日志再决定要不要重启', turns: 1, expect: 'frontier' },
  { id: 'g34', text: '为什么群消息没同步过来', turns: 1, expect: 'frontier' },
  { id: 'g35', text: '评估一下现在的记忆系统还缺什么', turns: 1, expect: 'frontier' },

  // ---------- cheap（15）----------
  { id: 'g36', text: '翻译一下这段话：今天天气不错', turns: 1, expect: 'cheap' },
  { id: 'g37', text: '把这段 json 格式化成两空格缩进', turns: 1, expect: 'cheap' },
  { id: 'g38', text: '总结一下今天的日志', turns: 1, expect: 'cheap' },
  { id: 'g39', text: '改个名字：把 getUser 改成 fetchUser', turns: 1, expect: 'cheap' },
  { id: 'g40', text: '这个函数是干什么的', turns: 1, expect: 'cheap' },
  { id: 'g41', text: '搜一下 dsh 里有没有 11434', turns: 1, expect: 'cheap' },
  { id: 'g42', text: '统计一下今天的 token 消耗', turns: 1, expect: 'cheap' },
  { id: 'g43', text: '怎么配置 ollama 的 keep_alive', turns: 1, expect: 'cheap' },
  { id: 'g44', text: '列一下 plugins 目录里有哪些插件', turns: 1, expect: 'cheap' },
  { id: 'g45', text: '补个注释，写清楚这个参数是什么', turns: 1, expect: 'cheap' },
  { id: 'g46', text: '把 yaml 转成 json', turns: 1, expect: 'cheap' },
  { id: 'g47', text: '有什么区别：GQA 和 MQA', turns: 1, expect: 'cheap' },
  { id: 'g48', text: '算一下这个月大概花了多少钱', turns: 1, expect: 'cheap' },
  { id: 'g49', text: '写个正则可以匹配 2026-10-31 这种日期', turns: 1, expect: 'cheap' },
  { id: 'g50', text: '这段话摘要成三行', turns: 1, expect: 'cheap' },
]
