# dsh-rp-mode · 扮演模式

DSH 的一个 agent preset：**对话 + 角色扮演 + 联网查找 + 角色卡 + 扮演记忆**的会话形态。
在无限制模式的基调上做减法——摘掉终端、文件、代码、子代理、定时、技能，只留下演一场戏需要的东西。

## 会话里有什么

| 来源 | 工具 | 用途 |
|---|---|---|
| 本包 | `rp_card` | 读角色卡库：列卡 / 找卡 / 读卡 / 取世界书 / 落进记忆 / **切换当前角色与背景** |
| 本包 | `rp_memory` | 扮演记忆：角色 / 世界 / 剧情 / 关系 / 杂记 |
| 宿主 | `web_search` `web_fetch` | 联网查设定、历史、术语、器物 |
| `dsh-rp-kit` | `rp_open` `rp_pack` `rp_issue` `rp_report` `rp_sim` `rp_outline` | 跑团工坊：规则书、设定、大纲、评审台账、数值模拟 |
| `dsh-gm-craft` | `gm_world` `gm_scene` `gm_post` `gm_beam` `gm_beat` `gm_check` | GM 工坊：世界卡、场景卡、群聊帖子、镜头与选择回响 |

**没有**：bash / pwsh / read / write / edit / glob / grep / job / subagent / workflow / schedule / skill / goal / todo / present。

**这句从 0.6.0 起是真的，而且是真的那个「真」**：工具面只由本包 `cordis.patch.yml` 里挂了哪几行决定——
preset 不挂 `tool-fs`、不挂 `tool-pwsh`，模型那里就根本没有这些工具，不需要运行时补丁去"藏"。
0.5.x 那套「包 `ToolsService.view` + 往 agent 层补注册」已退役（实测 0.5.13→0.5.15 三轮都没能让
`rp_card` 进到请求体），只剩 `config.json` 的 `legacyChannel: true` 作回滚开关。
收窄正路的机制依据见 [`docs/rp-mode-tools-design-20261110.md`](../../docs/rp-mode-tools-design-20261110.md)。
人设里写死了：你在演一个角色或做叙事者，不自称 AI、不解释「我在扮演」、不假装有终端。
`dsh-purge-community` 的破限注入层照常生效，它是模式的地基，不算扮演功能。

## 角色卡读取 `rp_card`

卡库是**多根**的，两个来源一起扫：

| 根 | 内容 | 格式 |
|---|---|---|
| `<workspace>\rp-kit\角色卡库\cards-json` | 校园 20 + 系统 56 | 明文 JSON（`chara_card_v3`） |
| `<downloads>\jueseka2` | 按你的下载库实际体量 | PNG 图片卡（`tEXt` 里的 `chara`/`ccv3`，base64 JSON） |

PNG 卡的设定藏在图片的文本块里：解 `tEXt`/`iTXt`，取 `chara`（V2）或 `ccv3`（V3），base64 解出 JSON。没有这两个块的 PNG 是插图，不是卡，扫描时直接跳过。

| action | 作用 | 返回 |
|---|---|---|
| `current` | 看当前在演谁 | 角色名 + 背景 + 卡源 |
| `list` | 按分组列卡 | 卡名 + KB（可 `group` 限定） |
| `search` | 关键词找卡 | 有标签索引时毫秒级（关键词 + 三级标签）；无索引退回全库扫描 |
| `search` 参数 | `tags` `l1` `l2` | 细标签（病娇,巨乳）/ 粗粒度形态 / 题材 id，可与关键词并用 |
| `pick` | 选定并**锁定本会话**的角色 | 只成功一次；之后换角色必须新建会话（`~/.dsh/rp-memory/session-locks.json` 按 session 记） |
| `read` | 读一张卡 | 设定 400 字 + `first_mes` 全文；`full=true` 才给 `mes_example` / 卡内指令 / 备选开场 |
| `book` | 取世界书条目 | 按 `query` 取，默认 10 条 × 300 字；**一次可问多个词**（空格/顿号分隔，或用 `queries` 数组），按命中词数排序、同一模板只留一份 |
| `cast` | 落进扮演记忆 | 写一条 `rp_memory` 的 `character`，返回开场白 |
| `switch` | **换角色** | cast + 记为当前角色，之后每轮摘要都带着它 |
| `background` | **换背景/设定** | 拿另一张卡当背景（`name`），或直接给文本（`query`）；同时写 `world` 条目 |

「随时调换」不需要重启会话：当前角色/背景写在 `~/.dsh/rp-memory/current.json`，
由提示词段每轮注入（5 秒缓存）。

### 两条性能设计

- **持久索引**：按文件 `mtime + size` 判定，命中就只 stat 不读内容，索引落 `~/.dsh/rp-memory/card-index.json`。24GB 的库第二次开秒级。
- **阶梯读 PNG**：头部 128KB → 尾部 1MB → 整文件（仅 ≤16MB）。多数卡第一档就命中，不会为了找一块 tEXt 把整张图读进内存。

## 扮演记忆放在哪

```
~/.dsh/rp-memory/
├── characters/  角色      ├── bonds/    关系
├── worlds/      世界      ├── scenes/   剧情
├── notes/       杂记      ├── .trash/   forget 归档
├── current.json          当前角色 / 背景
└── card-index.json       卡库索引
```

一条一个 Markdown 文件，带 frontmatter，人能直接改。`id = rp_+sha1(kind:name)`：同名 `save` 覆盖、`append` 续写、`forget` 进 `.trash`。与工作记忆（`memory_*`、`.dsh-memory`）完全隔离。

`rp_memory` 动作：`digest / save / append / read / recall / list / forget`。

## 安装与生效

