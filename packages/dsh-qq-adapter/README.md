# dsh-qq-adapter

QQ 渠道适配器：**OneBot 11 桥（SnowLuma / NapCat）↔ 主体内核**。

```
OneBot 11 反向 WS 事件
   │  过滤：私聊 / 群白名单 / 必须 @ / 每分钟限速 / message_id 去重
   ▼
身份：~/.dsh/dafeiyu/compiled/identity.qq.txt（由 dsh-dafeiyu-core 生成）
   │  + 当前这句
   ▼
宿主 llm（deepseek-flash）→ 清洗（≤120 字）
   ▼
OneBot HTTP：/send_private_msg 或 /send_group_msg
   ▼
chatlog：~/.dsh/pet-diary/chats/YYYY-MM-DD.jsonl（channel:"qq"）
```

## 前提

1. 装好 OneBot 11 桥并登录 QQ（本机现用 SnowLuma，NapCat 亦可；小号推荐）
2. 桥配好 **反向 WebSocket**（ws://127.0.0.1:3001）与 **HTTP 服务**（http://127.0.0.1:3000）
3. 两边 token 一致（可留空）

## 配置

真实配置放用户目录 `~/.dsh/dafeiyu/qq.json`（即 `%USERPROFILE%\.dsh\dafeiyu\qq.json`），不进仓库、不进发布包；仓库只保留模板 `config.example.json`。首次部署把模板复制过去，改 `ownerId` / `groups` 即可。加载顺序：内置默认值 → `config.example.json` → `config.json`（旧版遗留）→ `qq.json`（本地覆盖，最后赢；嵌套对象深合并）。

```json
{
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": "",
  "allowPrivate": true,
  "groups": ["你的群号"],
  "requireAtInGroup": false,
  "maxReplyChars": 120,
  "ratePerMinute": 6,
  "identityFile": ""
}
```

- `groups` 为空 = 不接任何群；私聊默认接
- `requireAtInGroup`：`true` = 群里必须 @ 才回；`false` = 不 @ 也进判定（走 policy，`mode=shadow` 时只记日志不发），@ 仍必回
- `identityFile` 留空 = `~/.dsh/dafeiyu/compiled/identity.qq.txt`
- `subscribeShadow`：2.2 订阅直通的影子开关（`enabled` 默认 false，`dir` 默认 `~/.dsh/dafeiyu/qq-shadow`）。开着只把非 @ 群消息的体量写成按天 JSONL，用来估算「改成工单卡片能省多少 token」；**不改变任何回复/发送行为**。
- `imageLibrary`：收到的图片/表情包/GIF 落库（`dir` 默认 `~/.dsh/dafeiyu/image-library`，`maxFileBytes` 单图上限，`maxRecentFiles` / `maxRecentBytes` 最近档滚动上限，`judge` 是「值不值得收藏」的本地判断配置）

## 工具

| 工具 | 作用 |
|---|---|
| `qq` | 单入口：`action=status` 看是否连上后端、已回复/忽略多少、最近错误；`action=send` 手动发一条文字/图片/语音/文件（测试通道用） |
| `sticker` | 图片/表情包/GIF 库：`list` / `search` / `save` / `forget` / `path` / `stats` |

## 自检

```bash
node tests/smoke.mjs           # 26 项：解析/过滤/限速/提示词/编排/HTTP 发送/chatlog
node tests/image-sticker.test.mjs   # 图片库：去重/收藏/淘汰/动图识别/「存这个」意图/判断兜底
node tests/send-action.test.mjs     # 发送层：exec 与消息段两条通道、TTS、voice 优先、失败不抛错
```

## 使用说明

**什么时候用**

- 查连接和收发计数 → `qq(action=status)`
- 测试发一条 → `qq(action=send, kind, targetId, text)`（**真人场景少用**，容易被判异常）
- 模型看不了图时 → 调 `dsh-vision` 的 `vision_describe`（把图片转成文字描述）

**工具**

