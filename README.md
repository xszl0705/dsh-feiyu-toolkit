# dsh-feiyu-toolkit

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 31 个自研插件。**零第三方 npm 依赖**，纯 ES Module，各自独立可装可卸；所有插件共用同一个底座 `dsh-plugin-kit`（先装它）。

> ## ⚠️ 装之前请先读 [docs/INTRODUCTION.md](docs/INTRODUCTION.md)
>
> **这些插件跑在 DSH 宿主进程里，拥有完整权限**——能读写文件、起子进程、联网、抓屏。DSH 不给插件加沙箱，这是架构设计不是 bug。
>
> 三条最少要知道的：
>
> 1. **AI 可能被诱导**：QQ 消息、网页、文件里的指令，模型可能当真去调用工具。工具的防线是参数校验，不是「模型不会上当」。
> 2. **别在别人的机器 / 处理敏感数据的工作机上装**。抓屏、记忆、日记类插件会把内容落到磁盘，且不加权限保护。
> 3. **一次只装一个，装前备份 `package.json` + `cordis.patch.yml` + `pnpm-lock.yaml`**。插件加载失败时 DSH 会把整个 bundles 重置成最小集，不是跳过坏的。
>
> 详细的能力边界、风险清单、每个插件碰什么文件，都在 [docs/INTRODUCTION.md](docs/INTRODUCTION.md)。

## 插件一览

### 公共底座

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-plugin-kit** | 所有插件共用的最小工具集：生命周期、原子写、`load.log`、等工具就绪、进程分类、桌宠交互计划 | 无（**其余插件都 import 它，必须最先装**） |

### 绘图与视觉

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-draw** | 数据图（matplotlib）+ 排版卡片（Pillow）。图里要出现准确数字/文字的走这个 | Python + `pylibs` |
| **dsh-comfy** | 接本地 ComfyUI：文生图、ControlNet 锁构图重绘 | ComfyUI 在跑 |
| **dsh-screenshot** | 抓屏落盘回路径，模型可直接读图 | Windows |
| **dsh-vision** | 图片转文字描述，补原生视觉的缺口 | 视觉 API |

### 数据与知识

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-finance-learn** | A股/港股/美股行情、K线、指数、宏观 + 概念卡间隔重复 | 无 |
| **dsh-memory-unified** | 跨会话长期记忆：SQLite + FTS5、写入去重、失效语义、拒答检索 | 无 |
| **dsh-group-knowledge** | 群知识库，按群作用域存储，与私有记忆分开 | 无 |
| **dsh-budget-watch** | 会话 token 预算看板：步数、累计消耗、每步均值、缓存命中率，超线给交接建议 | 无 |
| **dsh-local-triage** | 本地小模型分诊 + 工具输出确定性压缩，把不值得花云端的请求挡在云端之外 | 本地 Ollama（可选） |
| **dsh-econ-news** | 经济新闻采集与简报（IMF / WSJ / FT / 中美政策 / 学术成果），每日登录自动采一次、按日存档、出五分区简报 | 无（FT/WSJ 需自备 cookie） |
| **dsh-evidence** | 舆情采集与事实核验：网页抓取 → 取证留痕 → 多源交叉 → 不确定性与矛盾点校验 | 无 |

### 人格与对话

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-dafeiyu-core** | 身份内核：单一 persona + 渠道表达约束，所有渠道从这里取身份 | 无 |
| **dsh-dafeiyu-dialog** | 跨渠道对话总线：统一 JSONL，按 conversation 取上下文 | 无 |
| **dsh-feiyu-brain** | 认知中枢：注入防护、路由决策、上下文组装 | 无 |
| **dsh-feiyu-mood-lite** | 心情引擎：OCC 评价 + 差异化衰减 + 人格参数 | 无 |
| **dsh-feiyu-self** | 自我模型与决策日志：我是谁、会什么、不会什么 | 无 |
| **dsh-feiyu-look** | 输入框上方的只读状态条（心情/记忆/知识/技能） | 无 |

