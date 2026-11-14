# dsh-gm-craft · GM 工坊

> **装载状态（2026-11-11）**：`link:` 依赖已装，但**不在 `dsh.profile.bundles`** 里，工具当前不注册。`dsh-rp-mode` 的 preset 只把它当数据目录用（`gm-craft/`）。要用工具就先加进 bundles（profile 改动，用户手动执行）。

把「世界—故事—操作—反馈」四层能力固化成工具。**工具不做判断，只逼你填字段；能用代码校验的一律不用模型。**

## 为什么不是"AI 写故事"

直接让 AI 写，会得到"很顺但没人记得住"的东西。这个插件反过来：它不写，它**问**。

- 建世界时问你："规则能中途改吗？"
- 出场景时问你："双方目标互斥吗？三条线索齐吗？"
- 收尾时问你："这一场谁没说话？"

填不出来的地方，就是设计有洞的地方。

## 工具 · 六个工具

| 工具 | 作用 |
|---|---|
| `gm_world` | 建世界卡：设一条硬规则、加元素、按文本召回、体检、按组出问卷题 |
| `gm_scene` | 出场景卡：冲突拆成双方各要什么、写"更糟"、给三条线索 |
| `gm_post` | 生成群聊帖子草稿（模板 + 素材，不写正文） |
| `gm_beam` | 镜头表：这场景谁还没戏 |
| `gm_beat` | 记录"玩家的选择改变了什么" |
| `gm_check` | 横切自检：假选择、线索不足、世界缺规则 |

## 数据模型

```
<root>/<项目>/
  world.json     规则 + 限制 + 地理 + 历史 + 文化 + 日常 + 元素表
  scenes.json    场景卡（冲突/更糟/线索/结局）
  threads.json   剧情线
  beats.json     选择记录
```

元素带 **activation.keys**——文本里提到就召回，提到一个还能级联相关元素（借自 SillyTavern World Info）。

## 标准流程

```
0. gm_world(ask, group)      按组出世界问卷（18 组 / 300 题，一次只答一组）
1. gm_world(init)            建项目
2. gm_world(rule)            一条硬规则 + 它的限制
3. gm_world(add) × N         加 NPC / 地点 / 势力
4. gm_scene(new)             出场景卡（会立刻体检）
5. gm_world(activate, text)  写帖子前，把该进上下文的元素召回来
6. gm_post(draft)            生成帖子草稿
7. gm_beam(status)           看谁还没戏
8. gm_beat(record)           记下"选择改变了什么"
9. gm_check                  阶段自检
```

## 三条设计原则

1. **工具不做判断**——填字段，不填内容。
2. **输出是材料**——帖子是模板 + 素材。
3. **确定性校验用代码**——字段完整度、线索条数、双方目标是否相同，不调模型。

## 已知限制

- 不做向量召回（先关键词，够用再加）
- 不做 Web UI
- 不生成长篇正文
- `conflict` 的互斥检查只判"两方 want 是否相同"，不判语义冲突
- 问卷一次最多出 20 题；300 题分 18 组，逼 GM 分组慢慢答

## 变更记录

- 2026-11-10 v0.1.3：声明 `export const inject = ['tools']`。v0.1.2 的 `pickTools()` 实测仍走 `ctx.get('tools')`——没声明依赖时 `ctx.tools` 属性访问拿不到服务，工具照样注册进宿主根层，扮演会话的函数表里没有 `gm_*`。声明后 `ctx.tools` 是 realm 绑定实例。
- 2026-11-10 v0.1.2：`registerWhenToolsReady` 改用 `pickTools()`——优先 `ctx.tools`（realm 绑定），退回 `ctx.get('tools')`。原因：preset isolate realm 里后者可能解析到宿主根服务，工具注册进宿主层后扮演会话看不到。命中来源写入日志。

- 2026-11-05 v0.1.0：首版。四层模型、六工具、确定性校验、关键词召回 + 级联。
- 2026-11-05 v0.1.1：`gm_world` 增加 `ask` 动作，接世界问卷（`templates/world-questionnaire.md`，18 组 300 题，按 group/limit/offset 出题）。

## License

MIT