首次安装（不联网的 link 方式，绕开 pnpm 对 GitHub tarball 的校验）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' -Out '<workspace>\_tmp\rp-install.txt' '<workspace>\tools\install-rp-mode.mjs'
```

> **preset 声明的位置**：desktop 装了 `dsh-purge-community`，它介入 preset 层，从 bundle 通道来的声明不出现在模式下拉里（verifyx 没装 purge，同一份声明能显示）。所以 preset 声明放在 **profile 的 `cordis.patch.yml`（用户 patch 层）**，包内的 `cordis.patch.yml` 为 `[]`。迁移用 `_tmp/move-preset.mjs`（幂等、带备份）。改这一层要重启宿主才生效。

撤销：`install-rp-mode.mjs --uninstall`。改 preset 的插件行或人设要**重启宿主**才重新解析；改 `config.json` 与 `lib/` 因为走 junction，重开会话即可。

## 图形化选卡面板（0.2.0）

页面浮层一个「🎴 卡库」按钮（注入版 `panel.js` 与 `shell.overlay` 双通道，只渲染其中一个）：桌面在右下角 24px；窄屏（手机）在**右上角**，避开输入框右下角的发送按钮。点开是全屏选卡面板：

- 顶部搜索（卡名 / 标签 / 设定里的词，220ms 防抖）+ 三级筛选 chip（形态 / 分级 / 题材）；
- 网格卡片：封面 + 卡名 + 形态·题材 + 属性标签 + 分级 / 字数 / 世界书条数 + 两行简介摘要；
- 点卡片看右侧详情（属性 / 关系 / 玩法 / 体量 / 路径 / 完整摘要）；
- 「填入输入框」把 `rp_card(action=pick, name="…")` 塞进对话框并复制到剪贴板 —— 锁定仍由工具层的会话锁执行，面板不直接写状态。

### 面板布局（0.5.8：只留宽屏 + 窄屏退化）

两套布局只留一套：**桌面宽屏版式**。窄视口（`innerWidth < 760`）自动退化渲染，不改版式本身。

| 项 | 桌面 | 窄屏（手机竖屏） | 为什么 |
|---|---|---|---|
| 悬浮按钮 | 右下 `24px / 24px` | **右上** `right 8px / top 84px`，`bottom auto` | 手机发送按钮就在输入框右下角，压那里会挡住发送 |
| 面板 | `min(1180px,94vw)` × `min(760px,90vh)`，圆角 14px | `100%×100%`，无圆角 | 手机屏幕就是全部空间 |
| 筛选 | 折行，限高 34vh | 每行 `nowrap` 横滑，限高 22vh | `vh` 相对**视口**，34vh 在手机上就吃掉面板四成 |
| 网格 | `minmax(172px, 1fr)` | `minmax(104px, 1fr)` | 竖屏一排 3 个 |
| 详情 | 右侧 320px 常驻 | **没选卡 = 0 高度**；选中 40vh；点把手收 38px | 320px 侧栏在 360px 屏上把网格压成一条缝 |
| 底部 | 不限高 | 限 14vh 可滚 | 命中数与「加载更多」不顶屏 |

改布局只改 `lib/panel.js` 的 `dims()` 一处（唯一尺寸源）。`panel.js` 每次请求从磁盘读
⇒ **手机刷新即生效**；`lib/client.js`（宿主内那版）改了要重启宿主。

`localStorage['dsh-rp-mode.layout']` 已停止读写，历史残留值被忽略，不影响任何行为。

### 按钮的模式判定（0.5.8：三态，未知不灰化）

注入版读不到会话快照，只能看页面文字。旧实现扫 `innerText` 前 4000 字、找不到「扮演模式」就按「不是扮演模式」处理 —— 新会话（blank，标题栏还没画出 preset）与手机端都会落进这条分支，于是被误判。现在：

| 判定 | 依据 | 按钮表现 |
|---|---|---|
| `rp` | `window.__RP_CARDS_PRESET__`（client 通道从会话快照推来的真值）；或页面全文出现「扮演模式 / roleplay」 | 正常亮度，title 写「当前：扮演模式」 |
| `other` | 页面出现内置模式名（标准 / 默认 / 精简 / 编程 / 通用） | 0.6 亮度 + 提示先切扮演模式 |
| `unknown` | 什么都没读到（新会话、快照未就绪、宿主改了 DOM） | **正常亮度**，title 只写「模式未识别，不影响选卡」 |

页面全文扫不截断（旧版 4000 字截断在会话一多就必然读不到）。排查用：控制台执行 `__RP_DETECT_MODE__()` 看当前判定。


后端三条只读路由（`lib/webui.js`，挂在 webServer，注册失败不影响扮演模式）：

| 路由 | 说明 |
|---|---|
| `GET /dsh-rp-mode/cards` | 参数 `q` / `l1` / `l2` / `tag` / `rating` / `limit` / `offset`，返回带标签与摘要的卡片列表 |
| `GET /dsh-rp-mode/cover?rel=` | 封面图流（只放行卡库根下的 png/jpg/webp，拒绝 `..` 穿越与其它扩展） |
| `GET /dsh-rp-mode/meta` | 标签体系（L1/L2 中文名、属性 / 关系 / 玩法清单）+ 统计 |
| `GET /dsh-rp-mode/picker` | **独立卡库页**（0.5.9，移动优先）：不加载网页版的宿主（DSH Go 走 SSH / DSH Remote）用手机浏览器直接打开，选完卡点「复制选用指令」，回 App 粘贴 |

封面直读原图（单张 0.5–2MB），列表用 `loading="lazy"` + 一天缓存；没有封面的卡显示占位块。
client bundle 是手写的（无构建），改完要刷新页面（Ctrl+R）才生效。
- 按钮是否高亮按**三态判定**（见上一节）：client 通道读当前会话的 `projectionValues.agentPreset`（判据同 `dsh-client-ui-agent-preset`）并推给注入版，读不到时判 `unknown`、照常显示而不是灰化。
- 面板本身**不增加任何 token**：数据走 HTTP，不注册工具、不加提示词。

## 配置

`config.json`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | `""` | 扮演记忆目录；空则 `~/.dsh/rp-memory` |
| `cardRoots` | 自建 + 下载库两个根 | 卡库列表：`{path, label, recursive, exts}` |
| `cardRoot` | `""` | 单根简写（给了就只用它，忽略 `cardRoots`） |
| `indexFile` | `""` | 卡库索引路径；空则 `~/.dsh/rp-memory/card-index.json` |
| `tagIndexFile` | `""`（自动探测） | 标签索引 `cards.jsonl` 路径；空则用 `<下载库>\_cardindex\cards.jsonl`，存在即走快速通道 |
| `currentFile` | `""` | 当前角色/背景路径；空则 `~/.dsh/rp-memory/current.json` |
| `digestPerKind` | `8` | digest 每类取最近几条 |
| `recallLimit` | `8` | recall 默认返回条数 |
| `allowedTools` | 见 channel.json | **已降级为兼容字段**：0.5.0 起工具面由 `channel.json` 的 `presets.<id>.tools` 决定；两者必须一致（单测会拦漂移） |
| `denyTools` | 见 config.json | 旧 `restrict` 路线的兜底黑名单，**0.5.0 起不再被主流程调用**（那条路砍不到 agent 自身层的 base 工具） |

`channel.json`（工具面与提示词的唯一源，改完重开会话即生效，不用重启宿主）：

| 字段 | 含义 |
|---|---|
| `presets.<presetId>.tools` | 白名单：只有这些全局工具名对该 preset 的会话可见可调；`run_code` 自动保留 |
| `presets.<presetId>.prompt.note` | 提示词出口的一句话（写进纪律段之前），说明「手上就这些工具」 |
| `presets.<presetId>.inject.sections` | 注入出口的段（如 `time`），与 auto-memory 的 `rp-allowlist.json` 语义对齐 |

诊断落 `~/.dsh/rp-memory/channel.log`，每行带 `[tools]` / `[guard]` / `[install]` 标签；
第一轮会写 `[tools] 通道生效 preset=roleplay 可见 N → M 个工具`。

> preset 里那一行**故意不传 config**：本包不导出 Config schema，配置全走包内 `config.json`，免得预设子行的配置校验把整条 preset 判 broken。

### 上下文压缩（`cordis.patch.yml` 的 `compaction` 段，不在 config.json）

| 字段 | 当前值 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.2` | 占窗口比例触发压缩：1M 窗口 = 20 万 token（约 66 轮） |
| `retainTokens` | `30000` | 压缩后保留最近约 30 轮原文，更早的折成摘要 |
| `headroomTokens` | `4000` | 给摘要本身留的余量 |
| `auto` | `true` | 到阈值自动压，不用手动 `/compact` |

