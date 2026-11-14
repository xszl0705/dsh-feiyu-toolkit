# dsh-step-saver

## 当前发布：0.1.4（2026-11-12）

新增 slim.json.presetPolicies：research.strict=true，keep 为五个 ev 工具、web_search/web_fetch 与四个助手工具（ask_user_question / present / todo_write / memory_log）。该专用规则独立于一般瘦身 enabled；view 与执行 guard 同源，不接受 toolbox 扩展。run_code 仅作为宿主保留传输。

预设读取先查 agentPresets 当前组合与事件投影，最后才回退创建头；无需启用 runtime context。研学不注入 run_node/toolbox 使用纪律。其余模式保持原有策略。

变更原因：一般模式瘦身误吞研学证据工具。旧版“全部 fail-open”说明不适用于新的 strict 专用模式；strict 工具面为空时不会恢复全量。


一般模式（默认 preset）的**步数与上下文治理**插件。参照 `dsh-rp-mode` 的 channel 手法，
把「收窄工具面 / 探索结果前置 / 纪律写成硬约束」三件事搬到多任务的一般模式。

## 为什么要它（实测依据）

最近 7 天本机 192 会话 / 9,185 步 / 11,878 次调用的数据：

| 指标 | 实测 | 目标 |
|---|---|---|
| 次/步（并行度） | 1.30 | ≥1.40 |
| read 重复率 | 35.3%（626/1773） | ≤25% |
| edit 重复率 | 67.2%（926/1379） | ≤50% |
| 每步上下文 | p50 154,531 / p90 408,687 token | ≤130k / ≤300k |
| 注册工具 / 定义成本 | 72 个 / **14,298 token 每步重发** | ≤38 个 / ≤9,000 |
| 22 个零调用工具的定义 | **4,455 token 每步纯浪费** | 0 |

调用分布高度集中：pwsh 34.5%、read 14.9%、edit 11.6%、grep 8.5%、write 6.9% —— 前五占 **76.4%**。
本插件的四个工具直接针对这些高频动作的「体积」与「步数」。

## 工具

| 工具 | 作用 | 替代掉的模式 |
|---|---|---|
| `run_node` | 跑 .mjs/.js，只回尾部 + 落盘路径，内置注入 `ELECTRON_RUN_AS_NODE` / `PYTHONIOENCODING` / `PYTHONUTF8` | 手拼 powershell 四行前缀（7 天 438+217+122 次） |
| `ls_tree` | 按深度列目录树，只回名称与字节数 | `Get-ChildItem -Recurse` + 手工排版（288 次） |
| `file_outline` | 只回函数/类/导出/标题 + 行号，约 200 token/文件 | 盲读整文件后再回读（read 重复 35.3%） |
| `smart_grep` | 命中附所属函数/标题（`owner@L行号`）与 `文件:行号` | 「grep 一次 + read 两次」的链式探索 |
| `toolbox` | 把 slim 收起的分组挂回当前会话 | 72 个工具全量常驻 |

纯数据文件（JSON/CSV/日志）走 `file_outline` 时自动降级为「前 20 行 + 总行数」，不伪造骨架。

## 工具面瘦身（slim）

`slim.json` 是唯一配置源：

```json
{
  "enabled": false,
  "excludePresets": ["roleplay", "roleplay-web", "roleplay-gm", "redteam"],
  "keep": ["pwsh", "read", "..."],
  "groups": { "media": ["comfy", "draw"], "...": [] }
}
```

- `enabled: false`（默认）= **完全放行**，什么都不改
- `enabled: true` = 除 `excludePresets` 命中的会话之外，只保留 `keep` 里的工具，其余靠 `toolbox(show="组名")` 挂回本会话
- 判定（**排除制**，0.1.1 起）：preset 命中 `excludePresets` 才放行（默认 roleplay / roleplay-web / roleplay-gm / redteam，它们各有自己的通道）；其余一律瘦身，含空 / `default` / **`unrestricted`** / 任何新建的自定义 preset
  - 为什么不反过来：0.1.0 是白名单制（只认空 / default / general / native），而 desktop 会话的 preset 是 `unrestricted`（dsh-purge 骨架），命中不了 ⇒ 整条通道空转，日志只会写 `preset=(未命中) keep=0`。0.1.1 的日志会打出真实 preset 名与放行原因（`[slim/agent] 首次见到 agent ... preset=unrestricted 命中 keep=42`）
- fail-open：配置缺失、白名单为空、拿不到 scope ⇒ 放行原工具面（宁可不省，不能让会话没有工具）
- **挂载与执行兜底同源（0.1.2 修）**：宿主的 `ToolExecution` 只有 `{ name, arguments, agent, parent, toolSet, schema }`，**没有 `session` 字段**，会话 id 只在 `exec.agent.session.id` 上。旧代码 `toolbox` 用 `sessionIdOf(exec)`（永远拿到空串 → 落到 `_global`）、执行兜底用 `sessionIdOf(exec.agent)`（拿到真会话 id），两条链对不上，于是 `toolbox(show="rp")` 明明回「已挂载 14 个」，下一次 `rp_card` 仍被兜底拒绝。现在两侧统一走 `scopeKeys()` / `addToScope()`：挂载时把该 exec 解析出的**每个**会话键（`agent.session.id` / `agent.sessionId` / `session.id` / `agent.id` …）各写一份，读取取并集，任一键重合即生效；一个键都解析不到时才退回 `_global`。同一改动也把 view 过滤的会话键换成同一套并集。