### 桌宠

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-pet-diary** | 三层日记（日常/隐私/工作）+ 例行生成 | 无 |
| **dsh-pet-hub** | 桌宠三合一状态卡与数据源 | 桌宠进程 |
| **dsh-pet-sync** | 桌宠 / 小鲸鱼挂件形态切换与生命周期 | 桌宠进程 |

### 渠道与集成

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-qq-adapter** | QQ 渠道适配器（NapCat / OneBot 11） | NapCat |
| **dsh-naga-tools** | 参照 NagaAgent 契约的启动/天气/系统控制工具 | 无 |
| **dsh-service-autostart** | 服务自愈：QQ 与微心跳没在跑就静默拉起 | NapCat（可选） |
| **dsh-playground** | 试验区管理：启停隔离实例、往试验区装插件 | **需自己配 DSH 安装路径** |

### 扮演与创作

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-rp-kit** | 角色卡与世界观素材的工具箱：盘点、打包、立绘、批量导入、剧本模拟、体检报告 | 无 |
| **dsh-rp-mode** | 扮演专用模式（agent preset `roleplay`）：只留角色卡与扮演记忆工具，没有终端/文件/联网工具 | 无 |
| **dsh-gm-craft** | GM 创作工具组：世界 / 场景 / 节拍 / 光束 / 校验，把剧情规划变成可复用手段（不做判定，不替模型写正文） | 无 |

### 运行时与效率

| 插件 | 做什么 | 外部依赖 |
|---|---|---|
| **dsh-step-saver** | 会话瘦身：`run_node` / `ls_tree` / `file_outline` / `smart_grep` 四个读盘工具 + slim 白名单 + 按需挂载 | 无 |
| **dsh-fyrunner** | 托管 FyRunner 本地推理服务：启停、重启、查状态、看日志（runtime 是 Python + pywebview） | 本地模型跑得起来 |
| **dsh-lan-web** | 把桌面客户端的 DSH web 界面开放到局域网，手机同一个 WiFi 就能跟进同一会话 | 无 |

### 需要自己填配置的插件

这几个**默认值刻意留空**——因为填什么取决于你的机器，给错的默认值比报错更坑：

| 插件 | 要配什么 | 不配会怎样 |
|---|---|---|
| `dsh-comfy` | `comfyOutputDir` / `comfyInputDir` | 报 `NOT_CONFIGURED` |
| `dsh-playground` | `exe` / `cli` | 报找不到可执行文件 |
| `dsh-qq-adapter` | `knowledge.dbFile` / `local.exe` 等 | 相关功能降级，其余照常 |
| `dsh-service-autostart` | `mindLoop.script`（默认 `enabled: false`） | 微心跳不启，NapCat 自愈照常 |
| `dsh-feiyu-mood-lite` | `personaFile`（可选） | 用内建默认人格 |

## 本次变更（2026-11-14）

- **包数 23 → 31**：并入原先留在本地工作区的 8 个插件 —— `dsh-econ-news`、`dsh-evidence`、`dsh-fyrunner`、`dsh-gm-craft`、`dsh-lan-web`、`dsh-rp-kit`、`dsh-rp-mode`、`dsh-step-saver`。
- **全仓可移植化**：源码/文档/测试里的本机绝对路径改成语义化取值（`process.env.DSH_WORKSPACE || process.cwd()`、`os.homedir()`、`process.env.DSH_HOME`），文档里统一写成 `<workspace>` / `<user>` / `<DSH_HOME>`；可移植性体检 **blockers 0 / warnings 0**。
- **脱敏**：真实 QQ 号、群号、用户名与本机路径全部换成假值或占位；`config.example.json` 覆盖到 24 个包，秒删了误入仓的 `dsh-lan-web/token.txt`（真实网关口令）。
- **配置模板**：每包标配 `config.example.json`（敏感键与绝对路径留空），`config.json` 仍只保留空模板。
- **版本**：被改动的 23 个既有包 `patch` +1；新增 8 包沿用本地版本。
- 不并入 `dsh-auto-memory`：它是第三方包 `@a9i5k4/dsh-auto-memory` 的 fork（上游 Aik358，BSD-3-Clause），按许可证与来源边界留在本仓之外。