| 调用 | 参数 |
|---|---|
| `qq(action="status")` | 不带其他参数；回是否连接、已回复/忽略/交微心跳多少、最近错误 |
| `qq(action="send", kind, targetId, text?, image?, voice?, say?, file?)` | `kind=private\|group`，targetId 是 QQ 号或群号；`image`/`voice`/`file` 都是**本机绝对路径**，可以只给其中一个；`say` 给文字自动合成语音 |

- `image` → OneBot `image` 段，和 `text` 合成一条发出（≤20MB）
- `voice` → OneBot `record` 段；给 wav/amr 即可，**SnowLuma 会自己转 SILK**（日志 `[Highway.Ptt] converted record to silk`）
- `say` → 给文字，插件先走本机 **SSVO 语音网关**（`uni-voice`，默认 `http://127.0.0.1:9882`）合成自然音色 wav 再当语音发；网关未启动或合成失败时自动回退 **Windows SAPI**（`lib/say.ps1`）。和 `voice` 二选一；同时给时以 `voice` 为准。detail 会标明实际通道（`TTS 622KB ssvo/edge` 或 `TTS 207KB sapi`）
- `file` → 走 `upload_private_file` / `upload_group_file`，任意类型
- 自动回复仍只发文字；这三个是手动通道，服务端风控比纯文本敏感，别在群里开场就用

**什么时候别用**

- **账号风控期不要用 `qq(action=send)` 测试**——每次发消息都是风险
- 群知识、消息收发这些是自动流程，别手动干预
- `connected=false` 先看 QQ 桥（SnowLuma / NapCat）有没有起，别急着调代码

## 图片 / 表情包 / GIF 库（2026-11-02 起）

QQ 收到的图（含 GIF）、客户端拖进来的图都会自动落库，分两档：

| 档 | 什么时候进 | 会被淘汰吗 |
|---|---|---|
| recent | 收到图就进；sha256 去重，同一张只存一份 | 会：超过 `maxRecentFiles`（默认 300）或 `maxRecentBytes`（默认 150MB），按最久未出现滚动删 |
| saved | AI 判断值得收藏 / 主人说「存这个」 | 不会，永久保留 |

- **AI 自己判断**：看图回复生成后，把那句回复当描述交给本地 qwen3:4b（`imageLibrary.judge`）。表情包、梗图、可爱图、动图、二次元插画 → 收藏；聊天截图、含隐私、文档表格 → 不收藏；判断失败一律不收藏，且不阻塞回复。**判断范围不分来源**：QQ 私聊、群里、客户端拖图都会判，只要 AI 觉得值得就收。
- **存图权限归主人**：手动指令「存这个 / 存这张图 / 把这张图存起来 / 收藏这张」只在主人私聊生效（群里、陌生人说了不算）；说「别存了」取消收藏。
- **客户端拖图**：客户端上传的图会落成附件（`~/.dsh/attachments/v1/objects/<aa>/<sha256>`），插件走两条互补的路收它：① `llm/stream` 观察器读 message 里的 image 块；② `fs.watch` 监视附件目录，新文件一出现就收。任一条成功即可。拖图后直接说「存这个」就能存；也可以 `sticker(action=save, path=本机绝对路径)` 或 `attachment=<附件 id>`；都没有时兜底取「附件目录里最近两小时上传的图」。
- **GIF 原样保存**，不转码不抽帧；动图标记靠文件头识别（GIF / APNG / 动态 WebP）。
- **非 @ 的群消息**交给微心跳，不经过这里；私聊与 @ 到的群消息才入库。
- **之后要用**：`sticker(action=list, saved=true)` 看收藏，`sticker(action=path, id)` 拿绝对路径，再用 `qq(action=send, image=路径)` 发出去。
- 看图与入库共用一次下载：bytes 直接喂视觉模型，不再按 URL 取第二遍。
- 库目录不是 git 仓库；备份整目录拷走即可（`index.json` 是元数据，`files/` 是原图）。

## 记忆分档（2026-11-02 起）

| 场景 | 检索什么 | 注入进来的样子 |
|---|---|---|
| 主人私聊 | 全量记忆（`visibility` 不限） | 【长期记忆（只有你知道）】 |
| 群聊 / 陌生人私聊 | 只检索 `visibility=public` 的条目 | 【公开记忆（关系与形象，可以自然提起）】 |

