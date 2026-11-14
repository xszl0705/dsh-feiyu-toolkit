# dsh-evidence

## 当前发布：0.12.0（2026-11-12）

根层单路同步注册五个工具；按每步当前预设准入。research 预设不重复加载 evidence 子行。配置读取包内 config.json。原文读取与规则判决保持原有实现。

与 step-saver 0.1.4 配套：research 只允许五个 ev 工具与 web_search/web_fetch，工具清单不是 persona 文案。诊断为 required 的只读 context，即使 includeRuntimeContext=false 也记录装配结果；不在诊断中补注册。日志位于 dataDir/mode-diagnostic.log。

变更原因：step-saver 原白名单删除 ev 工具；旧探针被上下文开关跳过。正确调用注销函数，取消四路注册与 keeper 推断。完成状态必须通过重启后的实际会话验收。

以下旧版本记录仅供历史参考；与本节矛盾时以本节和当前代码为准。


> 版本 0.7.0（独立研学模式：agent preset `research`，证据工具不挂标准模式）

信息采集与事实核验。目标不是「搜到答案」，是**攒出可复核的证据链**。

## 当前状态

| 层 | 状态 |
|---|---|
| `lib/db.js`（DDL / 迁移 / 中文切分） | **完成**，11 条测试 |
| `lib/decode.js`（解码 + 内容质量判定） | **完成**，21 条测试 |
| `lib/header-policy.js`（按域 header 表） | **完成**，随 channel 一起测 |
| `lib/channel.js`（降级链 + 冷却 + 预算） | **完成**，19 条测试；实网三站通过 |
| `lib/parse.js`（article / table / json 抽取 + span） | **完成**，34 条测试 |
| `lib/artifact.js`（两阶段落盘 + sha256 去重） | **完成**，25 条测试 |
| `lib/claim.js`（原子分解 + numeric 口径 + 落库） | **完成**，60 条测试 |
| `lib/numeric.js`（四级复算 + 量纲检测） | **完成**，45 条测试 |
| `lib/verdict.js`（判决 v1 + 落库 / current 切换） | **完成**，65 条测试 |
| `lib/invariants.js`（I2/I3/I4/I8/I10/I13/I17/I18 + I16 读侧） | **完成**，随 verdict 一起测 |
| `lib/search.js`（检索薄封装 + 同源归并 + 来源分级） | **完成**，42 条测试 |
| `lib/verify.js`（`ev_verify` 编排：检索 → 抓取 → 比对 → 判决 → 落库） | **完成**，42 条测试 |
| `lib/preset-scope.js`（preset 准入：`when` 条件 + `agentPresets` 权威读取） | **完成**，17 条测试 |
| `lib/tools.js`（五个工具定义） | **完成**，42 条测试 |
| `tests/cases/chain.test.mjs`（文本 → 原子 → 复算 → 判决 → 落库） | **完成**，13 条测试 |
| `ev_trace` / `ev_probe`（工具） | 未实现 |

测试合计 **448/448**（2026-11-12）。

## 工具 · 已注册的工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `ev_fetch` | `url`（必填）、`expect`、`as_of`、`deadline_ms` | 单 URL 抓取：通道降级链 → 原文落 `artifacts/*.raw` → 索引进 `evidence.db` |
| `ev_extract` | `artifactId`（必填）、`target`、`maxChars` | 对已有 artifact 抽正文 / 表格 / JSON，返回可切片 `spans` |
| `ev_claim` | `text`（必填）、`as_of` | 声明拆原子：带 span 的 numeric / fact / date / entity_relation / quote；观点类进 `outOfScope` |
| `ev_search` | `query`（必填）、`limit` | 检索 + 同源归并：返回按「同一篇稿」合并的簇与 coverage；UGC 只作线索 |
| `ev_verify` | `claim`（必填）、`depth`、`as_of`、`sources?` | 一条声明走完整核验：拆原子 → 检索 → 每簇抓最优成员 → 数字/文本比对 → 规则判决 → 落库 |

