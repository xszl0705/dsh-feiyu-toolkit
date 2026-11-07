# dsh-feiyu-self

Self Model 与决策日志。对应 [自进化方案 v1](../docs/self-evolving-harness-tech-v1.md) 的 M0 + M1。

## 它回答什么

所有查询走同一个工具 `self`，用 `action` 选分支；`self_evolve` / `self_procedures` 的子动作走 `op`。

| 调用 | 回答 |
|---|---|
| `self(action='status')` | 我现在什么状态：身份、能力声明进度、各服务在线、最近错误 |
| `self(action='capabilities')` | 我实际会做什么（按插件列，缺 limits 的标 degraded） |
| `self(action='limits')` | 我不会什么、什么时候不该信我（声明 + 最近 7 天真实失败/拒绝） |
| `self(action='history')` | 我最近做过哪些决定（只含决策与结果，不含正文） |
| `self(action='check')` | 自检：快照新鲜度、缺失声明、缺 limits |
| `self(action='metrics')` | 最近 N 天的指标：回复率、刷屏率、拦截率、成本、延迟、自愈成功率，以及与滚动基线的对比；算不出来的明确标缺失 |
| `self(action='flags')` | 灰度开关：列当前 flag，或按 name + context 返回这一上下文下的变体（sticky 分桶） |
| `self(action='evolve', op='propose\|list\|report\|approve\|reject\|apply\|rollback', id?)` | 自进化流水线；只改 flags.json 的开关与权重，人设、配置、代码永远不动 |
| `self(action='procedures', op='list\|extract\|match')` | 程序性记忆：list 看已提炼经验、extract 从决策日志提炼、match 按上下文找相关经验；只提示不执行 |
| `self(action='context')` | 上下文用量：最近几次组装的预算、实际用量、压缩次数（当前返回缺 avgUsed/avgBudget/compressedRate 三个字段，已知 bug） |

## 数据在哪

```
~/.dsh/dafeiyu/self/snapshot.json      # 最新快照
~/.dsh/dafeiyu/self/capabilities.json  # 已声明的能力
~/.dsh/dafeiyu/self/changelog.jsonl    # 快照变化记录
~/.dsh/dafeiyu/decisions/<日期>.jsonl   # 决策日志
```

## 设计约束

1. **能力清单必须来自真实声明**，不手写；拿不到就标 `unknown`。
2. **决策日志只存决策与结果**，正文类字段（text/content/reply）在白名单里直接丢弃。
3. **不自动改代码、不碰人设与权限**；唯一能写的是 `flags.json` 的 `enabled / variants`，且必须走「候选 → 人审 → 三重验证 → 灰度 → 回滚」。

## 进化闭环（阶段 1.5）

- **诊断源**（1.5.1）：`diagnose()` 只看指标；`diagnoseFromSources()` 再聚合三路——各插件 `load.log` 里出现 ≥2 次的同一句、回归失败项、没进 `tests/verify.mjs` 清单的插件。纯规则，不调模型；`load.log` 只读最后 200 行。
- **单一候选制**（1.5.2）：同一时间只允许 1 个可应用候选在途（`MAX_ACTIVE_CHANGES`）。在途满了，新候选自动降级为提醒（带 `blockedBy`），不硬凑。单次改动规模：补丁 ≤ `MAX_DIFF_LINES`(50) 行、配置类 JSON ≤ `MAX_DIFF_CHARS`(2000) 字符。
- **三重验证器**（1.5.3）：`tripleVerify({ target, migration, full })` 三份证据各自出数（目标修复用例 / 同类迁移子集 / 全量 verify 净值）；缺一项或任一红都返回 `ok:false` 并列出 `blockers`。带 `verification` 的候选在 `apply()` 里会被拦。
- **变体档案**（1.5.4）：`pipeline.archiveVariant({ id, patch, diff, metrics })` 落 `variants/<id>/{patch.diff,diff.json,metrics.json}`，只保留最近 10 个，可 diff、可回滚。
- **变体运行**（1.5.5）：`lib/variants.js` 实现 Variant Runner——flag 是配置文件（`~/.dsh/dafeiyu/flags.json`），改文件即生效（按 mtime 缓存），关掉 flag 即回滚，不用重启；分桶用 sticky key（默认 `conversation`），同一个人不会同时收到两个版本。默认 flag 有 `route.modelHint` 与 `route.tier`（local-triage 分诊灰度，默认关；只把极窄确认类短句降级到本地模型，cheap/frontier 仍走大模型）。

## 给其他插件用

