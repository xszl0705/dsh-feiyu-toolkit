# dsh-feiyu-mood-lite

给「大肥鱼」桌宠用的**轻量心情引擎**。数据格式沿用 `dsh-feiyu-mood` v2，所以桌宠状态卡和 pet-hub 快照不需要任何改动就能读到。

## 做什么

| 能力 | 说明 |
|---|---|
| 每轮评价 | 一轮对话完成后，先让模型按 OCC 评价四件事（有利程度/意外程度/归因/可控性），再由本地规则算 `delta` |
| 自然回落 | 每小时向基线（默认 60）回落 12%，没人说话也会慢慢回平 |
| 注入语气 | 把当前心情作为一段 `systemPrompt`（order 65）注入，让回复语气受情绪影响 |
| 可查询 | 工具 `feiyu_mood_status` + 端点 `GET /dsh-feiyu-mood/state` |
| 降级 | 模型不可用/输出不是 JSON 时退回关键词启发式，心情仍然会动 |

## 评价变量 → delta（v0.2）

模型只输出评价，不给分：

```json
{"desirability":0.6,"expectancy":0.2,"agency":"user","control":0.8,"reason":"被夸了"}
```

本地按固定公式算：

```
novelty  = 0.7 + 0.3 × (1 - expectancy)          // 意外的事更重
bias     = desirability < 0 ? 1.2 : 1            // 负面偏差
delta    = round(sign(d) × |d| × 10 × novelty × bias)   // 再夹到 ±8
|desirability| < 0.15 → delta = 0                // 明确允许「不变」
```

维度按归因落位：正向 → happy/sweet；负向 → sad（外部原因更重）/ worry（不可控更重）/ heartache（用户造成且不可控）。

旧的 `{"delta":…}` 格式仍然兼容；评价变量会随每轮写进 `timeline[].appraisal`，方便回看和调参。

## 数据

`~/.dsh/feiyu-mood/state.json`（v2）：

```json
{
  "version": 2,
  "moods": {
    "__default__": {
      "mood": 65,
      "dims": { "happy": 80, "calm": 0, "sweet": 0, "heartache": 0, "worry": 0, "sad": 0, "jealous": 0 },
      "lastReason": "被夸了",
      "updatedAt": 1793110000000,
      "lastDecayAt": 1793110000000,
      "timeline": [{ "at": 1793110000000, "mood": 65, "delta": 5, "reason": "被夸了" }]
    }
  },
  "lastActive": "__default__"
}
```

未知字段会原样保留，卸载本插件后换回原版 `dsh-feiyu-mood` 也能接着用。

## 配置（`config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `judge` | true | 是否每轮调模型判断 |
| `provider` / `model` | deepseek-account / deepseek-flash | 判断用的模型 |
| `maxTokens` | 1024 | **不要调到 100 以下**：思考过程会吃光预算，导致只回思考没有正文 |
| `minIntervalMs` | 15000 | 两次判断的最小间隔 |
| `injectPrompt` | true | 是否把心情注入系统提示词 |
| `baseline` | 60 | 回落基线 |
| `decayPerHour` | 0.12 | 主值的每小时回落率 |
| `negativeFactor` | 0.7 | 心情低于基线时回落率的乘数（更黏） |
| `positiveFactor` | 1.15 | 心情高于基线时回落率的乘数（散得更快） |
| `dimDecayPerHour` | `{}` | 覆盖单个维度的衰减率，例如 `{"sad":0.08}` |

## 差异化衰减（v0.3）

主值按指数回落，**低于基线时更黏**：

```
k    = decayPerHour × (mood < baseline ? negativeFactor : positiveFactor)
mood = mood + (baseline - mood) × (1 - e^(-k × hours))
```

七个情绪维度各有自己的速率，负向整体比正向留得久（99% 回平约 `4.6/k` 小时）：

| 维度 | 每小时 | 约几小时散完 |
|---|---|---|
| happy | 0.35 | 13h |
| calm | 0.20 | 23h |
| sweet | 0.30 | 15h |
| jealous | 0.25 | 18h |
| worry | 0.16 | 29h |
| sad | 0.12 | 38h |
| heartache | 0.10 | 46h |

维度按 `value × e^(-k × hours)` 衰减，低于 0.5 直接归零；`dimDecayPerHour` 可以逐项覆盖（设 0 表示不衰减）。配置在每次回落/判断时重新读取，调参不需要重启。

## 人格参数（v0.4）

性格参数只放在一处：桌宠的 `config.json` → `persona`。插件通过 `personaFile` 读它，桌宠自己用同一份参数算开口预算。

```json
"persona": {
  "extraversion": 0.7,
  "agreeableness": 0.75,
  "conscientiousness": 0.5,
  "neuroticism": 0.45,
  "openness": 0.7
}
```

| 维度 | 影响 |
|---|---|
| extraversion | 桌宠主动开口的频率、空闲门槛；情绪表达强度 |
| agreeableness | 语气软硬（提示词里的性格底色） |
| conscientiousness | 倾向少打断干活 |
| neuroticism | 情绪表达强度、敏感程度 |
| openness | 话题偏好（提示词） |

插件侧只做两件事：把五维翻译成性格词写进系统提示词；按 `0.4 + 0.6×外向 + 0.2×神经质` 给出 0.2~1 的“表达强度”，让心情只调节语气强弱、不改性格。端点返回里的 `persona` / `tone` 可以直接核对。

## 端点与工具

```powershell
curl http://127.0.0.1:<port>/dsh-feiyu-mood/state
```

```json
{ "ok": true, "version": "0.4.0", "mood": 65, "label": "平稳", "reason": "被夸了", "dims": {...}, "decay": {...}, "persona": {...}, "tone": 0.82, "timeline": [...] }
```

模型侧工具：`feiyu_mood_status`。

## 自测

```powershell
node _test/run.mjs
```

覆盖：心情数学（夹取/回落/差异化衰减/配置覆盖）、评价变量映射、JSON 解析与启发式、轮次扫描（含注入消息过滤）、mock ctx 下的整链（端点/工具/提示词/一轮 +6）。

## 卸载 / 回滚

1. 从 profile 的 `package.json` 删掉依赖和 bundles 里的 `dsh-feiyu-mood-lite`
2. 删掉 `profiles/<profile>/node_modules/dsh-feiyu-mood-lite` 这个 junction
3. 重启 DSH

状态文件不用删；想要「回到 70」直接改 `state.json` 里的 `mood` 即可。

## 已知限制

- 只维护一个房间（`__default__`），没有原版的「按会话分房间」。
- 没有心情日记、品味库、主动开口——那些是完整版 `dsh-mood` 的能力。
- 判断会消耗 token（每轮一次小请求），介意的话把 `judge` 设为 false，只保留回落的静态数值。

## 使用说明

**什么时候用**

- 想知道当前心情值和表达强度 → `feiyu_mood_status`
- 想确认「今天的语气是对的」→ 看 mood 和最近一次变化原因

**工具**

| 调用 | 干什么 |
|---|---|
| `feiyu_mood_status()` | 心情值、维度、最近一次变化原因 |

**什么时候别用**

- 心情只调节语气强弱，**不改立场和判断**——别拿它当借口改变结论
- 别手动改 `state.json` 里的数值，那是从对话里评估出来的
- 心情低不代表要安慰，也不代表要改口