**`ev_verify` 返回**：`{ status, claimId, verdictId, inserted, asOf, depth, verdict, confidence, basis, rulesVersion, producer, atomCount, evidenceCount, evidence, leads, gaps, degraded, coverage, clusters, queries }`。

### 关键行为

- **两阶段落盘**：先写 `artifacts/YYYY-MM/<id>.raw` 再插 DB；文件失败就不插库。
- **sha256 去重**：同字节只落一次，第二次返回既有 `artifactId` 且 `dedup=true`。
- **抽取不做 DOM**：正则 + 行状态机；`script/head/nav/footer/aside` 与短行按噪声剔除。
- **原子分解是规则不是理解**：一句三数字 → 三 numeric atom；日期成分不拆；纯日期句只出一个 `date` atom。
- **口径不猜**：比率/增速（`%` / `个百分点` / `pp`）的 `basis` 一律留空并进 `unverified`。
- **同源归并只看内容**：标题归一键相同，或「标题+摘要」3-gram shingle 相似度 ≥ 0.6 → 同一簇；簇等级取成员最高。
- **UGC 只作线索**：雪球 / 股吧 / 微博 / 知乎 / 公众号 → 等级 `E`、`leadOnly: true`，进 `leads` 不进 `evidence`。
- **每簇只认一条最优成员**：同一篇稿转载到三家只算一个独立源，避免独立性虚高。
- **数字冲突先看原文命中**：页面里有同样的数字串就算支持；没命中才在同一 `basis`（或同一 `period`）下比，否则同页多个金额会互相误判成冲突。
- **抓取失败不冒充反向证据**：进 `gaps`（`FETCH_FAILED:<url>`），判决只能弃权。
- **覆盖度不吹**：`coverage.saturation` 在 P0 恒为 `unknown`，只报实际统计到的数。

## 研学模式（独立 agent preset，不挂标准模式）

`cordis.patch.yml` 只做一件事：声明一个 agent preset **`research`（研学模式）**，并把本包挂成它的子行。

```yaml
- id: dsh-evidence      # 关掉 profile 根层的插件行
  disabled: true
- insert:
    - id: preset-research
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: research
        plugins: [persona, tool-web, evidence, compaction]
```

为什么要两层（0.8.0 实测修正）：

| 方式 | 结果 |
|---|---|
| 只当普通插件挂进 profile | 五个 `ev_*` 工具进 global 层，**标准模式也能看见** |
| 只靠 `disabled: true` + preset 子行（0.7.0 做法） | **不够**：preset 子行里 `ctx.get('tools')` 会解析到根实例（实测日志 `sources=ctx.get+ctx.root.tools+ctx.root.get targets=3`），注册照样落 global，标准模式仍有 `ev_*` |
| preset 子行 + `when` 准入（0.8.0 做法） | preset 提供人设、`tool-web` 与本包实例；`when` 在装配每一步按当前会话 preset 过滤，标准模式看不见 `ev_*` |

模式里的工具面：`ev_fetch` / `ev_extract` / `ev_claim` / `ev_search` / `ev_verify` + 宿主 `web_search` / `web_fetch`。**没有终端、没有文件、没有代码工具。**

人设要点（完整文本在 `cordis.patch.yml`）：先 `ev_claim` 拆原子 → 用 `web_search` 找 2–3 条检索式 → 把 URL 交给 `ev_verify(sources=[…])` → 按判词与缺口回答；不许拿 UGC 当证据、不许在 `UNVERIFIED_*` 时说「基本属实」、不许编 URL。

### 装载步骤（装配是开关，归用户）

1. 备份三件套：`package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`
2. 先进**试验区** `~/.dsh/profiles/verifyx`（3080）装 `dsh-evidence`，重启
3. 验收三点：
   - 插件列表里 `preset-research` 在位，`research` 模式在模式选择器里可选
   - 新建一个 `research` 会话：工具面里有 5 个 `ev_*`，**没有**终端/文件工具
   - 新建一个标准会话：工具面里**没有** `ev_*`