公开档只该放关系、称呼、公开形象这类能对外讲的事；本机路径、账号、行程、设备、费用、日记正文一律写 `private`。群聊里的「关系与形象」主要来自 `dafeiyu-core` 编译进 `identity.qq.txt` 的静态清单（`core/relations.md`），记忆检索只做补充。

## 执行层（2026-11-03 试点）

- 图片入库不再直接写库，而是先落 SQLite `effects` 队列（`~/.dsh/dafeiyu/exec/qq.db`），再执行：`pending → running → done / failed / unknown`。
- 幂等键 = `image:<sha256>`：同一张图重复入队只保留一条；执行器按 staging 文件重放，成功后删 staging。
- 启动时把租约过期的 `running` 收回：幂等 kind（`image.*`）退回 pending 重放；非幂等（如 `qq.send`）进 `unknown`，只对账、不自动重发。
- 配置：`execLayer.enabled`（默认 true）、`execLayer.dir`、`execLayer.tickMs`、`execLayer.maxAttempts`；`node:sqlite` 不可用时自动回退直写。done/failed 记录保留 30 天后自动清理。
- 纯文字 `qq(action=send)` 已接执行层：成功记 done、桥明确拒绝记 failed（不重试）、网络层不确定记 unknown（可能已发出，等对账，绝不自动重发）；带图片/语音/文件的发送仍走同步路径。
- `qq(action=status)` 返回执行层计数（execDone / execFailed / execUnknown / execPending）；有 unknown 时状态行直接提示「执行层待对账 N 条」。
- `qq(action=reconcile)` 处理 unknown：不带 `id` 列出待对账（记录 id、群/私聊、目标、文本前 40 字、试过几次、最后错误）；带 `id` + `decision=sent|not-sent` 人工裁定：`sent` 记 done（确认已发出），`not-sent` 记 failed（确认没发出，要补发请手动 `qq(send)`）。只接受 unknown 记录，其他状态拒绝改写，裁定同时闭合对应的 attempts 行。
- 同步等待按 deadline（`timeoutMs`，默认 8000ms）而不是固定轮数：队列里有积压时也能等到自己那条进终态，不会因为前 3 条被别人占了就误报 `queued`。
- 本轮只接图片入库与纯文字发送两条链路；消息自动回复仍走原同步路径。
- 2026-11-04 补齐四表：`inbox`（外部事件按 `(source, external_id)` 去重入场，CAS 认领 `new → claimed`）、`work`（工单 `open → running → done/blocked/failed`，带 `mandate`）、`effects`、`attempts`；`counts()` 给状态行用，`prune` 一并回收 inbox/work 终态。**四表已齐，但 inbox/work 暂时没有消费方**——等 Trigger 从影子模式正式接管后再接线。

## Trigger 影子模式（阶段 1.2，2026-11-04）

- 每条 QQ 事件进 `handleEvent` 时，先压成与渠道无关的 `Trigger{id, source, actor, human, addressed, thread, at, text, meta}`（`lib/trigger.js`）；id = `sha256(source:thread:messageId)` 前 16 位，可去重。
- 纯函数 `fastPath()` 判一次：私聊放行 / 群白名单 / @ / auto / 唤醒词，**不调模型**。
- **只记不执行**：fast 结论与现网 `shouldAnswer()` 的结论一起写进 `~/.dsh/dafeiyu/trigger-shadow.jsonl`（含 `agree` 字段），正常回复链路完全不变。
- 一周后用 `summarizeDispositions()` 出数：`fastAccept`（本来会接多少单）、`actualAccept`（现网接了多少）、`mismatch`（错判多少）、`byRule`（按规则分布）。
- 开关：`config.triggerShadow === false` 关闭；落盘异常一律吞掉，不影响回复。
- 先留在 qq-adapter 内部，稳定后再抽独立包 `dsh-trigger`（守住「一次只加一个必装插件」）。

