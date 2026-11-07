# dsh-dafeiyu-core

大肥鱼的**主体内核**：身份只有一份，渠道只决定「怎么说」。

```
~/.dsh/dafeiyu/
├── core/
│   ├── persona.md     我是谁（唯一来源，改这里）
│   ├── voice.json     各渠道的长度/语气/媒介约束
│   └── relations.md   关系与形象（公开档：群里/陌生人也能用；只写可对外讲的事）
└── compiled/
    ├── pet.template.txt   桌宠模板（{{scene}}/{{away}}/{{mood}}/{{memory}}）
    ├── client.identity.txt 客户端注入段
    ├── relations.public.txt 关系与形象清单原文
    ├── identity.<渠道>.txt 各渠道身份段（qq/bili 会附带 relations.md）
    └── manifest.json      persona sha256 + 渠道列表 + 编译时间
```

「关系与形象」只编进公开渠道（qq / bili）：群里不查私密记忆，也要认得出人、说得出自己的形象；客户端已有完整记忆，不重复塞。

## 边界：人设只在这里（2026-11-04 方案 v3）

- 人格（`core/persona.md`）、渠道语气（`voice.json`）、关系与形象（`relations.md`）**只有这一处**。
- 跨项目规则写 `~/.dsh/AGENTS.md`，工程约定写各插件 README，都**不要**塞进 persona。
- 客户端只注入 `compiled/client.identity.txt`；公开渠道才带关系清单。四源注入（本插件 / AGENTS.md / auto-memory / 宿主 persona seam）里，本插件只负责「我是谁、对谁怎么说话」。

## 它解决什么

以前「我是谁」散在 mood 插件、桌宠脚本、预算语料、pet-hub 的 prompt、客户端系统提示里——**同一件事写五遍，迟早分叉**。现在：

- 身份只在 `core/persona.md` 一处
- 桌宠的 `/line` 读 `compiled/pet.template.txt`，只负责填场景变量
- 客户端靠 `systemPrompt.section('dafeiyu:identity')` 注入同一份身份
- 未来 QQ / B 站只要加一个渠道规则，不复制任何身份文本

## 渠道规则

`voice.json` 里每个渠道只描述表达约束：

| 渠道 | 长度 | 语气 | 限制 |
|---|---|---|---|
| client | 按需 | 中性专业 | 无 |
| pet | 一句话 | 外放口语 | ≤18 字、不用表情 |
| qq | 短句 | 熟人感 | ≤120 字、可用表情 |
| bili | 面向观众 | 公共礼貌 | ≤300 字 |

**差异只允许出现在长度、语气、媒介**；记忆、立场、对人的态度四条渠道共享。

## 改人格

编辑 `~/.dsh/dafeiyu/core/persona.md`，下次读取时自动重编译（manifest 里的 `compiledAt` 会更新）。改完想验证一致性：

```bash
node tests/consistency.mjs
```

## 唯一数据源约定

`core/persona.md` 是「我是谁」的**唯一来源**。其它插件全部只读，**不允许自己缓存或复制人格文本**：

| 读取方 | 读什么 | 怎么读 |
|---|---|---|
| 本插件 | `core/persona.md` → 编译到 `compiled/` | 每次读取时按 mtime 重编译 |
| `dsh-qq-adapter` | `compiled/client.identity.txt` 或 persona 原文 | 每次 apply 读一次，不缓存到磁盘 |
| `dsh-pet-hub` | `compiled/pet.template.txt` | 只填 `{{scene}}/{{away}}/{{mood}}/{{memory}}`；`{{memory}}` 由 pet-hub 填「你最近在忙：…」（取当天工作日志最后一条，取不到退回记忆条数） |
| 客户端注入 | `systemPrompt.section('dafeiyu:identity')` | 由本插件提供 |
| `dsh-feiyu-mood-lite` | `_pets/deepseek-dafeiyu-pet/config.json` 的 `persona` 字段 | 只读，取大五人格数值调语气强度 |

**已知缺口**：`dsh-feiyu-mood-lite` 读的是桌宠配置里的**人格数值参数**（外向/亲和等），不是 `persona.md` 的文本。也就是说「人格」目前有两处定义——文本在 core，数值在桌宠配置。两者可能不一致，还没打通。详见 [整合方案 P3](../docs/plugin-integration-2026-10-31.md)。

**约束**：

1. 改人格只改 `core/persona.md` 一处，别去改 `compiled/`（会被覆盖）。
2. 任何插件都**不要把人格文本写进自己的 config 或缓存文件**——分叉了没人发现。
3. 人格版本变化通过 `compiled/manifest.json` 的 `personaSha256` 判断，不要靠时间戳。
4. 人格、立场、边界属于 L0，**永远人改**；自动进化只能改 L4 的策略与提示词片段（见总纲）。

## 测试

```bash
node tests/consistency.mjs   # 22 项：身份单一来源、跨渠道只换表达、模板可装配
```

## 回退

删掉 `~/.dsh/dafeiyu/` 即回到插件自带默认值；或不加载本插件——pet-hub 会自动退回内置提示词。

## 使用说明

**什么时候用**

- 改「我是谁」→ 编辑 `~/.dsh/dafeiyu/core/persona.md`，下次读取自动重编译
- 加/改渠道语气 → 编辑 `voice.json`
- 验证跨渠道一致性 → `node tests/consistency.mjs`

**接口**

| 调用 | 说明 |
|---|---|
| `composeFor(channel, vars)` | 按渠道组装系统提示词 |
| `systemPrompt.section('dafeiyu:identity')` | 客户端注入段 |

**什么时候别用**

- **别改 `compiled/`**——那是编译产物，会被覆盖
- 人格、立场、边界属于 L0，只能人改，自动进化碰不得
- 改完人格要跑一次一致性测试，别凭感觉

## 变更记录



- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-02：新增 `core/relations.md`（关系与形象公开档），编译到 `compiled/relations.public.txt`，并只追加到公开渠道身份段（qq / bili）。旧库没有该文件时自动从 `assets/relations.default.md` 生成；`relations.md` 改动会触发重编译。改完需重启 DSH 生效。
- 2026-11-01（桌宠模板注入本体进度）：`buildPetTemplate` 把 `{{memory}}` 从场景行拆出来单独一行，并加约束「只当背景，不逐条复述、不报进度；对不上就只说眼前的事，别编」。模板由 core 在 apply 时重编译，改 `lib/compose.js` 后重启宿主即生效。