4. 日志看 `[dsh-evidence] 工具已注册：… · source=…`：`source=ctx.tools` 才是落在 preset 层；若显示 `ctx.get` 且标准模式也出现了工具，就是漏到了 global
5. 试验区通过再进本体

**已实测（2026-11-12 19:53 / 20:39，verifyx）**：preset 子行里 `ctx.get('tools')` 确实解析到根实例——启动日志 `sources=ctx.get+ctx.root.tools+ctx.root.get targets=3`，注册拦不住。这就是 0.8.0 改用 `when` 的直接原因。0.8.0 装载后日志应为 `registered: … gate=research/hide`，以及首次调用时 `[gate] preset=<id> allow=research → show|hide`。

## 判决与不变量（P0 规则版）

`lib/verdict.js` 是**唯一**的 verdict 写入口，`producer` 只能是 `js_rule`。

判决链（`judgeV1`，顺序固定）：

1. `degraded && gaps.length === 0` → 抛 `INVARIANT_VIOLATION`（故障不许伪装成结论）
2. 数字口径冲突（`numericConflict` / `numericVerdict='ERROR'`）→ `CONFLICTING`
3. 有反向信号且存在 L1–L3 证据 → `REFUTED`
4. 独立簇 ≥ 2 且复检通过且有 L1–L3 → `SUPPORTED`
5. 独立簇 = 1 且有 L1–L3 → `SUPPORTED_WEAK`
6. 否则按 coverage 弃权：`SATURATED` → `UNVERIFIED_SATURATED`；检索不足 → `UNVERIFIED_INSUFFICIENT_SEARCH`；有证据但不辨正反 → `ABSTAINED_LOW_DISCRIMINATION`

置信度可复算（I8）：

```
P     = 一致簇 / 总簇 → ≥0.8 取 0.8；≤0.3 取 0.2；其余 0.5
indep = min(簇数, 3) / 3
level = A1.0 B0.7 C0.5 D0.3 E0.15（取最高）
fresh = 30d:1.0 / 180d:0.8 / 1y:0.6 / 更早:0.4（无证据 0.4）
cap   = 独立源<2 → 0.6；无 L1–L3 → 0.5（取更严）
conf  = round4(min(cap, 0.5P + 0.15·indep + 0.2·level + 0.15·fresh))
```

落库：同 `idem_key` 只比内容（不一致抛 I11），否则把旧 current 标 `superseded_by` 再插新行；`(claim_id, rules_version)` 的 current 唯一性由 **DB 唯一索引**兜底（I16）。

## 数据位置

`dataDir` 默认 `~/.dsh/dafeiyu/evidence/`，可在 `config.json` 改到工作区。

```
<dataDir>/evidence/
  artifacts/YYYY-MM/    原文（不可变，sha256 命名）
  parsed/YYYY-MM/       解析结果 JSON
  traces/YYYY-MM/       每次通道尝试
  evidence.db           索引（真相在文件，DB 可重建；claims / claim_atoms / verdicts 也在这里）
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件开关 |
| `dataDir` | `""`（即 `~/.dsh/dafeiyu/evidence`） | 数据根目录 |
| `channelOrder` | `["host_fetch","node_direct"]` | 通道尝试顺序 |
| `budget.deadlineMs` | `15000` | 单次抓取总预算 |
| `budget.maxPages` | `6` | `ev_verify` deep 模式的簇上限参考值 |
| `textRawLimitBytes` | `2097152` | 原文落盘上限（2MB） |
| `extractChars` | `8000` | `ev_extract` / `ev_verify` 回给模型的正文上限 |
| `toolGate.presets` | `["research"]` | 允许看到 `ev_*` 的 agent preset id 列表；空数组 = 不设限（等于 0.7.0 行为） |
| `toolGate.onUnknown` | `"hide"` | 判不出当前会话 preset 时怎么办：`hide`（不暴露）或 `show`（fail-open） |

检索后端不在 config 里：由 `index.js` 按 `webSearch` / `search` 服务名鸭子类型解析，解析不到就是 `SEARCH_UNAVAILABLE`。

## 跑测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' `
  -Out '<workspace>\_tmp\evidence-run.txt' `
  '<workspace>\dsh-plugins\dsh-evidence\tests\run-all.mjs'
```

