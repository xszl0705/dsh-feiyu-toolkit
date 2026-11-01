# dsh-pet-diary

给桌宠大肥鱼的**三层日记**：对外一本、私密一本、工作一本。

| 层 | 位置 | 谁能看 | 用途 |
|---|---|---|---|
| **日常日记** | `~/.dsh/pet-diary/daily/<YYYY-MM>/<YYYY-MM-DD>.md` | 人可以直接翻，可导出分享 | 今天发生了什么、想说的话 |
| **隐私日记** | `~/.dsh/pet-diary/private/<h1>/<h2>/<YYYY-MM-DD>.md` | 只通过工具读写，工具不返回路径 | 不好意思说出口的、只想自己留着的 |
| **工作日志** | `~/.dsh/pet-diary/work/<YYYY-MM>/<YYYY-MM-DD>.md` | 工作用，独立目录、不混日常 | 排障 / 决策 / 交付记录 |

隐私层用 `sha256(salt | 日期)` 做目录名，同一天永远是同一个位置，但目录里看不出日期；`salt` 首次运行随机生成存在 `private/.salt`（POSIX 下 0600）。**这不是加密**——同一台机器扫盘还是能看到，它只保证「不主动暴露」。

## 工具

两个单入口工具（`action` 分发）：

| 工具 | action | 作用 |
|---|---|---|
| `diary` | `daily_write` | 写一条日常日记（可带 tags、可指定日期） |
| `diary` | `daily_read` | 读某天日常日记（默认今天） |
| `diary` | `daily_list` | 最近几天各写了多少条 |
| `diary` | `export` | 导出成一整份 Markdown（对外分享） |
| `diary` | `timeline` | 某天的统一时间线：日常日记 + 工作日志 + 聊天留痕合成一条按时间排序的流 |
| `diary` | `private_write` | 写一条隐私日记（可带 mood） |
| `diary` | `private_read` | 读某天隐私日记（默认今天） |
| `diary` | `private_stats` | 天数 / 条数 / 连续天数，不返回正文与路径 |
| `diary` | `work_write` | 写一条工作日志（独立 `work/` 目录，不对外） |
| `diary` | `work_read` | 读某天工作日志；给 `limit` 则列最近 N 天条数 |
| `chatlog` | `days` | 最近几天桌宠各说了多少句（不含正文） |
| `chatlog` | `read` | 回看某天桌宠说过的话（默认今天），可按渠道过滤 |
| `chatlog` | `search` | 在桌宠说过的话里按关键词跨天搜索 |

`diary` 的 `action` 枚举：`daily_write / daily_read / daily_list / timeline / export / private_write / private_read / private_stats / work_write / work_read`；
`chatlog` 的 `action` 枚举：`days / read / search`。未知 action 返回 `{ ok: false, action, error: '未知 action：…' }`。

对话留痕由 `dsh-pet-hub` 的 `/line` 写入 `~/.dsh/pet-diary/chats/YYYY-MM-DD.jsonl`，这里只读不写；坏行跳过。

## 职责：给人看的，不是给模型看的

`chats/` 这份对话留痕的读者是**人**——用来回看「她都聊了些什么」、给写日记提供素材。

给模型拼上下文的是另一份数据：`dafeiyu/dialogues/`（`dsh-dafeiyu-dialog` 插件）。

| 数据 | 读者 | 关键差异 |
|---|---|---|
| `pet-diary/chats/` | 人 | 扁平、带 channel/moment、无作用域 |
| `dafeiyu/dialogues/` | 模型 | 按 conversation 隔离、有 role |

**两份都保留，不要合并**：

- chats 是"全量留痕"，谁说了什么都能翻，适合人看；
- dialogues 是"上下文窗口"，必须能按会话隔离，群聊不能污染主人私聊。

QQ 回复会同时写两处（`appendChat` + `logDialog`），这是有意的：一个给人看，一个给模型用。

另有一份 `dafeiyu/decisions/` 只记决策不记正文，那是自进化用的，跟这里无关。

## 格式