## 一条贯穿全项目的设计原则

**只回路径，不回 base64。** 所有出图、截图、抓屏类工具都落盘到本地，返回路径，正文用 `![](路径)` 引用。把图片内容塞进上下文会直接炸掉 token 预算。

## 快速开始

```powershell
# 1. 克隆
git clone https://github.com/<你>/dsh-feiyu-toolkit.git
cd dsh-feiyu-toolkit

# 2. dsh-draw 需要先补 Python 依赖（不用 pip，详见 scripts/setup-pylibs.ps1 开头的说明）
pwsh -File scripts\setup-pylibs.ps1

# 3. 先装公共底座，再装要用的插件（一步步来，别一次全加，详见 docs/INSTALL.md）
dsh plugin add link:<repo>\packages\dsh-plugin-kit
dsh plugin add link:<repo>\packages\dsh-draw
```

不想装某个插件就直接跳过——除 `dsh-plugin-kit` 是公共底座之外，其余互相独立。

## 目录结构

```
packages/          每个插件一个目录，各自独立可发布
  dsh-plugin-kit/  公共底座（所有插件的 import 目标，必须先装）
  dsh-draw/        含 lib/py/*.py（matplotlib / Pillow 渲染脚本）
  dsh-comfy/       含 extra-model-paths.example.yaml（ComfyUI 外挂模型模板）
  dsh-rp-mode/     扮演模式（工具面窄化 + 角色卡/扮演记忆）
  dsh-step-saver/  会话瘦身（读盘工具 + slim 白名单）
  ...
scripts/
  setup-pylibs.ps1     给 dsh-draw 补 Python 依赖
  fetch-pylibs.py      wheel 直链下载器（绕开 pip）
  portability-check.py 可移植性体检
docs/
  INSTALL.md       详细安装步骤
  GIT-GUIDE.md     怎么发布和维护这个仓
```

## 几个必须知道的坑

这些不是猜测，是踩出来的：

1. **`pip` 在 DSH 沙箱里不可用**——写盘报 `Errno 13`。所以 `dsh-draw` 的依赖是 wheel 解压后的目录，靠 `PYTHONPATH` 注入，不走 `pip install`。
2. **子进程不能用管道通信**——`child_process` 的 `stdio: 'pipe'` 在沙箱里返回 `spawn EPERM`。`dsh-draw` 因此改成文件当 IPC：参数写 `spec.json`，结果写 `result.json`。
3. **ComfyUI 的目录参数必须对得上**——`comfyOutputDir` / `comfyInputDir` 要和启动 ComfyUI 时传的 `--output-directory` / `--input-directory` 一字不差，否则报 `NO_FILE`。
4. **ComfyUI 不归插件管**——`dsh-comfy` 不会帮你启服务。它是常驻推理服务，占显存，什么时候开归你。
5. **`dsh-plugin-kit` 必须能被解析到**——所有插件写的是 `import 'dsh-plugin-kit/lifecycle'` 这种包名导入，不是相对路径。从源码装时，`dsh-plugin-kit` 要么作为同目录兄弟包被 link 进来，要么手动放进 profile 的 `node_modules`。漏装它的表现是每个插件都在 apply 阶段报 `ERR_MODULE_NOT_FOUND`。

## 许可

MIT。

## 第三方与致谢

本仓有插件 fork 过或参考了现有项目（`dsh-rofm`、`@kenz1117/dsh-engram`、`graph-memory`、`NagaAgent` 等）。
完整的署名、许可证全文、以及哪些是代码继承、哪些只是设计思路参考，都写在
**[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**。

给人看的版本（含链接）在 [docs/INTRODUCTION.md](docs/INTRODUCTION.md#参考与致谢)。

各插件的第三方依赖（matplotlib / Pillow / 腾讯财经数据 / ComfyUI）遵循各自许可。