换算：`thresholdRatio = 目标轮数 × 3000 / 窗口`。显式 `retainTokens` 会覆盖框架默认的 `retainRatio`（1M 窗口下 0.16 等于保留 16 万 token，压缩形同虚设）。阈值别调太低——压缩改写前缀会让提示词缓存整段重算，每几轮压一次是负收益。

> 改这一段要**重启宿主**才生效（preset 声明在启动时读取）。

## 已知限制

- **工具面 = preset 行清单**（0.6.0 起）。本包不再包装 `ToolsService.view`、也不再往 `agent.ctx` 补注册；
  运行时唯一的收窄手段是宿主自己的 `agent.ctx.tools.restrict()`，本包默认不调用。
  回滚：`config.json` 顶层 `"legacyChannel": true` 恢复 0.5.x 的轮询注册 + view 过滤器（只为排障保留）。
- `channel.json` 的 `presets.roleplay.tools` 现在只是**声明与自检对账用**，不参与运行时过滤；
  真要减工具，去 `cordis.patch.yml` 删行，别改这份清单。
- preset 只在**新建会话**选模式时生效，老会话不跟着变。
- 挂进来的 12 个工坊工具（rp-kit 6 + gm-craft 6）会占每轮工具定义开销；只想演不想做可以只留 `rp_card` / `rp_memory` / web。
- 首次扫 24GB 下载库要几十秒（之后走索引）；压缩包（`.zip`/`.rar`/`.7z`）里的卡还没解压，扫不到。
- 卡定位先用文件名，同名多张取第一张，`read` 会提示还有几张。
- `book` 只按关键词命中，没有向量召回。
- `book` 的目录（pick/cast 返回的那 20 行）只列前 20 条，超出提示「另有 N 条」；要翻全量得按关键词取。
- `cast` 会把卡正文写进扮演记忆，此后以记忆为准；JSON 改动不会自动同步到已 cast 的条目。
- 提示词段摘要有 5 秒缓存，刚 cast/switch 的角色可能晚一轮出现在注入里。

## 工具

> 名单来源：扮演模式只注册这两个工具（preset 里另外挂 tool-web / rp-kit / gm-craft）。

| 工具 | 说明 |
|---|---|
| `rp_card` | 角色卡库：search 找卡 / pick 选定 / book 取世界书 / cast 落进记忆 |
| `rp_memory` | 扮演记忆：digest / save / append / read / recall / list / forget |

## 变更记录

- 2026-11-12 · **config.allowedTools 补 5 个 `ev_*`**（`ev_fetch`/`ev_extract`/`ev_claim`/`ev_search`/`ev_verify`）。原因：agent 级守卫用 `restrict({allow})` 给每个 agent 上白名单，而 allow 是**交集**语义——不在名单里的 global 工具直接被裁剪。研学模式（`research` preset）会话因此看不到 `dsh-evidence` 的工具（实测 27 个工具 = allow 里仍有效的 4 个 + scope 内注册的 23 个）。补进白名单后 `ev_*` 回到 visible，再由 `dsh-evidence` 自己的 `when` 按 preset 决定显示与否（roleplay/standard 仍 hide）。
- 2026-11-10 · 0.6.8：**解除每轮 200-400 字的长度硬顶，补成人场面直白度规范**（用户实测：描写不足、色情冲击力不够、身体要直接描写）。
  ① 纪律第 2 条从「每次 200-400 字，写完就停」改为「正文 1200-2500 字，性爱/重点场面 2000-3500 字；字数不够就是细节没展开」；
  ② 第 14 条开场从「复现骨架 + 补着力点就停」改为「复现骨架后必须扩写成 1000-1800 字完整画面」，第 15 条无自带开场同样 1000-1800 字，第 13 条介绍 300-500 字；
  ③ 新增第 17 条（成人/性描写硬性：用明确的词写器官、插入、节奏、体液、气味、声音，禁止「那里/结合/做了很久」式替代与淡出跳切，按前戏→进入→节奏变化→高潮→余韵写完）；
  ④ 新增第 18 条（生理反应真实 + 反应按卡内性格分化，禁全员同一套台词）。
  单测 46/14/26 全绿；语法检查通过。
- 2026-11-10 · 0.6.7：**世界书归位 + 重复注册差异化**（用户拍板方案 A）。
  ① 上一版把开局写成「1-2 步」，与「先看目录再取世界书正文」自相矛盾，模型会把 `book` 算成超预算而跳过。
  改为**开局固定 2-3 步**：`pick` → `book`（必取，卡里一条世界书都没有才可跳过）→ 开场介绍，文案里写死
  「设定只能来自卡内世界书，绝不自己编」「宁可多一步取正文，不许省掉 book」。同步改了 `index.js` 的 gate
  与纪律第 6 条（从「触发词出现前」提前到「pick 之后开场之前」）。
  ② 多路注册原先每路各注册一份**完全相同**的定义（`实例数=4`），是摆设且卸载留残影。改为**按落层择优保留**：
  逐路注册 → 每次回读 `view(undefined)` → 第一个让 `rp_card` 出现在 global 层的路径记为 keeper，其余 handle 立刻
  dispose；一路都没打进 global 时**全部保留**（不能删，那时工具可能只在 agent 层可见）。判定逻辑抽成
  `pickKeeper()` 单测覆盖。日志新增 `[register] 保留 ctx.root（global 命中）· 释放 ctx.tools`，判据字段从
  「实例数」改为「路数」。单测 14/31/26/46 全绿。