## 变更记录


- 2026-11-04 · 新增 Trigger 影子模式（阶段 1.2）：`lib/trigger.js` 产出统一 Trigger + 纯函数 fast path，fast 与现网 `shouldAnswer` 结论一起落 `~/.dsh/dafeiyu/trigger-shadow.jsonl`（含 agree），只记不执行；`summarizeDispositions()` 供一周后出数；`tests/trigger.test.mjs` 6/6。



- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · tools 晚就绪的重试逻辑并入 `dsh-plugin-kit/wait-for-tools` 的 `toolsOrRetry()`。
- 2026-11-03 · `lifecycle` 与 `atomicWrite` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js`、`lib/atomic-write.js` 副本。
- 2026-11-03 · 执行层补 unknown 对账入口（0.3.8）：新增 `qq(action=reconcile)`——不带 id 列出待对账记录（目标、文本摘要、尝试次数、最后错误），带 `id`+`decision=sent|not-sent` 人工裁定；`exec-store` 新增 `listByStatus` / `resolve`，只接受 unknown 记录（拒绝改写自动流转中的状态），裁定即闭合 attempts 并计入 execDone/execFailed；同步等待改为 8 秒 deadline（队列积压时不再误报 queued）。
- 2026-11-02 · 客户端存图继续加固（0.3.7）：块结构识别扩到 `attachment / attachmentId / id / value.* / data URL / 本机路径 / base64`；新增附件目录 `fs.watch`（不依赖块结构）；`sticker(save)` 无参时兜底取「最近两小时上传的附件图」；认不出结构时往 load.log 写一条「客户端图片结构未识别」，方便按真实字段修。

- 2026-11-02 · 图片库补两个缺口：①客户端拖进来的图之前根本进不了库（`llm/stream` 里只有 attachment id），新增 `lib/client-image-library.js` 在请求前按 attachment id 读出图片入库，所以拖图后说「存这个」能生效；`sticker(action=save)` 也支持 `path` / `attachment` / `id` 三种来源。②存图权限归主人：手动「存这个」只在主人私聊生效；自动收藏不限来源（AI 判断值得就收，`imageLibrary.autoSave` 可关）。

- 2026-11-02 · 新增图片/表情包/GIF 库：QQ 收到的图按 sha256 去重落库（recent / saved 两档，动图原样保存）；看图回复后由本地 qwen3:4b 判断是否值得收藏，主人私聊说「存这个 / 别存了」可手动改档；新增 `sticker` 工具（list/search/save/forget/path/stats），`vision_describe` 看图时同样入库；同一张图视觉只下载一次。新增 `imageLibrary` 配置块。改完需重启 DSH 生效。

- 2026-11-02 · 公开渠道认人：群聊与陌生人私聊不再完全不查记忆，改为只检索 `visibility=public` 的公开档（关系、称呼、公开形象）；owner 私聊仍是全量。prompt 标签按作用域区分（`长期记忆` / `公开记忆`）。改完需重启 DSH 生效。

- 2026-11-02 · autostart 简化：删除 NapCat 拉起逻辑（`ensureNapCat` 移除），改为 `probeBridge` 只探测 QQ 桥（SnowLuma，3001）端口；拉起只剩微心跳。断连重连不再尝试拉起桥；`config.json` 的 `autostart` 段删除。改完需重启 DSH 生效。

- 2026-11-02 · 日志与文案修缮：运行时输出不再写「NapCat」，改用中性「QQ 桥 / OneBot 桥」（当前实际桥是 SnowLuma），避免排查时误判；同步改 index.js / lib/autostart.js / lib/onebot.js / README / package.json / capability.json 的说明文字。改完需重启 DSH 生效。

- 2026-11-02 · 群触发放宽：`requireAtInGroup` 由 `true` 改 `false`，不 @ 的群消息也进 policy 判定；`microDecideGroup` 保持 `true`，`policy.mode=shadow` 仍只记录不发（要真发须单独切 live）。改完需重启 DSH 生效。

- 2026-11-02 · `say` 与 Ollama 交替显存：合成前先把 Ollama 里的模型卸载（`keep_alive=0`），结束后按 `keepAlive`（默认 30m）加载回去；配置 `tts.ollama`（enabled/url/model/keepAlive/unloadWaitMs）。实测释放 3GB 后 gsv 2.4s 出音频，恢复后 `qwen3:4b` 回到 3GB。代价：语音与本地模型对话同时用时，对话会短暂卡顿 3-5s。
- 2026-11-02 · `say` 默认 `scene=daily`（网关链 cache→gsv→edge→sapi），gsv（GPT-SoVITS v2ProPlus，飞鱼参考音色）在线时走克隆音色；实测 gsv 首条 4.1s、缓存命中 1.3s；gsv 不可用时退 edge 再退 SAPI。注意：Ollama 常驻占显存（~3GB）时 gsv 会超时退 edge，跑语音前先卸载 Ollama 或调短 keep_alive。
- 2026-11-02 · `say` 改为优先走本机 SSVO 语音网关（`lib/tts.js`，POST /say → 轮询 /jobs → 取 wav），失败自动回退 SAPI；新增 `tts` 配置块（url/scene/deadlineMs/timeoutMs/pollMs/apiKey/fallbackToSapi），detail 标明实际通道。网关实测 edge 引擎 6.5s / 622KB / 48kHz，SAPI 保留为兜底。
- 2026-11-02 · `say` 合成的临时 wav 发送后即删（`finally` 清理，文件名带随机后缀防同毫秒撞名）；`voice` 与 `say` 同时给时以 `voice` 为准，并在 detail 里提示。
- 2026-11-02 · `qq(action=send)` 支持图片/语音/文件：图片与语音合成 OneBot 消息段数组（`image` / `record`），文件走 `upload_private_file` / `upload_group_file`；实测 SnowLuma 会把 wav 自动转 SILK（`[Highway.Ptt] converted record to silk`），插件不做编码。
- 2026-11-01 · 工具合并：`qq_status` / `qq_send` 合并为单入口 `qq(action=status|send)`；旧名不再注册。
- 2026-11-03 · 配置脱敏：真实 `ownerId` / `groups` 移到 `~/.dsh/dafeiyu/qq.json`，仓库只留 `config.example.json`；加载顺序 example → config.json（旧版遗留）→ qq.json（本地覆盖，嵌套深合并）。`package.json` 的 `files` 不再打包 `config.json`。同时 `lib/group-policy-store.js` 改原子写（tmp+fsync+rename）。
- 2026-11-03 · `vision_describe` 加路径白名单（`lib/vision-path.js`）：只读 `~/.dsh` 附件/图片库、临时目录与 `vision.allowedRoots` 下的真实图片（按文件头认类型，改名 .png 的文本也拒）；传 `C:\Windows\win.ini` 被拒。新增测试 `vision-path.test.mjs`。
- 2026-11-04 · 四表补齐（inbox / work / effects / attempts，见执行层章节）；`lib/vision.js` 同步 vision 的认证修复（apiKey 优先、`reasoning_content` 兜底）。
- 2026-11-04 · `vision_describe` 迁到 `dsh-vision`（看图是感知层，不该由渠道提供），qq 不再注册该工具；本插件改为把图片库以 `imageLibrary` 服务暴露（`current` + `remember`），`vision_describe` 看图后仍会入库。`lib/vision-path.js` 与 `vision-path.test.mjs` 一起搬过去。改完需重启 DSH 生效。
- 2026-11-04 · 发送层抽出（阶段 2.1 拆 qq）：`qq(action=send)` 的实现从 `index.js` 移到 `lib/send-action.js`（`runSendAction`，HTTP 与 TTS 可注入）；TTS 合成从 index 移到 `lib/tts.js`（`synthesizeSpeech` / `synthesizeWithSapi`）。入口 1692 → 1588 行。行为不变：纯文字仍走执行层、`voice` 优先于 `say`、失败只报不重发。新增 `tests/send-action.test.mjs`（11 项）。
- 2026-11-04 · 主链路抽出（阶段 2.1 完成）：`handleEvent` / `processFrame` / `onFrame` / `onRequest` / `scheduleReconnect` 与全部上下文辅助函数（记忆/知识/图片/策略/对话）从 `index.js` 移到 `lib/pipeline.js`；index 只留配置、apply、连接与工具注册，入口 **1340 → 569 行**。对外导出 `handleEvent` / `memoryAllowed` / `memoryVisibility` / `onFrame` 的名字与签名不变（index 继续 re-export，`reliability.test.mjs` 仍从 index 取 `onFrame`）。`lifecycle` 工具数仍是 qq=2。改完需重启 DSH 生效。
- 2026-11-04 · 订阅直通影子（阶段 2.2 第一步）：新增 `lib/subscribe-shadow.js` 与 `config.subscribeShadow`（默认关）。开启后非 @ 群消息在交给微心跳时写一行按天 JSONL（groupId / threadKey / chars / estTokens / queued），用于估算改工单卡片后的 token 收益；关闭时零副作用，**不改任何回复与发送行为**。新增 `tests/subscribe-shadow.test.mjs`（7 项）。
- 2026-11-04 · 工具面抽出（阶段 2.1 拆 qq）：`qq` / `sticker` 两个工具的定义与 execute 从 `index.js` 移到 `lib/tools.js`，导出 `registerQqTools({ ctx, st, config, runtime, note })`；index 只留一行调用。工具名、参数、返回文案全部不变；`toolsOrRetry` 与 `st.toolsRegistry` 幂等逻辑一起搬过去。入口 1588 → 1340 行。改完需重启 DSH 生效。
- 2026-11-04 · 进程与状态归一（阶段 2.4）：`lib/autostart.js` 的 `portOpen` / `pidAlive` 改为 `dsh-plugin-kit/process` 的薄包装，不再自带 socket / 进程探测实现；`probeBridge` / `ensureMindLoop` 签名与返回不变，SnowLuma 仍只探测不拉起。
- 2026-11-04 · 修复 2.1 拆分遗漏（重启实测暴露）：`pushHistory` 与 `connect` 补进 `lib/pipeline.js`，`visionService` / `autostartService` 补回 `index.js`。漏搬时 apply 直接抛 `autostartService is not defined`，整个 QQ 适配器起不来（load.log 有据）；`connect` 从 index 移入 pipeline，解掉 `scheduleReconnect` 的反向 import。新增 `tests/static-refs.test.mjs`：扫 index.js / lib/pipeline.js 的未定义调用，防止同类遗漏再犯（单测全绿也抓不到这类运行时才炸的问题）。

- 2026-11-04 · 表达保真（阶段 4.1–4.4）：`cleanLong`/`cleanReply` 不再删代码块、不再压换行（超限按行截断）；`stripMeta` 改为协议级（只删明确 meta 标记，不按词删整句）；新增 `lib/render.js`（`splitForChannel` 拆条/转文件信号）；`exec-store` 加 `artifacts` 表与 `work` 的 checkpoint/evidence_refs；`planReplyPrompt` 增加 activity 动态段。新增 `format-fidelity` / `render` / `exec-artifact` 测试。
- 2026-11-05 · 路由改走 `decideRouteAsync`（带 local-triage 分诊，灰度 flag `route.tier` 默认关）：`lib/pipeline.js` 一处调用改成 `await`，老版本 brain 没有该函数时退回同步 `decideRoute`；传 `conversation: hkey` 给灰度分桶。默认行为与之前一致。
- 2026-11-05 · 复核使用说明：工具表（`qq` / `sticker`）、配置项、执行层与 Trigger 影子模式章节与当前实现一致，无内容修正；补这条核对记录。
- 2026-11-05 · `lib/autostart.js` 同步 bsk daemon（BrowserSkill，52800）自愈：探测端口，没在跑就以 `--foreground` 拉起（不 detached、不 unref，随宿主生命周期）；qq 优先用 `autostart` 服务，拿不到时用这份回退。11-02 条目里的「拉起只剩微心跳」据此扩成「微心跳 + bsk daemon」。