```js
// 声明自己的能力（apply 时调用一次）
const self = ctx.get?.('self') || globalThis[Symbol.for('dsh-feiyu-self.service')]
self?.declare({
  id: 'qq',
  intent: '收发 QQ 消息、群内接话',
  limits: ['不能主动加好友', '风控期不自动拉起'],
  failureModes: [{ code: 'NAPCAT_DOWN', meaning: 'ws 3001 不可达', retry: '退避重连' }],
  scope: ['group', 'private'],
})

// 记录一次决策
self?.record({ kind: 'route', choice: 'local', reason: '短句', cost: { tokens: 0 } })
```

服务名：`self`（`ctx.get('self')`），全局兜底：`Symbol.for('dsh-feiyu-self.service')`。

## 自检

```powershell
node tests/decisions.test.mjs
node tests/self-model.test.mjs
```

## 使用说明

**什么时候用**

- 想知道「我现在是什么状态 / 会什么 / 最近改了什么」→ `self(action='status')`、`self(action='capabilities')`
- 被问到「你哪件事失败过」「你什么时候不该信自己」→ `self(action='limits')`
- 想回看某个决定（为什么没回那条、为什么走了大模型）→ `self(action='history')`
- 每天收工 → `self(action='metrics')`；每周 → `self(action='procedures', op='extract')`
- 要开/关灰度实验 → `self(action='flags')`；要提改进建议 → `self(action='evolve', op='report')`

**工具**

| 调用 | 干什么 | 典型用法 |
|---|---|---|
| `self(action='status')` | 身份、能力数、服务在线、对话缓存 | 每天早上看一眼 |
| `self(action='capabilities')` | 按插件列能力 + 运行时状态 | 查「qq 连上了吗」「memory 多少条」 |
| `self(action='limits', days)` | 不会什么、哪类失败多 | 被追问「你行不行」时先看它 |
| `self(action='history', days, kind, limit)` | 决策流水 | `kind='memory'` 只看记忆写入 |
| `self(action='check')` | 快照新鲜度、缺声明的插件 | 改完插件跑一次 |
| `self(action='metrics', days)` | 回复率/刷屏/成本/延迟 + 基线对比 | 每天收工看一次 |
| `self(action='flags', name, context)` | 列灰度开关；带 context 求值 | `name='route.modelHint'` + `context={channel:'qq',conversation:'group:1'}` |
| `self(action='evolve', op, id)` | op=propose/list/report/approve/reject/apply/rollback | 一天一次 `op='report'`，看完再 `op='approve'` |
| `self(action='procedures', op, context, minRepeats)` | op=list/extract/match 经验库 | 每周 `op='extract'` 一次 |
| `self(action='context', limit)` | 上下文用量 | 查「上下文花在哪」 |

**什么时候别用**

- `self(action='status')` 不是聊天话题，是自检——别拿它回答「你好吗」
- 没有基线时 `self(action='metrics')` 的对比列全是「样本不足」，别误读
- `self(action='evolve', op='apply')` 只改 `flags.json`；改代码、改人设它都做不了，也不该做
- `self(action='procedures')` 只提炼不执行，真正避开坑要靠 M5 的 `propose` 去读它

## 变更记录



- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 与 `atomicWrite` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js`、`lib/atomic-write.js` 副本。
- 2026-11-03：`changes.json`、`flags.json`、应用前备份，以及 capability / snapshot 写入全部改原子写（`lib/atomic-write.js`：tmp + fsync + rename），进程中途被杀不会留下半截 JSON。
- 2026-11-01：10 个工具合并为单入口 `self(action)`。`self_status` / `self_capabilities` / `self_limits` / `self_history` / `self_check` / `self_metrics` / `self_flags` / `self_evolve` / `self_procedures` / `self_context` 旧名不再注册；`self_evolve`、`self_procedures` 原有的 `action` 参数改名为 `op`（取值集合不变），其余参数名与默认值不变。- 2026-11-04 · 诊断源降噪：load.log 只报含错误特征的行；数字码加词边界（`pid 40160` 曾被误判成 401）；排除 `.tmp-` 测试残留路径。诊断项从 60+ 降到 11。新增 `tests/evolution-loop.test.mjs`。
- 2026-11-05 · 新增 `lib/variants.js`（Variant Runner）：flag 改文件即生效、sticky 按 conversation 分桶、关 flag 即回滚；新增 `route.tier` 默认 flag（local-triage 分诊，默认关，只降级 local），`self(action='flags')` 的求值走它。