- 2026-11-10 · 0.6.6：**把开局从 4-5 步压到 1-2 步**。实测一轮开局是 `toolbox(show="rp")` → `rp_card(search)`
  → `rp_card(pick)` → `rp_card(opening)`，四步里只有 pick 是必要的。三处改：① `rp_card` 的工具描述结尾原写
  「先 search 再 read」，直接教模型多调两次 —— 改成「用户点名了卡就直接 pick，不用先 search；pick 已返回卡设定、
  世界书目录与 #1 开场原文，不需要 read / opening」；② `pick` 返回里那句「要换别的：opening(index=2..N)」补一句
  「不要为了取开场再调 opening / read，#1 原文就在上面」；③ `channel.json` 的省步数段从「控制在 3-4 步」升级为
  硬性 1-2 步（点卡直接 pick / 不补 opening / 记忆摘要随提示词给出，不单独 digest）。配合 `dsh-step-saver` 0.1.3
  把 `rp_card`/`rp_memory` 放进 `keep`，`toolbox` 挂载那一步也消失。
- 2026-11-10 · 0.6.5：**pick/cast 不再因为「body 不能为空」整次失败**。现象：模型 `rp_card(action=pick)` 连报
  `body 不能为空`，只能反复重试 pick/switch/cast，一轮里烧掉十几次调用。根因：`pick` 会先调
  `saveEntry(kind=character, body: renderCardMemory(card) || card.description)` 写角色记忆条目，而
  `renderCardMemory` 只取 description/personality/scenario/mesExample —— **有一批卡只有 first_mes，这四项全空**，
  于是 body 为空、`saveEntry` 抛错，整个 pick 失败。改法：① `renderCardMemory` 在四项全空时用 first_mes 兜底，
  再不行给一行占位（永远不返回空串）；② pick 与 cast 的 `saveEntry` 各自包 try/catch，写失败只往结果里加一行
  「角色记忆条目没写成…本局照常」，**卡照锁**。单测 9/14/31/26/16/46 全绿（session-state 26 条，新增 2 条覆盖空卡）。
- 2026-11-10 · 0.6.4：**背景按会话隔离（修「记忆混乱」）**。现象：会话选的是「特异点99」，提示词却在讲
  「莉安娜·魅夜——霓虹都市里那条最亮的暗线」。成因是三处写点各自更新全局 `current.json`：
  ① `rp_card(action=background)` 把背景写全局；② `pick/cast` 里 `scenario: card.scenario || prevCur.scenario`
  会沿用上一局的背景；③ 多卡时 `character` 取卡组第一张、`file` 取刚加的这张 —— 于是出现
  「character=莉安娜 / file=特异点99 / scenario 讲莉安娜」这种半更新状态，`sessionSummary` 又按 `file` 命中就带背景。
  改法：`session-locks.json` 加 `scenario` 字段按会话存；`background` 与 `pick/cast` 都写本会话；
  取背景统一走 `scenarioForSession(lock, cards, current)`——老会话回退全局时必须与卡组**同源**
  （`file` 命中且 `character` 也命中），否则宁可不带。单测 9/14/31/24/16/46 全绿。
- 2026-11-10 · 0.6.3：**注册落层判定 + 补第 3、4 条注册路径**。核对宿主 `dsh-tools/lib/index.js:433` 与
  `dsh-scope/lib/index.js:189` 后确认：`register()` 走 `layers.effect(this.ctx, …)`，落哪一层由
  `scopeOf(this.ctx)` 决定；`view(scope)` 只 merge「global + 该 scope 的祖先链」，**同层兄弟 scope 看不见**。
  0.6.2 的 `ctx.get` 注册报重名（`!rp_memory|rp_card`）说明两条路径是同一个服务，所以「两个实例」不是成因，
  「注册落在 agent 祖先链之外的 scope 层」才是。本次加两条：① `pickToolTargets()` 再补 `ctx.root.tools` /
  `ctx.root.get('tools')`（根 ctx 一般无 scope 标签 ⇒ 落 global ⇒ 任何 agent 都 merge 得到）；
  ② 注册后立刻回读 `view(undefined)` 并在 `toolguard.log` 写
  `[register] 回读 global view=N 命中[…]（落在 global 层 / ← 没落在 global 层）`——这一行直接给出定论，
  不用再靠猜。单测 9/14/31/16/16/46 全绿。
- 2026-11-10 · 0.6.2：**双路注册 + 探针按会话去重**。`sid=session-81434ca9…` 那行给出了决定性数据：
  `viewNames` 与 `setNames` 完全相同（25 个宿主全局工具，含 `web_search`/`web_fetch`，**一个 `rp_*`/`gm_*` 都没有**）。
  也就是说同一个 preset 里 `tool-web` 的注册进了 agent 那份实例，`dsh-rp-mode` 的没进。
  改两处：① `pickToolTargets()` 把 `ctx.tools` 与 `ctx.get('tools')` 两条路径都取出来，凡不是同一对象就**各注册一份**；
  ② 组装探针的去重键从「进程级单值」改成 `Map<会话 id, 行>`，两个会话不再互相压掉记录。
- 2026-11-10 · 0.6.1：**探针只比数量会漏判**。重启后实测 `[assemble] view=25 viewCard=no reg=25 regCard=no known=25 sameTools=diff toolSet=25 toolSetCard=no`：
  注册在启动后 3 秒就完成了（eager，不是"第二轮才注册"），但 agent 那份 toolSet 里仍然没有 `rp_card`；
  `sameTools=diff` 证实 **agent 用的 tools 与插件注册用的不是同一个对象**。旧探针只输出数字，
  第一轮与第二轮数量相同（25）时会被去重掉，看不出内容差别。新增 `sid=` / `viewNames=` / `setNames=`，
  集合一变就落盘。
- 2026-11-10 · 0.6.0：**换掉整条工具面路线**。0.5.13→0.5.15 三轮（view 出口注入 / 探针 / agent 层补注册）都没能让
  `rp_card` 进到请求体：实测 `[assemble] view=2 reg=2 known=2 toolSet=2`，注册 2/2 成功但回读仍无 `rp_card`。
  核对宿主源码后改按官方路线重写：`inject = ['tools']` 保证服务就绪，`apply` 里**同步**注册（与官方 `tool-web` 同构），
  不再包 `ToolsService.view`、不再往 agent 层补注册、不再 setTimeout 轮询。`channel.json` 的工具清单从 19 项
  对齐到 preset 真正挂出来的 16 项（删掉从未挂载的 `read_image`/`ask_user_question`/`vision_describe`），
  提示词里的工具说明同源重写。回滚开关 `legacyChannel`。
