# dsh-econ-news

> 版本 0.1.0 · 2026-11-14

经济新闻采集与简报。**只在研学模式（agent preset `research`）可见**。

每天登录后自动采集一次：IMF 世界经济展望、WSJ、FT、中美经济部门政策、经济学研究成果。
先把原文落盘，再由落盘的条目生成一篇可溯源的简报。拿不到的源写缺口，不编内容。

## 为什么这样设计

实测（2026-11-14，本机）决定了架构：

| 事实 | 后果 |
|---|---|
| IMF 主站 node 直连 **403**（Akamai），宿主 `web_fetch` **200** | 通道必须两层，IMF 走 `ctx.web` |
| IMF 报告页自带 `index.md` / `index.json` / `text.pdf.md` | 全文直接取 Markdown，不用解析 PDF |
| `api.db.nomics.world` 可直连且返回真实预测值 | IMF 站点彻底不可用时仍有数据层备案 |
| WSJ RSS 只有 80–165 字摘要，`wsj.com` 两通道都超时 | WSJ 段固定 `summary`，不追正文 |
| FT 全部 RSS + ftchinese 双通道全断 | 默认记缺口，配 `proxy`/`cookie` 才启用 |
| 人行 / 财政部 / 统计局 / 商务部 / gov.cn 可直连且正文可提 | 中国政策段能出全文 |
| Fed / BEA / USTR / NBER / arXiv / ECB 可直连 | 美国与学术段稳定 |

## 工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `econ_news_collect` | 采集：默认今天 + 全部源；也可只跑指定源或手工投喂链接 | `date` / `sources[]` / `force` / `urls[]` |
| `econ_news_brief` | 取某日简报（五分区 + 缺口 + 溯源） | `date` / `format=md\|json` |
| `econ_news_list` | 列某日条目（源/标题/区/正文状态/字数/id） | `date` / `zone` / `limit` |
| `econ_news_read` | 读某条原文，强制分页 | `id` / `offset` / `limit`（≤12000，默认 6000） |
| `econ_news_status` | 采集状态、源成败、通道、数据目录、源清单 | — |

工具全部带 `when: presetGate(['research'])`，判不出 preset 时**隐藏**（宁缺勿滥）。

## 配置（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉则插件不加载 |
| `dataDir` | `<workspace>/econ-news` | 存档根目录（只写工作区内） |
| `autoCollect` | true | 启动后自动采集 |
| `autoDelayMs` | 20000 | 启动后延迟多少毫秒再检查（不抢宿主启动） |
| `dailyBudgetMs` | 180000 | 单日采集预算，用完停止新请求并记 `skipped` |
| `concurrency` | 4 | 源级并发 |
| `maxArticlesPerSource` | 12 | 每源正文抓取上限 |
| `proxy` | `""` | HTTP 代理，`http://user:pass@host:port`；填了才走 CONNECT 隧道取 FT |
| `ftCookie` | `""` | FT 订阅 cookie（付费墙后正文） |
| `llmProvider` | `""` | 调 `ctx.web.fetch` 时带的模型路由 |
| `disabledSources` | `[]` | 临时关掉某几个源 id |

## 数据目录

```
<workspace>\econ-news\
  index.json           每日一行索引（留最近 60 天）
  state.json           调度状态（lastRunDate / lastResult / retryCount）
  <YYYY-MM-DD>\
    manifest.json      源级账本：成败 / 通道 / 耗时 / 缺口 / 预算跳过
    items.jsonl        每条一行（id / zone / bodyStatus / bodyChars / sha256 / 落盘路径）
    raw\<id>.html      原始响应
    text\<id>.md       提取后的正文
    brief.md           简报
    brief.sources.md   溯源表
```

`bodyStatus` 四态：`full`（抓到正文）/ `summary`（只有摘要）/ `withheld`（被墙被墙）/ `failed`（抓取或抽取失败）。

## 源清单（22 个）

| 区 | 源 | 类型 | 通道 |
|---|---|---|---|
| 全球展望 | `imf-weo` | imf-bundle | host_web |
| 全球展望 | `imf-dbnomics` | dbnomics | node |
| 媒体 | `wsj-world` / `wsj-markets` / `wsj-usbiz` / `wsj-opinion` / `wsj-tech` | rss | node |
| 媒体 | `ft-home` / `ft-world` | rss | proxy（默认不可达） |
| 媒体 | `wscn-global` | wscn | node（FT/WSJ 备案） |
| 美国 | `fed-press` / `fed-monetary` / `fed-speeches` / `bea` / `ustr` | rss | node |
| 中国 | `pboc` / `mof` / `stats` / `mofcom` / `gov-yaowen` | html-list | node |
| 学术 | `nber` / `arxiv-econ` / `ecb` | rss / atom | node |

通道链：`node_direct → host_web → proxy`，同域名+通道连续 3 次失败冷却 30 分钟。

## 每日调度

```
插件 apply → 20s 后 tick
  → state.lastRunDate === 今天 且 lastResult === ok → 跳过
  → 否则后台 runCollect（不向任何会话注入消息）
  → 失败 60s 重试一次；仍失败写 state.error，等手动 econ_news_collect 或下次启动
```

## 跑测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' `
  -Out '<workspace>\_tmp\econ-test.txt' '<workspace>\dsh-plugins\dsh-econ-news\tests\run-all.mjs'
```

11 个用例：RSS 解析 / 正文选择器与兜底 / 403 降级 / 冷却 / 存档去重 / 简报五分区 / 端到端采集 / 模式准入。

## 已知限制

- **FT 本机拿不到**：`ft.com` 与 `ftchinese.com` 的 node 直连与宿主通道全部 ECONNRESET/超时。要 FT 内容需配 `proxy` 或 `ftCookie`，否则 `manifest.gaps` 里会有一条。
- **WSJ 只有摘要**：`wsj.com` / `cn.wsj.com` / AMP 版都超时；RSS 无 `content:encoded`，只有 80–165 字描述。
- **IMF 依赖宿主凭据**：后台任务无会话时 `ctx.web` 可能没有 fetch provider，此时 IMF 段降级到 `imf-dbnomics` 并在缺口里写明。
- **商务部 / 中国政府网要闻默认关闭**：`/xwfb/rcxwfb/index.html` 只返回导航、`/yaowen/liebiao/` 只返回页脚，列表由脚本渲染，静态抓取拿不到文章链接。两个源在 `config.disabledSources` 里，P1 接它们的 JSON 接口后再打开。
- **统计局正文偶发抽空**：列表页 421 KB，部分页面正文在脚本里渲染；抽不到时保留 `raw/` 原件，状态记 `failed`。
- 不做投资建议、不预测点位；原文版权归各来源，只供个人研学。

## 变更记录

- 2026-11-14 · 0.1.0：首版。20 源启用（另 2 源因列表页脚本渲染默认关闭）/ 6 类 adapter / 三档通道 / 按日存档 / 规则版简报 / 每日调度 / 研学模式准入。单测 11/11。真实网络首跑：258 条（全文 33 / 摘要 225）、耗时 9s、缺口 1 条（IMF 无宿主通道时）；简报五分区来源分散，未出现单源占满一区。

