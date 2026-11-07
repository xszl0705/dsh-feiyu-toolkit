# dsh-feiyu-brain

大肥鱼的认知中枢：注入防护、路由决策、上下文组装、逐条观测。

## 服务

`ctx.get('brain')` 或 `globalThis[Symbol.for('dsh-feiyu-brain.service')]`：

- `guard(text)` → `{blocked, reply}`
- `decideRoute(text, opts)` → `{route:'local'|'big', reason}`
- `shouldEscalate(reply, text)` → 原因字符串
- `buildContext({conversation, text, scope})` → `{memory, recent}`
- `recordStats(row)` / `summary(date)`

## HTTP

- `POST /dsh-feiyu-brain/guard`
- `POST /dsh-feiyu-brain/route`
- `POST /dsh-feiyu-brain/context`
- `POST /dsh-feiyu-brain/stats`
- `GET  /dsh-feiyu-brain/summary?date=YYYY-MM-DD`

## 配置

`config.json` 的 `routing.localEnabled` 控制本地自由对话；默认 **false**（qwen3:4b 自由对话会泄漏思维链，评测通过后再开）。

## 使用说明

**什么时候用**

- 判断走本地小模型还是大模型 → `decideRoute(text)`
- 判断这条回复要不要升级重答 → `shouldEscalate(reply, text)`
- 组装上下文（记忆 + 最近对话 + 能力清单）→ `buildContext({ text, scope })`
- 按日统计 → `summary(date)`

**接口**

| 调用 | 返回 |
|---|---|
| `contextPlan({ intent, scope })` | 六组件字符预算：instr / know / tools / mem / state / query |
| `buildContext({ text, conversation, scope, intent })` | `{ memory, recent, capabilities, plan }` |
| `decideRoute(text)` | `{ route: 'local'\|'big', reason }` |
| `decideRouteAsync(text, { conversation })` | 同上；先过 local-triage 分诊（灰度 flag `route.tier`，默认关，缺席即回落旧逻辑） |
| `shouldEscalate(reply, text)` | `''` 表示不升级，否则返回原因 |
| `recordStats(row)` / `summary(date)` | 按日 jsonl 统计 |
| `runReflection(ctx, { date, force })` | 反思：提炼记忆，只有真写入才算成功 |

**什么时候别用**

- 它是服务不是工具，别指望模型直接调
- `escalateOnReasoningLeak` 这类配置项现在真的生效了，改之前想清楚
- 反思失败要重试是对的，但**服务缺失时它不会虚报成功**——别改成「看起来完成」

## 变更记录

- 2026-11-05 · 接入 local-triage 分诊：新增 `lib/triage-bridge.js` 与 `decideRouteAsync()`；灰度 flag `route.tier`（默认关、按会话 sticky 分桶），local-triage 缺席或分诊出错时静默回落旧逻辑。HTTP `/dsh-feiyu-brain/route` 改走异步版本。新增 `tests/triage-bridge.test.mjs`（7 项，已进 `verify.mjs`）；全量回归 84/84。
- 2026-11-05 · `triage-bridge.js` 目录候选跟随 `dsh-local-triage` 改名：新名优先，旧名 `local-triage` 保留为兼容候选，改名前的部署仍能命中。
- 2026-11-05 · 复核使用说明与实现一致（服务方法、HTTP 端点、配置项），无内容修正；本次仅补这条核对记录。
- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