- 2026-11-10 · 0.5.15：**restrict 排除后仍 `view=2`，改往 agent 自己的注册层补**。关掉 auto-memory 的 restrict 并重启后，`toolguard.log` 出现 4 次「跳过 restrict」，但同一时刻 `[assemble]` 仍是 `view=2 viewCard=no`；而 `channel.log` 记的是「通道生效 可见 72 → 17」。两个数字说明**至少有两个 tools 实例**：通道那次看到的原始视图有 72 个（含 preset 挂载），agent 视角那次只有 2 个（正好是 preset `tool-web` 提供的 web_search/web_fetch）。依据 `dsh-tools/lib/index.js:477`：`own = layers.peek(scope)` 的注册**无条件进 visible**，`inherited` 要过每一层 `admits()`。所以 0.5.15 做两件事：① `probeAssemble` 增加 `reg` / `regCard` / `known` 三个量，用来区分「没注册进去」与「注册了但被 admits 挡掉」；② 新增 `registerForAgent(context)`——首次见到 agent 时把 `rp_card`/`rp_memory` 注册进 `agent.ctx.tools`，并立刻回读 `view(agent)` 落 `[agent-reg]` 诊断行（含注册成功数、visible 条数、两个工具是否命中）。首轮工具表在 section 求值前已定，所以这一层从第二轮起生效。
- 2026-11-10 · 0.5.14：**加组装期探针**，定位「`view` 已经 17 个、请求体只有 2 个」这一段。0.5.13 注入后重启实测：`channel.log` 写着 `通道生效 preset=roleplay 可见 72 → 17`、保留清单里有 `rp_card,rp_memory`，但新会话请求体仍是 `tools=2 :: web_fetch,web_search`。说明断点不在注册、也不在 `view`，而在宿主把工具转成 schema 的环节——`dsh-tools/lib/index.js:419` 是 `selectExecutor(scope).describe(this.definitions(scope, toolSet))`，而 `definitions(scope, toolSet)`（同文件 579-581）在**有 toolSet 时读的是 `toolSet.view(scope)`**，不是 `ToolsService.view`；`toolSet` 由同文件 542-571 的 `resolve()` 产出。新增 `probeAssemble(context)`：在 `section.text` 里（它拿到的就是 `assemble()` 的 context，含 `agent`/`scope`/`toolSet`）量一次 `view(agent)` 与 `toolSet.view(scope)` 的条数与 `rp_card`，变化时写 `toolguard.log` 的 `[assemble]` 行。这一行能一次分清「toolSet 里没 admitted」与「admitted 了但 schema 投影时被丢」。
- 2026-11-10 · 0.5.13：**修「扮演会话请求体里没有 rp_card」的真正根因**。宿主 `dsh-tools/lib/index.js:477 view(scope)` 里 agent 自己那层（own）的注册无条件可见，其它层要过 scope 链继承；rp-mode 注册在 preset realm 的层，这条链不通。证据：`toolguard.log`「注册后回读 view(undefined)：6 个，命中 [] ← 注册没落在这个实例里」，而新会话请求体是 `tools=2 :: web_fetch,web_search`。改法：在 view 出口补——`buildExtraTools()` 把 `createTools()` 的定义做成**稳定 registration**（必须是同一对象实例，否则 `dsh-tools:568` 的 `===` 准入校验会把工具剔掉，表现为 schema 有、调用 UNKNOWN_TOOL），`filterView(view, keep, extra)` 按白名单过滤的同时把白名单允许、原本不可见的工具补进 `visible`/`registrations`，`installChannel(ctx, tools, config, definitions)` 透传。`definitions()` / `schemas()` / `executable()` 全部从 view 派生，一处补齐全链生效，**首轮即可用**（不再等第二轮）。非扮演会话不受影响（判定点仍按 preset，fail-open）。离线仿真：roleplay 视图 = `web_search,web_fetch,rp_memory,rp_card`，standard 视图不变，registration 跨次同一对象。新增 `tests/channel-tool-inject.test.mjs`（14 条）并登记全量回归。
- 2026-11-10 · 0.5.12：**修「新会话切卡不生效 / 读不到卡」**。根因不是工具缺失：提示词的角色摘要与「本会话角色已定」判据读的是**全局** `current.json`，新会话因此继承上一局的卡，提示词直接告诉模型「角色已定、要换请新建会话」——模型不挑卡、也切不动；真正按会话记的 `session-locks.json` 只用于拦换卡，从不参与提示词。改为 `resolveCardsFor(root, sessionId)`：有锁=有卡，无锁=没卡（`lib/session.js`）；`section.text` 改成 `(context) => cachedDigest(config, context.agent)`，用 `agentSessionId(agent)` 取会话 id（宿主每步传 `context`，见 `dsh-system-prompt/lib/index.js` 的 `section.text(context)`）；摘要走新 `cardsSummary()`（`lib/card.js`），`current.json` 降级为「最近使用」，只给面板与工具回显。缓存从「5 秒单条」改成 `Map`，键 = 会话 id + `current.json` mtime + 卡组文件列表：切卡立刻重算，两个会话不再串文本。另去掉 `resolvePresetOf` 的 `agent.preset` 兜底（`channel.log` 里 `preset=cordis` 的来源），并把「从哪个字段命中」写进 `channel.log`。新增 `tests/session-state.test.mjs`（16 条）并登记全量回归；新增探针日志 `~/.dsh/rp-memory/prompt-probe.log`（只记变化，`sid / preset / cards / names`）。
- 2026-11-10 · 0.5.11：**补上真正的修复：声明 `export const inject = ['tools']`**。0.5.10 重启后诊断仍写 `tools 来源=ctx.get`——`pickTools()` 的 `ctx.tools` 分支形同虚设，因为没声明依赖时属性访问在插件 ctx 上拿不到服务；于是工具还是注册进根层实例，扮演会话每步真正发出去的函数表只剩 `web_fetch` / `web_search`（实测会话记录：模型自述「本轮函数列表里没有 rp_card」）。本轮三插件统一声明 tools 依赖，`ctx.tools` 改为 realm 绑定实例。另加一行「注册后回读 `view(undefined)`」诊断：注册完立刻回读，命中 rp_card/rp_memory 才算落在同一实例里，一眼区分「注册错实例」与「注册对但被过滤」。`systemPrompt` 仍走 `ctx.get`——当年 `inject = ['tools','systemPrompt']` 的事故是它导致插件不激活。`dsh-rp-kit` 0.1.2、`dsh-gm-craft` 0.1.3 同轮同改。
- 2026-11-10 · 0.5.10：**修「扮演会话里没有 rp_card / rp_memory」**。`registerWhenToolsReady` 原来只用 `ctx.get('tools')` 取工具服务；在 preset 的 isolate realm 里这条路径可能解析到宿主根服务，工具注册进宿主层，preset 会话的 `tools.view()` 看不到，实测 roleplay 会话请求头只剩 `tool-web` 的 `web_fetch` / `web_search` 两个工具。改为 `pickTools()`：优先属性访问 `ctx.tools`（沿用当前 ctx 的 realm 绑定），失败再退 `ctx.get('tools')`，并把命中来源写进 `apply 完成：注册 … tools 来源=ctx.tools|ctx.get` 这一行诊断，下次不用猜。`dsh-rp-kit` 0.1.1、`dsh-gm-craft` 0.1.2 同轮同改。

