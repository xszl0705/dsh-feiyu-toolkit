# dsh-rp-kit · 跑团工坊

> **装载状态（2026-11-11）**：本包在 desktop profile 里是 `link:` 依赖，但**没有进 `dsh.profile.bundles`**，所以下面这 6 个工具在当前宿主上**不存在**。它现在的作用是给 `dsh-rp-mode` 提供数据目录（`rp-kit/` 角色卡库）。要用工具，得先把它加进 bundles（属于 profile 改动，由用户手动执行）。本文档的工具表描述的是"装进 bundles 之后"的行为，不是现状。

给 QQ 群 / 单人跑团做**内容评审**的 DSH 插件。它不取代 GM，也不替你写规则——它做四件事：**收编内容、按清单打包、记问题台账、跑数值模拟**。评审判断由模型做，插件保证不漏项、不重复提、可追溯。

## 为什么不是"直接问 AI"

直接问 AI 会得到随机的建议列表，下次问又是另一套。这个插件把"标准"固定下来：

- 四套检查清单（规则书 12 项 / 世界观 8 项 / 大纲 10 项 / 数值 10 项），每次评审都跑同一套；
- 问题有 id、严重度、位置、原文、建议、状态，改没改一目了然；
- 同样的输入重复审，不会重复提已经提过的问题。

## 工具 · 六个工具

| 工具 | 作用 |
|---|---|
| `rp_open` | 建项目 / 登记内容（按 `#` 标题自动切章）/ 列项目 / 看状态 |
| `rp_pack` | 出**评审工作包**：清单 + 相关源文 + 未关问题 + 输出格式要求 |
| `rp_issue` | 问题台账：add / update（标 fixed）/ list |
| `rp_report` | 渲染体检报告，落盘到 `reports/` |
| `rp_sim` | 蒙特卡洛数值模拟：命中率、击杀轮次分布、结论 |
| `rp_outline` | 副本大纲结构校验 / 生成四段式模板 |

## 标准工作流

```
1. rp_open(action=create, project=我的团)
2. rp_open(action=add, kind=rules, content=<规则书正文>)
3. rp_pack(project=我的团, kind=rules)      → 拿到工作包
4. 逐条审，发现问题就 rp_issue(action=add, ...)
5. rp_report(project=我的团)                → 出报告
6. 改完：rp_issue(action=update, id=I003, status=fixed)
7. 复审：rp_pack 只会再带出未关问题
```

## 数据目录

默认 `<workspace>\rp-kit\`（可用环境变量 `DSH_RP_KIT_ROOT` 覆盖）：

```
rp-kit/
  projects.json
  <项目>/
    sources/     切好的源文
    issues.json  问题台账
    reports/     体检报告
    versions/    改稿快照
```

## 数值模拟怎么用

```json
{
  "name": "普通兵互砍",
  "trials": 10000,
  "hit": { "dice": "d100", "lte": 65 },
  "damage": "1d10+3",
  "crit": { "lte": 5, "extra": "1d10" },
  "defender": { "hp": 40, "dr": 2 }
}
```

输出命中率、暴击率、平均每轮伤害、击杀轮次 P10/P50/P90、以及一句判定（太快 / 太慢 / 打不死 / 稳）。判定标准写在 `lib/sim.js` 的 `judge()` 里，可直接调。

## 配置

`config.json`：

| 键 | 含义 | 默认 |
|---|---|---|
| root | 项目库根目录 | `<workspace>\rp-kit` |
| maxPacketChars | 单个工作包最多带多少字源文 | 24000 |
| simTrialLimit | 模拟试验次数上限 | 50000 |

## 已知限制

- **不做评审判断**。`rp_pack` 只给材料和标准，结论要模型逐条给。想让插件自己打分只会变成关键词匹配。
- 术语抽取（`lib/terms.js`）只产生候选，同义词判定仍需人工/模型。
- `rp_outline` 的结构检查是关键词级，能发现"没写"，发现不了"写得不对"。
- 源文按 `#` 标题切章；没有标题的整段算一章，长文建议自己加标题。
- 数值模拟只跑给定表达式，不理解规则语义（不支持条件触发、状态叠加）。

## 变更记录

- 2026-11-10 v0.1.2：声明 `export const inject = ['tools']`。v0.1.1 的 `pickTools()` 实测仍走 `ctx.get('tools')`——没声明依赖时 `ctx.tools` 属性访问拿不到服务，工具照样注册进宿主根层，扮演会话的函数表里没有 `rp_open` 等六个工具。声明后 `ctx.tools` 是 realm 绑定实例。
- 2026-11-10 v0.1.1：`registerWhenToolsReady` 改用 `pickTools()`——优先 `ctx.tools`（realm 绑定），退回 `ctx.get('tools')`。原因：preset isolate realm 里后者可能解析到宿主根服务，工具注册进宿主层后扮演会话看不到（实测 roleplay 请求头只剩 web 工具）。命中来源写入日志。

- 2026-11-05 v0.1.0：首版。四套清单、六个工具、蒙特卡洛模拟、报告渲染。

## License

MIT
