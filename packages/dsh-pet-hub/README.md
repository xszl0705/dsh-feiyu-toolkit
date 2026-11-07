# dsh-pet-hub

把「心情挂件」「朗读桥卡片」「大肥鱼桌宠」合成**一张浮层卡片**。

**当前是第一步：只启用宿主半端（HTTP 端点）。** 客户端浮层（`client.js`）暂不声明 `dsh.client`，
等页面加载通道验证通过再开 —— 昨晚正是这一步没验就重启，导致插件首载抛错。

## 端点

| 路径 | 说明 |
|---|---|
| `GET /dsh-pet-hub/status` | 桌宠状态 + 心情值（读 `~/.dsh/feiyu-mood/state.json`） |
| `POST /dsh-pet-hub/pet` | `{"action":"start\|stop\|form","form":"pet\|widget"}` |
| `GET /dsh-pet-hub/client.js` | 浮层脚本源码（方便手工注入/调试） |

## 已修掉的三处致命问题

1. 缺 `export const inject = ['webServer']` → `cannot get property "webServer" without inject`
2. `ctx.logger?.('info')?.(...)` 调用签名错（logger 是对象）→ 统一 `safeLog`
3. `apply()` 抛错会冒到宿主 → 外层 try/catch，异常落到同目录 `hub-error.log`

## 配置

```json
{ "petDir": "", "pythonw": "" }
```

留空按 `dsh-pet-sync` 的规则解析（`<dsh-plugins>/_pets/deepseek-dafeiyu-pet`）。

## 第二步（未做）

`client.js` 现在是一个普通 IIFE。要挂进页面，需要确认 DSH 桌面端的注入通道：
- 要么按 `dsh.client` 的模块约定改写成 `window.__ModuleLoader__.load({...})`
- 要么照朗读桥的做法走 webserver 的 `index-inject` 表（`script-src` 行）

两条都得先在页面上试通，再写进 `package.json`。

## 使用说明

**什么时候用**

- 桌宠 UI 需要状态 → `GET /dsh-pet-hub/status`
- 前端要客户端脚本 → `GET /dsh-pet-hub/client.js`
- 桌宠说话写留痕 → `POST /dsh-pet-hub/line`

**接口**

| 路由 | 作用 |
|---|---|
| `/dsh-pet-hub/status` | 桌宠状态 JSON |
| `/dsh-pet-hub/pet` | 宠物资源 |
| `/dsh-pet-hub/client.js` | 客户端注入脚本 |

**什么时候别用**

- 只监听本机，别暴露到公网
- 不提供任意文件读取，别加这种口子
- 它和 `pet-sync` 各有一份 `pet.js`，改一个必须同步另一个（有测试盯着）

## 鉴权与限流（2026-11-01）

- **带 `Origin` 的请求一律 403**：本地脚本和桌宠都不带 Origin。浏览器里随便一个页面发 `text/plain` POST 也就够不着路由了（免预检 CSRF）。
- **写接口要令牌**：`/dsh-pet-hub/pet`、`/dsh-pet-hub/line` 必须带 `x-pet-token`，值来自 `~/.dsh/pet/hub-token`（首次启动自动生成）。缺了返回 401。
- **`/line` 限流**：每分钟最多 6 次；`maxTokens` 1024 → 300，候选 3 → 2。超了返回 429。
- `/dsh-pet-hub/status` 与 `/client.js` 仍可匿名 GET（只读、无副作用）。

> 改之前的问题：`/pet` 能直接起停桌宠、零鉴权、CORS 还开着 `*`——本机任意网页都能把桌宠关掉。

## `/line` 的 `{{memory}}` 填什么（2026-11-01）

气泡原先是「演」：提示词里只有场景、离开时长、心情值和「记忆库里有 N 条」，没有一条真实记忆，所以它能说漂亮话，却接不上你刚干完的活。

现在 `buildPrompt` 先 `readRecentWork()`：用与 `mind-loop/lib/memory-digest.mjs`、`dsh-pet-diary/lib/body-memory.js` **同一条工作区选择规则**（优先名字含「工作区/work」的目录，否则 mtime 最新；只读一个），拿当天 `<date>.md` 最后一条 `- HH:MM [kind:…] …` 的正文，截 50 字，填成 `你最近在忙：…`。core 模板里那句是「只当背景，不逐条复述、不报进度；对不上就只说眼前的事，别编」。

`status` 的 `memory` 条数也换了源：优先走 memory-unified 服务（SQLite 真值，实测 25 主题 / 57 条），`index.json` 只当兜底——那是旧 JSON 后端的遗留（3 主题 / 15 条），直接读它会报出低好几倍的数。

- 取不到（目录缺、当天没日志、读失败）→ 退回「记忆库里有 N 条」，出句不受影响
- 只读，不写、不加锁、不做检索

读取逻辑在 `lib/body-memory.js`（原来是 `index.js` 闭包里，没法被测试加载）。**它是 `dsh-pet-diary/lib/body-memory.js` 的同规则副本**——两个包要独立发行，跨包 import 发布后必断，所以各存一份；`dsh-plugins/tests/contracts.mjs` 会同时加载三处（含 mind-loop 的 `workspaceDir`）比对，改一处忘了另一处测试就红。

## 变更记录


- 2026-11-04 · `lib/pet.js` 移进 `dsh-plugin-kit/pet`（与 pet-sync 共用一份，方案 v3 · 2.4）；本包不再保留副本，导入改 `from 'dsh-plugin-kit/pet'`。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-03：`stopPet` 不再谎报成功——`taskkill` 后按 pid 复核，仍有存活进程时返回 `ok:false`（带 `alive` 列表）；`switchForm` 停不掉就直接报错，不再继续拉起新实例。