- 2026-11-10 · 0.5.9：**新增独立卡库页 `/dsh-rp-mode/picker`**，解决「不加载网页版的宿主上没有卡库面板」——DSH Go 这类原生客户端走 SSH / DSH Remote 时，注入版 `panel.js` 完全不会出现（App 有自己的 UI，不渲染 index.html）。新页面是纯静态 HTML（`lib/picker.js`），移动优先：搜索框 + 形态/分级横滑筛选 + 104px 卡片网格 + 底部「复制选用指令」条；只打 `/cards` 与 `/meta` 两条只读路由，**不依赖 WebSocket / mux**，所以之前那串连接问题也绕开了。选完卡复制的是 `rp_card(action=pick, name="…")`，回 App 粘贴即可（剪贴板 API 失败时降级 `execCommand`）。新增 `tests/picker.test.mjs`（21 条：骨架 / 只读依赖 / 指令格式 / 内联脚本语法 / 处理器），并把 `layout.test.mjs` 一并登记进全量回归（此前漏登记）。

- 2026-11-09 · 0.5.8：**手机端两处修复**。①**卡库按钮不再挡发送键**：窄屏（`innerWidth < 760`）把悬浮按钮从右下 24px 改到右上（`right 8px / top 84px / bottom auto`），并随 `resize` 重算；宽屏仍是右下 24px。`lib/panel.js` 抽出 `launcherDims()` / `launcherStyle()`，`lib/client.js` 抽出 `launcherStyle()`，两条通道数值一致。②**新会话不再被误判**：模式判定从「`innerText` 前 4000 字里找『扮演模式』，找不到就当不是」改成三态——client 通道从 `session.projectionValues.agentPreset` 读到的真值优先（推给 `window.__RP_CARDS_PRESET__`），其次扫页面全文，两者都没有时判 `unknown` 并**保持按钮正常亮度**。顺带修两个真 bug：`open()` 里 `els = {...}` 漏掉 `btn`，导致面板开过一次后按钮状态永久冻结；`presetOfSession` / `sessionIdOf` 在 `snap.current` 未就绪时退回「最后一个会话」，会读到上一个会话的 preset 与锁。`tests/layout.test.mjs` 扩到 39 条（新增按钮位置 3 条、模式判定三态 5 条）。回归：layout 39/39、panel 21/21。

- 2026-11-09 · 0.5.7：**删除精简布局，只留宽屏版式 + 窄屏退化**（0.5.6 一度把宽屏删掉、只留手机那套，方向反了，本版改回）。`lib/panel.js` 的 `dims()` 只保留宽屏尺寸，并新增 `isNarrow()`（`innerWidth < 760`）做退化：面板铺满、主体竖排、网格 172→104、筛选 34vh→22vh、详情从右侧 320px 常驻改成「没选卡 0 高度 / 选中 40vh / 点把手收 38px」、底部限 14vh。删掉布局切换按钮与 `layoutLabel/saveLayout/readLayout`（`compact` 保留为常量 false，几十处 `compact ?` 仍选宽屏呈现）。`lib/client.js` 同删切换按钮，`compact` 恒假。`localStorage['dsh-rp-mode.layout']` 停止读写，残留值忽略。`tests/layout.test.mjs` 重写为 30 条（桌面宽屏 / 筛选项折行 / 重开一致 / 窄视口 390 退化），旧的「切到精简 / 切回宽屏 / 记住选择」断言随功能删除。回归：layout 30/30、panel 21/21。

- 2026-11-08 · 0.5.5：**卡库面板加「宽屏 / 精简」两套布局（手机端可用）**。问题不在宽度而在纵向：七组筛选 chip 在窄屏折成十几行、加头部与底部共挤掉约六成高度，网格只剩一条缝；右侧 320px 详情栏同时把横向吃光。**不做设备识别**，改成面板左上角一个按钮手动切（`▤ 宽屏` / `▣ 精简`，选择记 `localStorage['dsh-rp-mode.layout']`，注入版与 client 版共用同一个键）。精简模式：面板 `100%×100%` 无圆角无外边距、筛选行 `nowrap` 横向滑动且整块限高 24vh、网格列宽 172→104px、卡片只留封面+名字+分级徽章、详情从右侧栏改成下方 34vh 抽屉（点把手收成 38px，把高度全给卡片墙）。注入版 `lib/panel.js` 用 `dims()` 做单一尺寸源 + `applyLayout()` 重设内联样式；client 版 `lib/client.js` 用 `layoutOf(compact)` 覆盖同一批键，两条通道数值一致。新增 `tests/layout.test.mjs`（极小 DOM stub 真跑 panel.js，点按钮切布局并断言生成的 style 字符串，31 条）。注意：`panel.js` 每次请求都从磁盘读，改完**手机刷新页面即生效**；client 版要走宿主重启。

