# dsh-budget-watch

> 版本 0.3.1

看会话的 **token 预算**：跑了几步、花了多少、每步多重、**现在上下文有多重**、缓存还灵不灵，以及**该不该交接**。

纯只读。不改配置、不切会话、不重启、不禁用插件——那些是开关，归人。

## 为什么需要它

实测数据（2026-11-01）：

| 会话步数 | 每步 token |
|---|---|
| 20 步 | 5.6 万 |
| 240 步 | 17.2 万 |
| 553 步 | 35.7 万 |
| 1765 步 | 44 万 |

**同样一件事，在 1765 步的会话里做，成本是 20 步会话的 8 倍。**

更糟的是：上下文涨到阈值会触发压缩，压缩后整个上下文被重写，**前缀缓存全部失效**。实测长会话的缓存命中会从 93% 掉到 55%，新输入因此翻 6 倍。

所以「知道自己在第几步、上下文有多重」比「事后看账单」有用得多。

## 为什么是双条件（2026-11-08）

只看步数会漏掉一类会话：**步数没到 250，但上下文已经压到 480k**。实测 2026-11-05 有两个会话就是这种形态——221 步峰值 485,874、266 步峰值 683,197，两个会话吃掉当天非缓存输入的 94.9%。

反过来，只看上下文也不够：短会话即使上下文大，也未必需要交接（可能只是读了一份大材料）。

所以判定同时看**步数**和**最近一步的输入规模**（输入 + 缓存读，即这轮真正送进模型的量）。

## 工具

只有一个工具 `budget`，靠 `action` 分流（原来的 `budget_status` / `budget_sessions` / `budget_advice` 不再注册）：

| action | 干什么 | 参数 |
|---|---|---|
| `status` | 看当前会话：步数、累计、每步均值、最近上下文、缓存命中、是否该交接 | `stepsWarn`（200）、`stepsHard`（250）、`contextWarn`（250000）、`contextHard`（400000） |
| `sessions` | 列最近几天各会话消耗，按总量降序，用来找「哪次最贵」 | `days`（默认 1）、`limit`（默认 10） |
| `shape` | 看当前会话的**请求块结构**，定位缓存前缀断在哪一块 | 无 |
| `advice` | 出交接建议：该不该切、能省多少、怎么切（只输出文字） | 无 |

返回对象都带 `action` 回显；未知 action 返回 `{ ok: false, action, error: "未知 action：<action>" }`。

### 当前会话怎么定位

优先用**会话 id**：插件监听 `session/event`，记住当前主会话（跳过有 `parentId` 的子代理会话），再按 `~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd` 直接取文件。

拿不到 id 才退回「最近改动的日志」——这条兜底会被子代理、后台会话的 mtime 干扰，所以返回里的 `via` 会写明是 `session-id` 还是 `mtime`。

### `budget({ action: 'status' })`

看当前会话。

```
🟠 先准备交接｜会话 83448797｜212 步
累计 158,027,045 token（新输入 61,359,436 + 缓存读 96,238,336 + 输出 429,273）
每步均值 357,320｜单步最大 725,063｜缓存命中 60.8%
最近一步上下文 268,400（新输入 12,340，缓存 95.4%）
触发：步数 212 ≥ 200，先准备账本
```

返回字段：`action` / `session` / `via` / `steps` / `total` / `input` / `cache` / `output` / `perStep` / `maxStep` / `context` / `lastInput` / `lastCacheRate` / `cacheRate` / `level` / `alerts`。

`level` 四档：

| level | 含义 | 该做什么 |
|---|---|---|
| `ok` | 没超线 | 正常跑 |
| `prepare` | 200 步 / 250k 上下文 / 连续突发 | 先把账本写好，大块新活留到新会话 |
| `warn` | 累计、每步均值或缓存命中超老软线 | 留意，不一定停 |
| `hard` | 250 步 或 400k 上下文 | 收尾，在回复边界交接 |

### `budget({ action: 'sessions', days, limit })`

列最近几天各会话的消耗，按总量降序。用来找「哪次最贵」。

```js
budget({ action: 'sessions', days: 7, limit: 10 })
```

### `budget({ action: 'shape' })`

看当前会话的**请求块结构**，定位缓存前缀断在哪一块。只算长度与类型，**不读正文**。

```
🧩 会话 6c27c342｜累计 1,319,755 字符｜221 步
🔴 轮首缓存冻结在 125,568——断点落在第 71 块：user/runtime-context（9,489 字符，turn 2）

最近几轮首步：
  turn  28  缓存    125,568  / 上下文    456,895  27.5%
  turn  29  缓存    125,568  / 上下文    467,421  26.9%
```

原理：本机实测 1 token ≈ 1 字符，所以「轮首缓存命中数」约等于当时的累计字符数；拿这个值回查块序列，就能说出断点落在哪一类块上（system / runtime-context / assistant / tool-result）。

返回字段：`ok` / `action` / `session` / `via` / `steps` / `totalChars` / `frozen` / `freezeValue` / `breakAt` / `turns`。

### `budget({ action: 'advice' })`

出交接建议：该不该切、能省多少、怎么切。

**只输出文字，不执行任何操作。**

## 接口调用表

| 调用 | 返回 |
|---|---|
| `budget({ action: 'status' })` | `{ action, session, via, steps, total, input, cache, output, perStep, maxStep, context, lastInput, lastCacheRate, cacheRate, level, alerts, error }` |
| `budget({ action: 'status', stepsWarn: 200, contextHard: 350000 })` | 同上，阈值只在本次调用生效 |
| `budget({ action: 'sessions', days: 7, limit: 10 })` | `{ action, count, rows: [{ session, steps, total, perStep, context, cacheRate }], error }` |
| `budget({ action: 'advice' })` | `{ action, level, text, error }` |
| 未知 action | `{ ok: false, action, error: '未知 action：<action>' }` |

