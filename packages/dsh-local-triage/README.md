# dsh-local-triage

本地小模型分诊 + 确定性压缩。两个能力可以分开用。

```
analyze(req)            → {tier: local|cheap|frontier, source, conf, why, ms}   永不抛
compressToolResult(...)  → 纯代码压缩工具输出，不花模型
```

## 使用说明

**什么时候用**：给宿主 / 路由层判断「这条请求该不该交给本地小模型」，以及「这段很长的工具输出怎么压」时用。它**不是模型直接调的工具**——没有注册工具，也没有「工具」一节，只能被其他插件 `import` 或用脚本调用。

**现在能不能用**：还不能。`config.json` 里 `enabled: false`，没进任何 profile（见文末「接入状态」）。当前只能离线跑测试和评测。

**怎么验证**：跑下面的单测与评测，看 `reports/` 里的混淆矩阵；接入前必须先在 `verifyx` 试验区过一遍。

## 为什么是这个形状

本机是 RTX 4060 Laptop 8GB + `qwen3:4b`（Q4_K_M 2.5GB）。三条硬约束决定了设计：

1. **4B 压缩质量不够** —— 让它压长上下文会静默丢路径/变量名/错误码。压缩交给纯代码。
2. **8GB 装不下长上下文** —— `num_ctx` 只敢开 1024~2048，所以本地模型吃的是"特征摘要"（≤600 token），不是全文。
3. **显存单飞** —— 同一时刻只能跑一个本地请求。

结论：**本地模型是分诊台，不是医生。** 判断给它，压缩给代码，生成给云端。

## 目录

```
lib/rules.mjs      L0 规则层（纯函数，不花 token）
lib/features.mjs   请求 → 特征摘要（≤600 token）
lib/ollama.mjs     Ollama 调用（think:false / 超时 / 熔断）
lib/router.mjs     三档融合（规则 → 本地 → fail-open）
lib/compress.mjs   确定性压缩（截断/投影/分页/落盘/报错裁剪/hunk）
lib/stats.mjs      JSONL 埋点
tools/eval-triage.mjs  离线评测，出混淆矩阵
tests/             rules / compress 单测 + 50 条回归集
```

## 关键参数

| 参数 | 值 | 为什么 |
|---|---|---|
| `think` | `false` | qwen3 默认带思考模式，会把预算全烧在思维链上 |
| `numCtx` | 1024 | 分类不需要长上下文，KV 小、prefill 快 |
| `numPredict` | 64 | JSON 输出约 20~40 token，留余量但不浪费 |
| `timeoutMs` | 1500 | 让用户多等 2 秒去省 2 分钱是亏的 |
| `confidence` | 0.75 | 低于阈值一律升到 frontier |
| 熔断 | 连续 3 次失败停 60s | 本地挂了不能拖慢主流程 |

## 跑测试

本机没有 node，用 Electron 当 node（stdout 会丢，结果看 `reports/`）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "E:\dsh\DeepSeek Harness.exe" dsh-plugins\dsh-local-triage\tests\rules.test.mjs
& "E:\dsh\DeepSeek Harness.exe" dsh-plugins\dsh-local-triage\tools\eval-triage.mjs --real   # 真实样本
& "E:\dsh\DeepSeek Harness.exe" dsh-plugins\dsh-local-triage\tools\eval-triage.mjs          # 构造样本
```

结果：`reports/rules.test.json`、`reports/triage-eval-real-latest.md`、`reports/triage-eval-synthetic-latest.md`。

## 实测结果（2026-10-31）

| 数据集 | 规则层 | 全链路 | false-local | frontier 下调 | 本地延迟 |
|---|---|---|---|---|---|
| 构造样本 50 条 | 45/50，100% | 96% | 0 | 0 | p50 494ms |
| **真实样本 100 条** | 54/100 | **90%** | **0** | **1/44（2.3%）** | p50 493ms |

真实样本采自 `~/.dsh/dafeiyu/dialogues/`，已剔除 checkpoint、定时提醒、子代理回执等**冒充用户的系统注入**。

**试过并证伪的方案**：把三分类改成二分类（只判"要不要主力模型"）。结果准确率降到 79%，过度升级从 6 条涨到 16 条，frontier 下调只从 13.6% 改善到 4.5%。收益不如直接补规则，已回退，`decisionStyle: 'binary'` 保留但默认不用。

## 验收红线

- **false-local 必须是 0**：复杂请求被判成 local，用户看到的是能力下降，不是省钱。
- 本地分类 p95 ≤ 1200ms。
- 本地不可用时，100% 的请求都能 fail-open 到 frontier。

## 接入状态

**已接入（2026-11-05）**：`dsh-feiyu-brain` 的 `decideRouteAsync()` 调本模块的 `analyze()`，QQ 渠道（`dsh-qq-adapter/lib/pipeline.js`）用它替代原来的同步 `decideRoute`。

**灰度默认 0%**：真正的开关在 `~/.dsh/dafeiyu/flags.json` 的 `route.tier`——
`enabled: true` + `variants.triage: 100` 才全量；只写 `control: 100` 等于没开。按会话 sticky 分桶，改文件即时生效、不用重启宿主。flag 缺席时 `decideRouteAsync` 原样走旧逻辑（`config.json` 的 `enabled` 字段不参与运行时判断，别改它当开关）。

接入三步的现状：
- ① 真实样本 100 条：2026-10-31 已跑（全链路 90%，false-local 0，frontier 下调 2.3%）
- ② verifyx 验证：2026-11-05 完成（插件加载正常、`/dsh-feiyu-brain/route` 可用、默认关行为不变）
- ③ 灰度：`route.tier` 已进 `dsh-feiyu-self` 的 `DEFAULT_FLAGS`，默认 0%，按会话分桶放量

## 变更记录

- 2026-11-05 · 补「使用说明」与「变更记录」两节（原来只有技术设计，没写什么时候用、现在能不能用）。
- 2026-11-05 · 目录改名为 `dsh-local-triage`（与包名一致，消除历史不一致）：同步 `dsh-feiyu-brain/lib/triage-bridge.js` 候选路径（旧目录名保留为兼容候选）、`dsh-plugins/tests/verify.mjs` 测试清单、`tools/client-turns.mjs` 与 `tools/client-tools.mjs` 输出路径。