结果同时落 `_tmp/evidence-test.json`，末尾输出 `ALL_OK` / `HAS_FAILURE`。

**注意**：不要用 PowerShell 的 `ConvertFrom-Json` 去读结果文件——它会按 GBK 解 UTF-8 中文导致解析失败。

## 已由测试锁定的设计约束

| 约束 | 测试断言 |
|---|---|
| 中文必须双列 / 同一 `segmentCJK` | `text_seg` 上 `LIKE '%茅台%'` 命中 0，`text_raw` 命中 1 |
| sha256 不可重复 / 声明错也能解对 | 同字节 `dedup=true`；GBK 字节 + 错误声明 → 回退 gb18030 零替换字符 |
| 通道：403 重试一次 / 冷却 / 预算 / 登录墙 | 见 channel 19 条 |
| 抽取：噪声剔除 / 表格缺陷 / 坏 JSON / 截断 | 见 parse 34 条 |
| 原子：三数字三 atom / 日期不拆 / 缺 unit 进 unverified | 见 claim 60 条 |
| 复算：容差按刻度 / 四级阈值 / 量纲单列 | 见 numeric 45 条 |
| 判决：链顺序 / conf 可复算 / degraded 不许无 gaps | 见 verdict 65 条 |
| 归并：跨域名同稿 1 簇 / 簇等级取最高 / UGC leadOnly | 见 search 42 条 |
| **两簇支持 → SUPPORTED** | `evidenceCount=2`、`stance=support`、不变量零违规 |
| **一页冲突 → CONFLICTING** | `numericVerdict=ERROR` 且该簇 `stance=refute` |
| **只有 UGC → 只进 leads** | `evidenceCount=0`、`gaps` 含 `NO_NON_LEAD_CLUSTERS`、弃权 |
| **无检索后端 → degraded + 弃权** | `gaps` 含 `SEARCH_UNAVAILABLE`，不触发 `INVARIANT_VIOLATION` |
| **抓取失败 → 记 gaps 不冒充反向证据** | 两簇各一条 `FETCH_FAILED`，判决弃权 |
| **deep 检索式** | 含 `site:gov.cn`，且条数多于 quick |
| **工具层幂等** | 同 claim 二次核验 `inserted=false`，`verdicts` 仍 1 行 |

## 实网冒烟（不在 CI 必过项内）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' `
  -Out '<workspace>\_tmp\evidence-live-tools.txt' `
  '<workspace>\dsh-plugins\dsh-evidence\tests\live-tools.mjs'
```

2026-11-12 实测：`ev_fetch → ev_extract → ev_claim` 两站 `LIVE_ALL_OK`（东财 utf-8 56951B/13 表/17 atoms；腾讯 gbk 544B/22 atoms）。
`ev_verify` 尚未实网跑：本机没有检索后端，按设计会返回 `degraded + SEARCH_UNAVAILABLE`。

## 已知限制

- **P0 只有三态**：`coverage.saturation` 恒为 `unknown`，`UNVERIFIED_SATURATED` 不可达（P1）。
- **检索后端未在本机验证**：`ev_search` / `ev_verify` 依赖宿主是否暴露 `webSearch` / `search`；解析不到时一律 `SEARCH_UNAVAILABLE`。
- **`sources` 参数只回显**：P0 不按 `sources` 强制抓取。
- **每簇只取一条最优成员**（`quick` 1 条 / `deep` 仍是 1 条，深度体现在簇数与加官方站定向），同一稿的不同修改版不会分别取证。
- **`host_fetch` 通道未接入**：`index.js` 传 `hostFetch = null`，实抓走 `node_direct`。
- **`as_of` 只回填**：写进 `dataAsOf` / `claimId` / `idem_key`，不做时间过滤（I13 仅在 evidence 自带 `fetched_at` 时校验）。
- **`ev_extract` 截断即丢 span**；**`pdf` / `ocr` 未实现**；原子类型靠关键词判定，不做语义理解。
- **比率/增速的 `basis` 一律留空**（进 `unverified`），所以增速类主张容易被判「口径不明」。
- 不做 UGC 平台的证据（只作线索）；不承诺检索全面性；冲突不裁决，只标注双向证据。

