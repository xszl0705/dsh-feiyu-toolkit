# 第三方声明（THIRD-PARTY NOTICES）

本仓的插件在开发和重写过程中参考、对比、借鉴了若干现有项目。这里把关系写清楚，
包括**哪些是代码层面有继承**、**哪些只是设计思路参考**。

---

## 一、有代码继承关系的

### dsh-rofm

- **仓库**：https://github.com/wall1234567/dsh-rofm
- **许可证**：MIT
- **版权**：dsh-rofm contributors
- **关系**：`dsh-memory-unified` 的 **0.1 版本 fork 自它**，作为底座。
  当时的 `lib/plugin.js` 里的 `compressWithEscalation`（阈值确定性归档）、
  `memory_judge` 工具（α/β/关键词评分）、概率回忆与 v2 快照恢复，都是**原样保留**的。
- **现状**：0.2 起是无依赖重写，**当前发布的代码不再包含 dsh-rofm 的源码**；
  但既然历史上 fork 过、方法也沿用了它的设计，这里保留署名。

原项目 MIT 许可声明：

```
MIT License

Copyright (c) dsh-rofm contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 二、设计思路参考（无代码继承）

| 项目 | 仓库 | 许可 | 借鉴了什么 |
|---|---|---|---|
| **@kenz1117/dsh-engram** | https://github.com/kenz1117/dsh-engram | **MIT** | 跨会话召回、窄参数工具设计、SM-2 复习。`dsh-memory-unified` 从它 23 个工具里只取了最必要的两个（`memory_search` / `memory_remember`），不引 SQLite 向量那一套 |
| **graph-memory** | https://github.com/adoresever/graph-memory | **MIT** | 「保留最近 N 轮」的归档策略。`dsh-memory-unified` 的 `compress.keepRecentTurns` 来自这个思路；但**没有做** reasoning/tool 痕迹剥离（那属于宿主历史面） |
| **NagaAgent** | https://github.com/RTGS2017/NagaAgent | **AGPL-3.0** ⚠️ | `dsh-naga-tools` 的工具契约参照它的 `agent-manifest.json`；`dsh-memory-unified` 早期的实体图设计参照过它的 `summer_memory` |

> 说明：`dsh-engram` 在 DSH 生态里有**多个同名项目**（`skepsun/dsh-engram` 是极简版）。
> 这里指的是有 SQLite + FTS5 + 向量检索 + SM-2 的那个，即 `@kenz1117/dsh-engram`。

### ⚠️ 关于 NagaAgent 的 AGPL-3.0

AGPL-3.0 是**强 copyleft**。如果 `dsh-naga-tools` 复制了 NagaAgent 的源代码，
按 AGPL 要求整个项目就得改用 AGPL-3.0 并公开源码。

**本项目的情况**：`dsh-naga-tools` 是**照着接口契约独立实现**的——

- 参照的是「有哪些能力、参数长什么样」这份清单（`agent-manifest.json` 的结构）
- 实现语言是纯 Node ESM，NagaAgent 是 Python + MCP
- 没有引入它的任何 Python 模块、没有 spawn 它的进程、没有拷贝它的代码文件

在「接口/契约」与「源代码」之间，本项目的做法落在前者。
**但如果你要在此基础上继续开发，请自行确认这个边界**——接口设计在某些司法管辖区也可能受保护，
而「照着重写」和「照抄」的界线需要按实际代码判断。本声明不构成法律意见。

---

## 二·B、桌宠相关（pet-diary / pet-hub / pet-sync）

桌面宠物这个方向已经有相当成熟的方案，做之前系统读了一遍。

**重要区分**：本仓的 `dsh-pet-diary` / `dsh-pet-hub` / `dsh-pet-sync` 是 **DSH 插件**（纯 Node ESM），
负责日记存储、状态卡、形态切换。**桌宠本体不在本仓**——那是一个独立的 Python 程序，
本仓只是通过 HTTP 与文件去读它的状态。下面这些项目影响的是**桌宠本体的设计**，
以及这几个插件对「桌宠该有什么」的取舍。

| 项目 | 仓库 | 许可 | 借鉴了什么 / 没借什么 |
|---|---|---|---|
| **dsh-pet** | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | MIT（**形象素材 CC BY-NC-SA，非商用**） | 借鉴：素材生成链（AI 视频 → 透明动画）、对外 API 让别的插件驱动宠物、多显示器工作区判定、睡觉时完全安静。<br>没借：它依赖 Electron 运行时、体量太大 |
| **dsh-pet-indesktop** | [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) | MIT | 跨平台移植时踩的坑清单 |
| **oc-pet** | [openhanako-labs/oc-pet](https://github.com/openhanako-labs/oc-pet) | **AGPL-3.0** ⚠️ | 同为 PySide6 的透明桌宠，参考了它的整体结构。**未复制代码** |
| **Shimeji-Desktop**（Shimeji-ee） | [DalekCraft2/Shimeji-Desktop](https://github.com/DalekCraft2/Shimeji-Desktop) | 未明确声明 | 借鉴：`Action`（Stay/Move/Fall/Dragged/Jump）× `Behavior` 状态机的「行为=数据」思路、物理下落/拖拽/抛掷的经典实现、越界自愈 |
| **VShimeji** | [Valkryst/VShimeji](https://github.com/Valkryst/VShimeji) | 未明确声明 | 同上，Shimeji-ee 的另一个分支 |
| **shimeji-rs** | [danhab99/shimeji-rs](https://github.com/danhab99/shimeji-rs) | 未声明 | 只看过它的性能与打包方式 |
| **zhizhiji-shimeji** | [YuZhu412/zhizhiji-shimeji](https://github.com/YuZhu412/zhizhiji-shimeji) | 未声明 | 读的是它的 [`CODE_ARCHITECTURE.md`](https://github.com/YuZhu412/zhizhiji-shimeji/blob/main/CODE_ARCHITECTURE.md) 架构分析，不是代码 |

> **关于形象素材**：`dsh-pet` 的角色形象是 **CC BY-NC-SA（非商用）**。本项目的桌宠形象与素材是自己做的，
> **没有使用它的形象资源**。如果你的用途涉及商用，请自己确认所用人物的授权。

### AGPL-3.0 说明（oc-pet）

和 NagaAgent 一样是强 copyleft。本项目只参考了「PySide6 透明窗口 + 帧动画」这个通用结构，
没有拷贝 `oc-pet` 的任何代码。这个结构在 PySide6 生态里是公开常识，不构成衍生作品。

---

## 二·C、群聊参与与记忆策略

`dsh-feiyu-brain`（路由 / 注入过滤）和 `dsh-group-knowledge`（群知识）在动手前，
把市面上做「AI 参与群聊」的方案系统读了一遍，逐条列了「借什么 / 不借什么」。

| 项目 | 仓库 | 许可 | 借了什么 / 没借什么 |
|---|---|---|---|
| **AstrBot** | [AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot) | **AGPL-3.0** ⚠️ ★45k | 借：`group_chat` 的四态心流与能量/状态机思路；`Jev` 的**概率门 + System One 复核**、限频、降级、静默密度。<br>没借：它的在线 Q-learning、吐槽模块、200+ 参数配置、外部依赖 |
| **LangBot** | [langbot-app/LangBot](https://github.com/langbot-app/LangBot) | **Apache-2.0** ★18.6k | 多平台机器人框架的通道抽象设计 |

> **AstrBot 是 AGPL-3.0。** 本项目**没有复制它的代码**——只采纳了「用概率门决定要不要开口、
> 开口前再复核一次」这个策略思路。这个思路本身在任何语言里都能重写，不构成衍生作品。
> 但如果你的用途对 AGPL 敏感，请自行确认边界。

### 学术参考

下面这些是**论文**，不是代码。它们影响的是策略设计（什么时机开口、怎么组织记忆、怎么自我改进）。

| 论文 | arXiv | 作用 |
|---|---|---|
| DiscussLLM | [2508.18167](https://arxiv.org/abs/2508.18167) | 多 AI 讨论 |
| Speak or Stay Silent | [2603.11409](https://arxiv.org/abs/2603.11409) | 何时开口 |
| Proactive AI | [2610.05159](https://arxiv.org/abs/2610.05159) | 主动交互 |
| When2Speak | [2605.05626](https://arxiv.org/abs/2605.05626) | 多人发言时机数据集 |
| Mem0 | [2504.19413](https://arxiv.org/abs/2504.19413) | 记忆层 |
| A-MEM | [2502.12110](https://arxiv.org/abs/2502.12110) | 智能体记忆 |
| Zep | [2501.13956](https://arxiv.org/abs/2501.13956) | 时序知识图记忆 |
| LightRAG | [2410.05779](https://arxiv.org/abs/2410.05779) | 轻量检索增强 |
| Reflexion | [2303.11366](https://arxiv.org/abs/2303.11366) | 语言智能体的自我反思 |
| Voyager | [2305.16291](https://arxiv.org/abs/2305.16291) | 技能积累 |
| DSPy | [2310.03714](https://arxiv.org/abs/2310.03714) | 提示词程序化 |
| GEPA | [2507.19457](https://arxiv.org/abs/2507.19457) | 反思生成补丁 |
| Ragas | [2309.15217](https://arxiv.org/abs/2309.15217) | 检索评测 |

**最终取舍**（记录在这里是为了避免以后被误解成「没看就写了」）：

- 记忆用 **SQLite + FTS5**，图/向量暂缓（Mem0 / Zep / LightRAG 的方案更重，当前规模不值得）
- 反思只做 **GEPA-lite**（生成补丁 + 评测筛选），不做完整的 GEPA 循环
- 群聊开口用**概率门 + 复核**，不做 Q-learning

---

## 三、算法与标准

| 来源 | 用在 | 说明 |
|---|---|---|
| **OCC 情绪模型** — Ortony, A., Clore, G. L., & Collins, A. (1988). *The Cognitive Structure of Emotions*. Cambridge University Press. | `dsh-feiyu-mood-lite` | 心情评价的维度取自这本书 |
| **SM-2 间隔重复** — Piotr Woźniak, SuperMemo 2 (1987) | `dsh-finance-learn` 的概念卡复习 | 评分沿用 Anki 的 4 档，内部折算成 SM-2 的 0-5 质量分 |
| **OpenFeature** — https://openfeature.dev/ | `dsh-feiyu-self` 的变体开关 | 语义照它的思路做了简化，没有引 SDK |
| **OneBot 11** — https://github.com/botuniverse/onebot-11 | `dsh-qq-adapter` | 消息协议标准 |

---

## 四、第三方软件与服务（是依赖，不是继承）

| 项目 | 许可 / 性质 | 链接 |
|---|---|---|
| DeepSeek Harness | 宿主平台 | https://github.com/deepseek-ai |
| ComfyUI | GPL-3.0（独立进程，不链接） | https://github.com/comfyanonymous/ComfyUI |
| NapCat | 见其仓库 | https://github.com/NapNeko/NapCatQQ |
| Ollama | MIT | https://ollama.com/ |
| matplotlib | PSF-based（BSD 兼容） | https://matplotlib.org/ |
| Pillow | HPND | https://python-pillow.org/ |
| NumPy | BSD-3-Clause | https://numpy.org/ |
| SQLite / FTS5 | Public Domain | https://www.sqlite.org/fts5.html |

### 可选的运行时集成

| 项目 | 关系 | 说明 |
|---|---|---|
| `dsh-tts-bridge` | **不是本仓的代码**，是可选的第三方插件 | `dsh-pet-hub` 会请求它的 `/dsh-tts-bridge/state` 与 `/auto` 接口来显示朗读状态。**没装它也不影响**——请求失败就静默降级，不报错 |

> 如果你在 `dsh-pet-hub` 里看到指向 `dsh-tts-bridge` 的请求，那是这个原因，不是未声明的依赖。

---

## 五、数据来源

| 来源 | 用途 | 声明 |
|---|---|---|
| 腾讯财经（`qt.gtimg.cn` / `web.ifzq.gtimg.cn`） | `dsh-finance-learn` 行情与 K 线 | 公开接口，**仅供个人学习研究，不构成投资建议** |
| wttr.in | `dsh-naga-tools` 天气 | https://github.com/chubin/wttr.in |
| DeepSeek API | `dsh-vision` 图片理解 | 图片会上传到 DeepSeek 服务器 |

---

## 如果发现声明有误或遗漏

提 issue。这类声明宁可多写一条，也不要漏掉别人的署名。