- 2026-11-08 · 0.5.5：**开局省步数——世界书目录化 + 一次问多话题**。实测会话 `session-6bc5ebe1` 第一轮 `rp_card` 被调 6 次：`search` → `read` → `pick` → `book(场景)` → `book(同一场景换措辞)` → `book(性格)`，其中第 4、5 次命中同一批条目。根因是 `pick/cast` 只回一句「该卡带世界书 N 条」，模型看不到有哪些条目，只能逐条试探。现在：①`lib/card.js` 新增 `bookIndex()` / `renderBookIndex()`——`pick/cast` 直接返回世界书目录（条目名｜关键词｜开头 40 字｜字数，最多 20 条，**不含正文**）；②`book` 的 `query` 支持多词（空格/顿号/逗号分隔），另加 `queries` 字符串数组，多词时各查一遍、按命中词数排序、同一模板只留一份，`limit` 默认 10、上限 30；③`channel.json` 三个 preset 的 `prompt.note` 各加一条硬性纪律（先看目录再取，一次完整开局控制在 3-4 步）。新增单测 `tests/rp-book-batch.test.mjs`（17 条）并登记进全量回归。
- 2026-11-08 · 0.5.4：**用上卡自带开场（96% 的卡都有）**。调研见 `docs/rp-openings-survey.md`：自建库 96.1%、下载库抽样 96.4% 有 `first_mes`，约一半还有平均 3 个备选，中位 700-950 字。以前 `pick/cast` **随机抽一个、其余丢掉**，等于浪费作者的稿子。现在：①`lib/card.js` 新增 `openingsOf()` 与 `fillPlaceholders()`（`{{user}}`→「你」、`{{char}}`→卡名、`<user>`/`<char>` 同样替换）；②`pick/cast` 返回**开场清单**（序号 + 标签 + 前 80 字）并给 #1 原文，其余用新接口 `rp_card(action=opening, index=N)` 换；③开场礼仪分两条路——**有自带开场就照原文复现**（不改写/缩写/换视角/并段），只在末尾补场景锚点与一个玩家能接住的着力点；**没有就按同一套礼仪现写**（时间地点 + 感官细节 + 可被回应的动作 + 停在能接的地方）。三处落点：`channel.json` 的 `prompt.note`（热读当轮生效）、`index.js` 纪律 13-16、`tools.js` 的 `opening` 分支与 `pick/cast` 返回（重启生效）。新增单测 `tests/openings.test.mjs`（17 条）并登记进全量回归。
- 2026-11-08 · 0.5.3：**首轮礼仪——卡加载后先介绍、后开戏**。以前选完卡就照着 `first_mes` 铺开剧情，用户还没表态就被推着走。现在卡刚 pick/cast 上来时只做开场介绍（一句话说清角色是谁/在哪/什么关系 → 3-5 条「开戏前该知道的事」→ 说明本卡自带几个开场 → 问一句从哪开始就停，200-350 字），用户第一次回应之后才正式进入叙事。落点三处：`channel.json` 的 `prompt.note`、`index.js` 演出纪律第 13/14 条 + `gate` 文案、`tools.js` 的 pick/cast 返回。
- 2026-11-08 · 0.5.2：**卡里的 HTML 在加载口折成纯文本（中间方案）**。DSH 的对话框只用 micromark 解析 CommonMark，没有 HTML 直通（`rehype-raw` / `allowDangerousHtml` 都不在），酒馆卡作者写的 `<details><summary>…<div style="background-color:#1A1A1A">` 状态面板会被模型原样照抄。新增 `lib/html-text.js`：`htmlToText()` 把常见排版标签折成 Markdown（`<li>`→`- `、`<strong>`→`**`、`<summary>`→加粗标题行、`<br>`→换行），剥掉内联样式、解实体、清 `clip()` 截断留下的残缺开标签，`a < b` 这类比较符不误伤。落点选在**加载口**（`normalizeCard` 的文本字段 + `alternateGreetings` + `stripImageTags`），因此 `buildStageKit` / `renderCardMemory` / `currentSummary` / 世界书全部受益，一处清洗下游全干净。配 `tools/clean-rp-html.mjs` 清理已落盘的旧记忆（默认 dry-run，`--apply` 才写且整份备份）。新增单测 `tests/html-text.test.mjs`（27 条）并登记进全量回归。实测：`characters/rp_7e34eace5929.md` 从含 6 处 HTML 变成 0，4900 → 4356 字。
- 2026-11-08 · 0.5.1：**修 `rp_card` / `rp_memory` 从未注册成功**。`tools.register()` 强制要求 `output.render` 是函数（`dsh-tools` 的 TypeError 校验：`tool "x" must declare output { schema, render, presentationMeta? }`），而两个工具的定义只给了 `output.schema` ⇒ 每次 `register()` 都抛错被 catch 吞掉；旧诊断 `apply 完成：注册 2 个工具` 只统计**尝试次数**，所以一直显示"成功"。扮演会话里因此没有角色卡与扮演记忆工具——与通道过滤器无关（过滤只做减法）。补 `render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }]`，`renderToolValue` 优先用工具已排好的 `lines`，其次 `hits` / `rows`，最后 JSON 兜底并截断 8000 字。诊断改为 `[register] 失败 a,b（成功 1/2）` 落 `channel.log`，并新增「白名单里配了但本会话不可见」的告警行。
- 2026-11-08 · 0.5.0：**扮演通道（一个判定点 + 三条出口）**。0.4.1 的 `tools.restrict` 路线被证伪：`restrict` 的 `known` 只含**全局层 + 祖先链**，且 scope 自身注册的工具不受 restriction 影响（`dsh-tools/lib/index.js` `restrict()` / `view()`），而 base 工具随 agent 挂载在 agent 自身层 → 实测 deny 手写 66 个名字里只有 `qq` / `sticker` 两个 host 平面工具被认出来。`systemPrompt.context` 取 agent 那条路在真实宿主里从未触发；`system-prompt/assemble` 瀑布改 `assembly.tools` 也改不动（末尾强制覆盖）。改为包装唯一汇聚点 `ToolsService.view(scope)`：命中 `channel.json` 的 preset 就过滤 `visible` / `registrations`，一次覆盖描述、schema、`definitions()`、`executable()`、`resolve()` 每步准入与 `get()`；再加 `tools.guard` 做执行兜底，提示词段补一句工具面说明。新增 `channel.json`（唯一配置源，热更新）与 `~/.dsh/rp-memory/channel.log`（唯一日志，带 `[tools]` / `[guard]` / `[install]` 标签）；旧 `toolguard.log` 与 `applyToolAllowlist` / `installAgentToolGuard` 保留但不再进主流程。新增单测 `tests/channel.test.mjs`（46 条：判定点 / 过滤 / 幂等 / guard / 配置防漂移 / registry 权威优先），并登记进全量回归。设计说明见 `docs/rp-mode-channel.md`。
- 2026-11-08 · 0.4.2：**卡库面板翻页 + 全标签筛选**。翻页：后端 `queryRows` 一直支持 `offset`（`webui.js:99/124`），前端却写死 `limit=48` 且从不传 offset → 11814 张卡永远只看得到 48 张；现在改成分页（每页 48，滚到底自动续页 + 底部「加载更多」按钮，显示「命中 N 张，已显示 M 张」）。筛选：`meta` 以前只吐 `l1/l2/traits/relation/kink`，现在补齐 `body/persona/role/scene`；面板从 3 行 chips 扩到 **7 组**（形态/分级/题材/身体/性格/身份/属性/关系/玩法/场景），组内多选走 `tag` 的 AND 语义，每组默认铺 18 个、超出折叠成「…+N」。**撤掉 `inject` 硬依赖**：`export const inject = ['tools','systemPrompt']` 是 cordis 的硬依赖，preset scope 下任一服务不可见就整个插件不激活（现象：`rp_card` 消失），改回 `ctx.get()` 软访问，拿不到就按能力降级。新增落盘诊断 `apply 完成：注册 N 个工具 [...]` 到 `~/.dsh/rp-memory/toolguard.log`。新增单测「两份白名单一致（防漂移）」：`config.json` 的 `allowedTools` 与 `auto-memory/rp-allowlist.json` 的 `roleplay.tools` 必须相同。
- 2026-11-08 · 0.4.1：**工具白名单（`tools.restrict`）**。实测扮演会话里仍是 **69 个工具定义** —— preset 的 `plugins` 是「Agent 的子插件列表」，只能**加**，减不掉 base bundle 里的 bash / pwsh / fs / fs-search / skill / todo / goal / subagent / workflow / jobs / plan-mode 等工具；官方文档也写明「工具目录跨模式保持不变（为请求缓存稳定）」。改用 `dsh-tools` 的 agent 作用域限制 API：`tools.restrict({ allow })` 命中后工具从该 agent 的描述、schema 与执行集合里一起消失（不只是挡调用）。实现走 allow 优先、allow 全被判未知时退回 `deny` 固定名单、两条都失败只 warn 降级；`config.json` 的 `allowedTools` / `denyTools` 控制名单（改完下一次会话生效，不用重启）。
- 2026-11-08 · 压缩曲线：`compaction` 从 `thresholdRatio 0.02 / retainTokens 8000 / headroomTokens 2000`（1M 窗口下约 6 轮就压一次）回调到 `0.2 / 30000 / 4000`（约 66 轮触发、保留 30 轮原文）。原因：2 万 token 本身不大，而每次压缩改写前缀都会让提示词缓存整段重算，压得太勤是负收益。README 补了「上下文压缩」配置表。
- 2026-11-08 · 0.4.0：**群聊**——会话锁从「一张卡」升级成「卡组」，`pick`/`cast` 可以连续加人（上限 4 张），`rp_card(action=leave, name=…)` 移出一张；`current` 列出全员，提示词里加了群聊纪律（各角色按自己性格说话、用名字区分）。**卡自带正则的提示词侧处理**：`pick` 时读出 `extensions.regex_scripts`，把「本卡有 N 条正则、其中 M 条是发送前清理用的、涉及哪些脚本」写进演出包，并要求模型不要重复上一轮的状态栏/变量块——DSH 没有 pre-send 钩子，做不到真正裁历史，这是当前能做到的最接近实现。**swipe（提示词级）**：用户说「再来一版」重写上一轮、说「两版」给两个版本用 `====` 分隔。
- 2026-11-08 · 0.3.0：标签体系从「属性 33 / 关系 14 / 玩法 20」扩到**六组 195 个**——身体 30（巨乳/贫乳/长腿/翘臀/黑皮/兽耳/尾巴/异色瞳…）、性格 20（病娇/傲娇/疯批/婊气/毒舌/母性…）、身份 35（学生/教师/护士/女仆/巫女/修女/骑士/魔法少女/魔王…）、关系 16、玩法 72（口交/乳交/足交/肛交/内射/潮吹/催眠/常识改写/触手/产卵/调教/BDSM 全套/NTR/援交…）、场景 22（卧室/浴室/教室/电车/地牢/酒吧…），词表参照主流成人站的 tag 体系与里番常见分类；`body/persona/role/scene` 作为新字段写入索引，搜索与 tag 过滤全部覆盖。开场从 4000 提到 **8000 字**，并把 `first_mes` 与 `alternate_greetings` 合成候选池**随机抽取**，同一张卡每局开头不一样。
- 2026-11-08 · 0.2.3：面板改走**页面注入**——host 在 `webserver/index-inject` 里推一条 `script-src /dsh-rp-mode/panel.js`，`panel.js` 是纯 JS（无框架、不依赖 client 模块系统），按钮与面板自己建 DOM。原 client 通道保留作双保险，检测到注入版在跑就自动不渲染。根因：`dsh.client` 声明在 desktop profile 上没被挂载（切换模式、刷新页面均无按钮）。
- 2026-11-08 · 0.2.2：面板显示**本会话锁定状态**（`meta?session=` 读 `session-locks.json`，锁定后顶部提示、选卡给提示）；封面走 320px webp 缩略图（`cover?w=thumb`，缺失回退原图），列表首屏从 ~28MB 降到 <1MB；`dsh-fyrunner` 已卸载（preset 6 行 / 16 个工具），`rp-kit`、`gm-craft` 移出 bundles（只在扮演模式挂载）。
- 2026-11-08 · 0.2.1：面板只在扮演模式会话显示（读 `projectionValues.agentPreset`，拿不到则 fail-open）；`rp_card` / `rp_memory` 的工具描述与参数说明压缩，固定开销 1990 → 1768 字符。
- 2026-11-08 · 0.2.0：图形化选卡面板——`shell.overlay` 浮层按钮 + 全屏卡片墙（封面 / 标签 / 简介 / 详情 / 一键填入 pick 指令）；新增 `lib/webui.js` 三条只读路由（cards / cover / meta）。面板不直接改锁，锁定仍走 `rp_card`。单测 21/21（契约 7 + 后端 14）。
- 2026-11-08 · 0.1.4：会话级角色锁——开局可自由 `search` / `list`，`pick` 一次即锁；锁定后 `pick` / `switch` / `cast` 别的卡直接拒绝（`locked: true`），`search` / `read` / `book` 不受影响；`list` 增 `l1` / `l2` / `tags` 过滤；提示词段按「有没有当前角色」注入开局引导。修 0.1.3 遗留：`switch` 分支仍引用已删除的 `index` 变量（会抛 ReferenceError）。
- 2026-11-08 · 0.1.3：接 `_cardindex/cards.jsonl` 标签索引（9918 张卡：粗粒度形态 + 题材 + 属性/关系/玩法 + 分级 + 体量）。`rp_card` 的 `search`/`list`/`read` 优先走索引（加载 0.1s、搜索 30ms），索引缺失自动回退旧的全库扫描；`search` 增 `tags` / `l1` / `l2` 过滤。
- 2026-11-08 · 0.1.2：卡库改为**多根**（自建 + `jueseka2` 下载库），加 PNG 图片卡解析（`tEXt` 的 `chara`/`ccv3`）、持久索引（mtime+size）、阶梯读；`rp_card` 增 `current` / `switch` / `background`，当前角色由提示词段每轮注入。修 `list` 引用已删除的 `cardRoot`、`search` 按旧 API 取 `hit.card` 两个 bug。单测 20/20。
- 2026-11-08 · 0.1.1：加 `rp_card`（角色卡库读取 + cast 落记忆）；preset 挂入 `dsh-rp-kit` / `dsh-gm-craft` / `dsh-fyrunner` 共 13 个工坊工具；人设补「先找卡再开场」。
- 2026-11-08 · 0.1.0：首版。preset `roleplay`，`rp_memory` 单入口，记忆落 `~/.dsh/rp-memory`。