## 阈值

`config.json`（插件的 `lib/tools.js` 兜底与 `<workspace>\tools\budget-watch.mjs` 共用同一套判定，不再三处各写一遍）：

| 键 | 默认 | 含义 |
|---|---|---|
| `stepsWarn` | 200 | 步数软线 → `prepare` |
| `stepsHard` | 250 | 步数硬线 → `hard` |
| `contextWarn` | 250000 | 最近一步上下文软线 → `prepare` |
| `contextHard` | 400000 | 最近一步上下文硬线 → `hard`（即使步数没到 250） |
| `tokensWarn` | 200000000 | 累计 token 软线（2 亿） |
| `perStepWarn` | 400000 | 每步均值软线 |
| `cacheRateWarn` | 0.7 | 缓存命中率低于这个值就告警（且步数 > 50） |
| `burstInput` | 100000 | 突发判定的非缓存输入门槛 |
| `burstCacheRate` | 0.8 | 突发判定的缓存占比上限 |
| `burstCount` | 2 | 连续几步算突发 |

**为什么 200/250 步**：实测长会话每步均值随步数线性上涨（85 步 8.5 万、500 步 34 万、600 步 37 万），250 步内交接能把二次增长截成两段、约省一半。交接线在压缩触发之前，不是之后。

**为什么 250k/400k 上下文**：按 1M 级上下文窗口的试验值定。窗口或模型变了要重算，小窗口用更小的数。400k 是「再往下就是纯烧钱」的位置——到了就在完整回复结尾交接，不要等步数。

**为什么抓突发**：连续多了步「非缓存输入 ≥100k 且缓存占比 <80%」，说明前缀缓存失效了（压缩、消息重写、请求构造变化都可能是原因）。这时不是「再跑两步看看」，而是先留诊断摘要、看上下文变化。

## 数据从哪来

`~/.dsh/sessions/**/session.v4.jsonl.zstd` 里 `assistant/message` 帧的 `data.usage`：

```
{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
```

- `context` = 最近一条 usage 的 `inputTokens + cacheReadTokens`
- `lastInput` = 最近一条的 `inputTokens`（非缓存）
- `recent` = 最近 8 步的 `{ input, cache }`，用来算突发

日志是多帧 zstd 拼接，按魔数 `28 B5 2F FD` 切帧、逐帧解压（Node 的流式解压会在某些帧上报 `Unknown frame descriptor`）。

## 已知限制

- 只看本机会话日志，日志删了就看不到了
- 拿不到会话 id 时退回 mtime 猜，可能猜成子代理/后台会话（`via=mtime` 会标出来）
- 成本估算按实测比例推，**不是真实账单**
- 不统计非 LLM 成本（工具执行、IO）
- 不区分模型（不同模型单价不同，这里只算 token 量）
- **不会主动推送**：工具只在被调用时返回结果。要在每轮自动提醒，得挂到轮次结束事件上，那是另一件事（需要单独确认，且必须去重、冷却、允许用户停）

## 装

```powershell
# 先装进试验区验证
playground_install({ profile: 'verifyx', packageName: 'dsh-budget-watch', sourceDir: '<你的插件根目录>/dsh-budget-watch' })
```

装完**重启才生效**（那是你的动作）。

## 许可

MIT。

## 变更记录

- 2026-11-14：**阈值一致性从「口头约定」变成判据**。新增 `tests/threshold-parity.test.mjs`（3 项：`DEFAULTS` 键齐全、`config.json` 与兜底逐键一致、工作区脚本 `tools/budget-watch.mjs` 与兜底一致——脚本不在时跳过，发布环境属正常）；`lib/tools.js` 的 `DEFAULTS` 改为导出以便直接比对；`package.json` 加 `scripts.test`。变异验证：把 `config.json` 的 `stepsWarn` 改成 201 → 测试红（`201 ≠ 200`），恢复后绿。同时把 README 工具章节标题从「一个工具，三个 action」统一为「工具」（判据按标题识别，自由标题会被判成「无工具章节」）。版本 0.3.0→0.3.1。
- 2026-11-10：校对文档与源码（此前 README 落后于实现）。
- 2026-11-08（二）：新增 `budget(action=shape)`——按会话事件流还原请求块结构，用「轮首缓存命中数 ≈ 累计字符数」反查缓存前缀断点落在哪一块。同轮把之前试过的「注册假 provider 抓请求体」方案整个删掉（那等于拿模型通道做手脚，会污染模型列表；探针应当是工具）。
- 2026-11-08：判定改为**步数 + 上下文双条件**。新增 `context` / `lastInput` / `lastCacheRate` / `recent`（`lib/usage.js`），`judge()` 加 `prepare` 档与突发检测，`createTools(config, hooks)` 接 `getSessionId`；`index.js` 监听 `session/event` 记当前主会话，不再只靠 mtime。阈值 250k/400k、突发 2×100k/缓存<80%。独立脚本 `tools/budget-watch.mjs` 改为复用本插件 `judge()`，消除三处阈值漂移（此前 config 200/250、脚本 200、README 写 300 三处不一致）。
- 2026-11-04：阈值统一为 200/250（warn/hard）。`lib/tools.js` 兜底、`config.json`、`tools/budget-watch.mjs` 三处同改；此前 config 是 200/300 而代码兜底仍是 500/800。
- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-01：把 `budget_status` / `budget_sessions` / `budget_advice` 三个工具合并为单入口 `budget`（`action=status|sessions|advice`），旧名不再注册；参数名、默认值与返回字段均未变。