## 变更记录

- 2026-11-12 · **0.8.2**：补齐 `output: { schema, render }` —— **这是 `ev_*` 从 0.6.0 起就没进过会话的真因**。宿主 `tools.register()` 第一件事校验 `definition.output.render` 是函数（`dsh-tools/lib/index.js:434-437`），五个定义都没有这个字段，于是每次注册都抛 TypeError；旧代码把异常吞进 `ctx.logger.warn`，日志照样打「registered」，看起来像成功。加了探针（回读 `tools.view(undefined).visible`）后才暴露：修前 `[probe] … ok=0/5 before=false after=false`，修后 `ok=5/5 before=false after=true`。另加 `ctx.get` 单路优先 + 3 秒后重绑 preset registry（实测 apply 时 `registry=no`、3 秒后 `registry=yes`）。
- 2026-11-12 · **0.8.1**：注册路径改成「`ctx.tools` 同步优先、轮询兜底」，并加注册探针与 `regfail` 明细日志；同时删掉 `cordis.patch.yml` 里 `preset-research` 下的 `evidence` 子行（preset 隔离域注册的工具进不了 agent 视角，`dsh-rp-mode/index.js:283-287` 同坑）。
- 2026-11-12 · **0.8.0**：工具面改成**准入制**——新增 `lib/preset-scope.js`，五个 `ev_*` 注册时带宿主支持的 `when`（per-step 准入条件），只有 `toolGate.presets`（默认 `["research"]`）里的 agent preset 每一步能看到它们。preset id 的读取链按 `agentPresets.presetForSession(agent.session)` → 会话快照 `projectionValues.agentPreset` → agent 旧字段，全落空时按 `onUnknown`（默认 `hide`）处理；`when` 内全 try/catch，绝不把异常抛成 `ToolActivationError`。测试 448/448。
- 2026-11-12 · **0.7.0**：改成**独立研学模式**——`cordis.patch.yml` 声明 agent preset `research`（人设 + tool-web + 本包 + 压缩），并 `disabled: true` 关掉 profile 根层插件行，`ev_*` 工具只在这个模式可见；`ev_verify` 的 `sources` 参数从「只回显」变成**真用**（给了 URL 就不再检索，研学模式主路径）；同源归并补一条规则——没有标题也没有摘要的候选按 URL 各自成簇（否则相似 URL 会被内容相似度并成一簇）。`index.js` 改优先 `ctx.tools` 并打 `source=`。测试 431/431。
- 2026-11-12 · **0.6.0**：新增 `lib/verify.js` 与 `ev_verify`（检索 → 抓取 → 比对 → 判决 → 落库全链路），工具面 5 个；修两处真问题——同页多个金额互相误判冲突（改成先看原文命中，再按 `basis`/`period` 限定可比数字）、`canonicalJson` 把 `undefined` 写成 `null` 导致 I18 误报。测试 419/419。
- 2026-11-12 · **0.5.0**：新增 `lib/search.js`（同源归并 + A–E 分级 + UGC leadOnly）与 `ev_search`。测试 377/377。
- 2026-11-12 · **0.4.0**：新增 `numeric` / `verdict` / `invariants` + `chain`；修 `absTol` 量纲 bug。测试 335/335。
- 2026-11-12 · **0.3.0**：新增 `lib/claim.js` 与 `ev_claim`。测试 212/212。
- 2026-11-12 · **0.2.0**：新增 `parse` / `artifact` / `tools`，注册 `ev_fetch` / `ev_extract`。测试 152/152。
- 2026-11-11 · 0.1.1：`decode` / `header-policy` / `channel`，51 条测试。
- 2026-11-11 · 0.1.0 骨架：`lib/db.js` + DDL + 11 条测试。