改动 `slim.json` 后**需重启宿主**（插件在启动期装载 view 过滤器）。

### 覆盖率对账（改白名单后必跑）

铁律：**任何工具必须落在 `keep` 或某个 `group` 里**，否则瘦身开启后它会永久不可见。
`tools/check-coverage.mjs` 拿 `_tmp/tool-usage-report.txt` 的注册清单逐条比对，退出码 2 = 有漏网：

```js
run_node(script='<workspace>\\dsh-plugins\\dsh-step-saver\\tools\\check-coverage.mjs')
```

实测这玩意儿抓到过 4 个：`memory_user`、`working_directory`（谁都没列）、`job_list`/`job_kill`（被误收进 work 组）。

## 提示词纪律

`slim.json` 的 `prompt` 字段可自定义；不填则用内置的六条（并发 ≥1.40、先看骨架再读、同文件改动合并、
用 run_node/ls_tree、单条 >10k 视为失败、低频工具用 toolbox 挂回）。

注入出口优先走 `systemPrompt` 服务；该服务不存在时**只记日志**，不影响工具与 slim。

## 日志

- `~/.dsh/step-saver/slim.log`：view 过滤结果（可见数 → 过滤后数、保留清单、收起清单、白名单里配了但不可见的）
- 同文件 `[plugin]` 行：就绪信息、提示词出口结果、注册失败原因

一次典型生效记录：

```
[slim] 生效 preset=(default) 可见 72 → 38
[slim] 保留 [toolbox,pwsh,run_node,...]
[slim] 收起 34 个 [workflow,schedule_create,draw,...]
```

## 已知限制

- slim 只做减法，不会凭空提供没注册的工具；`[slim] 白名单配了但本会话不可见` 说明是插件没挂载
- `toolbox` 的挂载是会话内存态，重启后恢复默认集合
- `run_node` 的脚本 stdout 在 Electron 下可能被吞，必须靠落盘文件判读（工具会回 `outPath`）
- 不替代 pwsh 的任意命令能力：要跑系统命令还是用 pwsh

## 变更记录

- 2026-11-10 · 0.1.3：`keep` 增加 `rp_card` / `rp_memory`。原因：扮演会话常开在普通 preset（slim 命中），挑卡第一步被逼成 `toolbox(show="rp")` 挂组 —— 一步纯开销。这两个工具在任何会话都无害（不挂卡就是空库），常驻后可省掉挂载步。覆盖率对账仍 0 未覆盖（「keep 里但基线没有」的 2 条就是这两个插件工具，预期内）。
- 2026-11-10 · 0.1.2：修 `toolbox` 挂载对执行兜底无效。根因是两侧会话键不同源（`sessionIdOf(exec)` vs `sessionIdOf(exec.agent)`，而宿主的 exec 没有 session 字段），表现为 `已挂载 rp（14 个）` 之后 `rp_card` 仍被拒。改为 `scopeKeys()` 多键写入 + 并集读取，并加两条回归用例（`tests/step-saver.test.mjs` 第 12、13 条）。触发场景：standard 会话里手写 `rp_card(...)`。
- 2026-11-08 · 0.1.1：slim 判定从白名单制改**排除制**（`excludePresets`）。原因：desktop 会话 preset 是 `unrestricted`，白名单制下发命中，重启后日志只有 `preset=(未命中) keep=0`，一条工具都没收起。同时把真实 preset 名与放行原因写进日志，以后一眼能判。
- 2026-11-08 · 0.1.0：首版。五个工具 + slim 通道 + 提示词纪律；依据 7 天 11,878 次调用实测数据。

## 实例验证记录（verifyx，2026-11-08 23:26-23:29）

| 项 | 结果 | 证据 |
|---|---|---|
| 单测 | **18/18 通过** | `_tmp/step-saver.test-20261108-232851.txt` |
| 装进 verifyx | deps=true bundles=true junction=true | playground install，备份 `github/backups/20261108152255-before-dsh-step-saver-in-verifyx` |
| 工具注册 | **5 个** | `[plugin] 就绪 pid=46936 工具=5` |
| slim 过滤装载 | **view=ok guard=ok** | `[slim] view 过滤器已装载（实例 + 原型）` |
| slim 配置解析 | **keep=38**，7 个组 | `[slim/install] enabled=true keep=38` |
| 提示词出口 | **ok** | `[plugin] 提示词出口 ok` |
| compaction 参数 | patch 被接受，实例正常启动 | `[slim]` 段与 `dsh web: listening` 同段无 error |

踩坑记录（两处，都已在代码里修掉）：

1. `cordis.patch.yml` 必须写成 `- insert: [{id, name}]`，直接写 `- id: ...` 时 bundle patch 不生效、插件根本不加载（首轮 boot.log 里查不到任何 step-saver 行）。
2. `ctx.systemPrompt` 必须在 `ctx.inject(['systemPrompt'], sctx => ...)` 的 scope 里访问，直接取会抛 `cannot get property "systemPrompt" without inject`；也不能写进插件的硬 `inject` 数组（rp-mode 踩过：硬依赖会让插件整体等待、工具全不注册）。

