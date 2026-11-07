# dsh-budget-watch

看会话的 **token 预算**：跑了几步、花了多少、每步多重、缓存还灵不灵，以及**该不该交接**。

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

所以「知道自己在第几步」比「事后看账单」有用得多。

## 一个工具，三个 action

只有一个工具 `budget`，靠 `action` 分流（原来的 `budget_status` / `budget_sessions` / `budget_advice` 不再注册）：

| action | 干什么 | 参数 |
|---|---|---|
| `status` | 看当前会话：步数、累计消耗、每步均值、缓存命中率、是否该交接 | `stepsWarn`（默认 200）、`stepsHard`（默认 300） |
| `sessions` | 列最近几天各会话消耗，按总量降序，用来找「哪次最贵」 | `days`（默认 1）、`limit`（默认 10） |
| `advice` | 出交接建议：该不该切、能省多少、怎么切（只输出文字） | 无 |

返回对象都带 `action` 回显；未知 action 返回 `{ ok: false, action, error: "未知 action：<action>" }`。

### `budget({ action: 'status' })`

看当前会话。

```
🟡 接近交接线｜会话 95b11640｜553 步
累计 198,027,045 token（新输入 89,359,436 + 缓存读 108,238,336 + 输出 429,273）
每步均值 357,320｜单步最大 725,063｜缓存命中 54.8%
触发：步数 553 ≥ 500
```

返回字段：`action` / `session` / `steps` / `total` / `input` / `cache` / `output` / `perStep` / `maxStep` / `cacheRate` / `level` / `alerts`。

`level` 三档：`ok` / `warn`（软线）/ `hard`（硬线）。

### `budget({ action: 'sessions', days, limit })`

列最近几天各会话的消耗，按总量降序。用来找「哪次最贵」。

```js
budget({ action: 'sessions', days: 7, limit: 10 })
```

### `budget({ action: 'advice' })`

出交接建议：该不该切、能省多少、怎么切。

**只输出文字，不执行任何操作。**

## 接口调用表

| 调用 | 返回 |
|---|---|
| `budget({ action: 'status' })` | `{ action, session, steps, total, input, cache, output, perStep, maxStep, cacheRate, level, alerts, error }` |
| `budget({ action: 'status', stepsWarn: 200, stepsHard: 300 })` | 同上，阈值只在本次调用生效 |
| `budget({ action: 'sessions', days: 7, limit: 10 })` | `{ action, count, rows: [{ session, steps, total, perStep, cacheRate }], error }` |
| `budget({ action: 'advice' })` | `{ action, level, text, error }` |
| 未知 action | `{ ok: false, action, error: '未知 action：<action>' }` |

## 阈值

`config.json`：

| 键 | 默认 | 含义 |
|---|---|---|
| `stepsWarn` | 200 | 步数软线 |
| `stepsHard` | 300 | 步数硬线 |
| `tokensWarn` | 200000000 | 累计 token 软线（2 亿） |
| `perStepWarn` | 400000 | 每步均值软线 |
| `cacheRateWarn` | 0.7 | 缓存命中率低于这个值就告警（且步数 > 50） |

**为什么 200/300 步**：实测长会话每步均值随步数线性上涨（85 步 8.5 万、500 步 34 万、600 步 37 万），300 步内交接能把二次增长截成两段、约省一半。200 步提醒、300 步必须交接——交接线在压缩触发之前，不是之后。

## 数据从哪来

`~/.dsh/sessions/**/session.v4.jsonl.zstd` 里 `assistant/message` 帧的 `data.usage`：

```
{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
```

日志是多帧 zstd 拼接，按魔数 `28 B5 2F FD` 切帧、逐帧解压（Node 的流式解压会在某些帧上报 `Unknown frame descriptor`）。

## 已知限制

- 只看本机会话日志，日志删了就看不到了
- 成本估算按实测比例推，**不是真实账单**
- 不统计非 LLM 成本（工具执行、IO）
- 不区分模型（不同模型单价不同，这里只算 token 量）

## 装

```powershell
# 先装进试验区验证
playground_install({ profile: 'verifyx', packageName: 'dsh-budget-watch', sourceDir: '<你的插件根目录>/dsh-budget-watch' })
```

装完**重启才生效**（那是你的动作）。

## 许可

MIT。

## 变更记录


- 2026-11-04：阈值统一为 200/250（warn/hard）。`lib/tools.js` 兜底、`config.json`、`tools/budget-watch.mjs` 三处同改；此前 config 是 200/300 而代码兜底仍是 500/800。
- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-01：把 `budget_status` / `budget_sessions` / `budget_advice` 三个工具合并为单入口 `budget`（`action=status|sessions|advice`），旧名不再注册；参数名、默认值与返回字段均未变。
