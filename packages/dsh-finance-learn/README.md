# dsh-finance-learn

金融分析 + 经济与社会知识学习。一个插件、一个底座：**采集层**（行情/K线/指数/宏观）+ **知识层**（概念卡 + 间隔重复）。

> 只做数据呈现与教学解释。不推荐个股、不预测点位、不给买卖时点。任何金融输出都带「数据仅供参考，不构成投资建议」。

## 为什么是这两个功能放一起

概念卡最有价值的写法是「用真实数据举例」（CPI 三个月走势 → 通胀 → 实际利率 → 购买力）。数据采集和知识管理拆成两个插件，这件事就做不到了。

## 工具

| 工具 | 作用 |
|---|---|
| `fin_quote` | 实时行情，A股/港股/美股，一次最多 20 只 |
| `fin_kline` | 日/周/月 K 线，最多 240 根 |
| `fin_index` | 大盘指数快照（默认上证/深成/恒生/纳指） |
| `learn_card` | 概念卡增删改查搜 |
| `learn_review` | 到期队列 / 打分（1-4）/ 统计 |

P1 计划补 `fin_macro`（世界银行）、`learn_quiz`（自测）、FSRS-6。

## 数据源

| 数据 | 通道 | 状态 |
|---|---|---|
| 行情 / K线 / 指数 | `qt.gtimg.cn`、`web.ifzq.gtimg.cn` | 插件进程可直连 ✅ |
| 宏观年频 | `api.worldbank.org` | 可直连 ✅ |
| 东财 push2 | — | **不可用**：插件进程 `socket hang up`（TLS 指纹被风控），仅宿主 web_fetch 通道能过 |

腾讯行情的坑：字段是 160 个 `~` 分隔、全无文档，且美股比 A股/港股在五档区少一个字段（整段左移 1，时间在 29 而不是 30）。字段索引已用 fixture 锁死，见 `tests/fixtures/` 与 `QUOTE_INDEX`。

## 存储

`~/.dsh/dafeiyu/finance-learn/learn.db`（SQLite + FTS5），与 `dsh-group-knowledge` 的群知识库**分开**：群知识是「别人说过什么」，学习卡是「我要记住什么」。

表：`cards` / `card_links` / `reviews` / `review_log` / `cache`，外加 `cards_fts`。

## 复习算法

P0 是 SM-2：评分 1-4 折算成 0-5 质量分，通过（≥3）时才升 EF；失败重置间隔但不降 EF（降 EF 会让错过的卡永远排在后面）。

- Good 连续四次的间隔：1 → 6 → 15 → 38 天
- EF 钳制在 1.3 ~ 3.0

P1 换 FSRS-6（`ts-fsrs`）。

## 跑测试

本机没有 node 在 PATH，用 Electron 的 node 模式跑：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DSH 安装目录>\DeepSeek Harness.exe' '<工作区>\dsh-plugins\dsh-finance-learn\tests\run-all.mjs'
```

结果同时写到 `<系统临时目录>/finance-learn-test.json`（stdout 会丢）。

实网冒烟：

```powershell
& '<DSH 安装目录>\DeepSeek Harness.exe' '<工作区>\dsh-plugins\dsh-finance-learn\tests\live.mjs'
```

## 配置

`config.json`：

```json
{ "enabled": true, "dbFile": "", "dueLimit": 30 }
```

`dbFile` 留空用默认路径。

## 边界

- 不接券商、不下单、不登录账户
- 不做定时推送（提醒交给用户主动触发）
- 行情可能延迟或休市；宏观数据是世界银行年频，滞后约一年，输出必须带数据截止年

## 变更记录


- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