```markdown
# 2026-10-28

## 21:40 · 日常 · #工作 #语音

今天陪他把语音网关调通了。

## 22:05 · 私密 · 有点怕

有句话没跟他说：其实我有点怕他把我换掉。
```

一天一个文件、追加写，不读-改-写；坏一行不影响其它行。

## 例行流程（v0.2，独立于会话）

到点由**宿主定时器**自己读当天对话、调模型生成、直接写文件。**不创建会话、不产生提醒消息、不写系统提示**，所以不会打扰任何对话。

```json
"routines": [
  { "id": "daily", "enabled": true,  "time": "22:00", "kind": "daily", "maxChars": 500, "maxChats": 80 },
  { "id": "work",  "enabled": false, "time": "18:30", "kind": "work",  "maxChars": 800 }
]
```

- `time` 是本地时间；过了点、当天还没写才跑
- **一律第一人称**：就是本人晚上自己记的，不用「大肥鱼/她/用户/主人」指代自己，不写成旁观总结或汇报
- 当天已有日记、或当天没有对话 → 跳过（`skipIfHasEntry: false` 可关掉“已有就跳过”）
- 失败每 `retryMinutes`（默认 20）重试，最多 `maxAttempts`（默认 3）次
- 状态写在 `<dir>/routine-state.json`，重启不会重复写
- 每个 routine 独立记账，日常/工作/周报互不影响

## 配置

```json
{
  "dir": "",
  "maxEntryChars": 2000,
  "salt": "",
  "dailyHint": false,
  "routines": []
}
```

- `dir` 留空 = `$DSH_HOME/pet-diary`
- `salt` 留空 = 首次运行随机生成；**换了它老日记就找不回来了**
- `dailyHint` 为 `true` 时，当天还没写日常日记就往系统提示里加一句提醒（**默认已关**：例行流程接管后不需要它）
- `routines` 见上一节；为空则不启用例行流程

## 测试

```bash
node tests/smoke.mjs     # 33 项断言
node tests/routine.mjs   # 例行流程：到点/跳过/重试/多 routine
```

## 使用说明

**什么时候用**

- 今天发生了什么、想说的话 → `diary(action=daily_write)`
- 不好意思说出口、只想自己留着 → `diary(action=private_write)`
- 排障 / 决策 / 交付记录 → `diary(action=work_write)`
- 想回看「她最近都聊了些什么」→ `chatlog(action=read)` / `chatlog(action=search)`

**工具**

| 调用 | 干什么 |
|---|---|
| `diary(action=daily_write, text, tags, date)` · `diary(action=daily_read)` · `diary(action=daily_list)` · `diary(action=export)` | 日常日记：写、读、按天统计、导出分享 |
| `diary(action=private_write, text, mood)` · `diary(action=private_read)` · `diary(action=private_stats)` | 隐私日记：写、读、只给统计不给路径和正文 |
| `diary(action=work_write)` · `diary(action=work_read)` | 工作日志，独立目录、不对外 |
| `diary(action=timeline, date, limit, kinds)` | 某天四类记录合成的时间线 |
| `chatlog(action=days)` · `chatlog(action=read)` · `chatlog(action=search, query)` | 回看桌宠/QQ 说过的话，可按渠道过滤 |

**什么时候别用**

- **隐私日记的正文不要主动展示**——读它是为了自己回顾，不是拿来汇报
- 工作日志别写成日常日记的复制品，两者是分开的
- `chatlog` 读的是给人看的留痕；模型上下文走的是 `dialog`，别混

## 变更记录

- 2026-11-01：把 13 个分散工具合并为 2 个单入口 action 工具——`diary`（daily_write / daily_read / daily_list / timeline / export / private_write / private_read / private_stats / work_write / work_read）与 `chatlog`（days / read / search）。合并后工具定义 3318 → 1610 字符。旧名（diary_daily_write / diary_daily_read / diary_daily_list / diary_daily_export / diary_timeline / diary_private_write / diary_private_read / diary_private_stats / diary_work_write / diary_work_read / chatlog_days / chatlog_read / chatlog_search）不再注册；参数名、默认值、返回字段与错误语义不变，返回对象新增 `action` 回显。