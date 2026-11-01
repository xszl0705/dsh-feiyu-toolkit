# 安装与配置

> 目标：从「下载仓库」到「工具出现在对话里、能用」，每一步都能验证。
> 装插件会改 profile 配置，**全程一次只加一个，加完重启验一次**。

---

## 0. 先说清楚：这不是一键安装包

21 个插件里，**13 个挂工具**（共 19 个），**8 个是服务层**（不挂工具，被别的插件调用）。

装完并不等于全功能可用。分三种情况：

| 情况 | 插件 | 说明 |
|---|---|---|
| 装完立刻能用 | budget / screenshot / self / feiyu_mood_status / memory / chatlog / diary / fin_* / learn_* / naga | 不需要外部程序 |
| 装完要先补依赖 | draw（缺 Python 包）、pet（缺桌宠程序） | 见 §2 |
| 装完要填配置或起服务 | comfy（ComfyUI）、qq（NapCat）、playground（exe/cli）、vision_describe（视觉 API） | 见 §4 |

**没有安装器**。要手动改 profile 的 `package.json` 和 `bundles`，或者用你自己的插件管理命令。

---

## 1. 前置条件

| 需要 | 什么时候需要 | 检查方式 | 没有会怎样 |
|---|---|---|---|
| DSH 桌面版 | 全部 | 能打开对话窗口 | 后面都没意义 |
| Node | 跑测试 / 部分脚本 | 用 DSH 自带那个即可 | 工具本身不需要 |
| Python 3.10+ | 仅 `dsh-draw` | `python -V` | `draw_chart` 报 `PYTHON_NOT_FOUND` |
| ComfyUI | 仅 `dsh-comfy` | 浏览器打开 `http://127.0.0.1:8188` | `comfy` 报 `OFFLINE` |
| NapCat（QQ） | 仅 `dsh-qq-adapter` | `ws://127.0.0.1:3001` 能连 | `qq` 报 `NAPCAT_DOWN` |
| Ollama | 可选：`qq` 用本地小模型 | `http://127.0.0.1:11434` | 自动降级到主模型 |
| 桌宠程序（pythonw 脚本） | 仅 `dsh-pet-hub` / `dsh-pet-sync` | 桌宠目录里有入口脚本 | `pet` 报 `PET_MISSING` |

`node`、`python` 常见位置（不在 PATH 里时）：

```
<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/node/bin/node.exe
<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/python/python.exe
```

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`。

---

## 2. 从零安装

### 2.1 拿到仓库

```powershell
git clone https://github.com/xszl0705/dsh-feiyu-toolkit.git
cd dsh-feiyu-toolkit
```

### 2.2 备份 profile 三件套（必做）

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$bak = "$env:USERPROFILE\.dsh\backups\$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
Copy-Item "$profile\package.json","$profile\cordis.patch.yml","$profile\pnpm-lock.yaml" $bak -ErrorAction SilentlyContinue
```

**为什么必做**：插件 `apply` 抛错时，DSH 不会「跳过坏的」，而是把整个 `bundles` 重置成最小集——所有插件同时熄火。有备份才能原样恢复。

### 2.3 补 Python 依赖（只有 dsh-draw 需要）

```powershell
pwsh -File scripts\setup-pylibs.ps1
```

它做三件事：找 Python → 下载 wheel 解压到 `packages/dsh-draw/pylibs/` → 自检 `import matplotlib`。

**为什么不用 pip**：DSH 沙箱里 pip 写盘会被拒（`Errno 13`），纯 Python 包也装不上。依赖以解压目录形式存在，运行时通过 `PYTHONPATH` 注入。

验证：

```powershell
$env:PYTHONPATH = "packages\dsh-draw\pylibs"
& <python> -c "import matplotlib; print(matplotlib.__version__)"
```

### 2.4 加插件（一次一个）

每个插件要改两处：**依赖** + **进 bundles**。

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\package.json
{
  "dependencies": {
    "dsh-draw": "link:<你的仓库目录>/packages/dsh-draw"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-draw"
      ]
    }
  }
}
```

有插件管理命令的话等价于：

```powershell
dsh plugin add link:<你的仓库目录>/packages/dsh-draw
```

**加一个 → 重启 → 验一个，别攒着加。**

### 2.5 重启并验收

重启宿主后**新开一个会话**（旧会话不会拿到新工具），然后看：

| 检查项 | 怎么看 | 不通过说明 |
|---|---|---|
| 工具出现 | 会话里能调到对应工具名 | bundles 没加或包名写错 |
| 加载日志 | `packages/<包名>/load.log` 里有「工具已注册」 | 文件不存在 = 没加载 |
| 真跑一次 | 比如 `screenshot` 抓一张、`draw_chart` 画一张 | 返回 ok 但文件不存在 = 输出目录问题 |
| 断服务路径 | 服务没起时工具报明确错误码，不是崩 | 崩了 = 异常没兜住 |

---

## 3. 插件之间的依赖

**这些插件不是各自独立的。** 服务层插件要先装，工具层才能拿到依赖；拿不到时它们会降级或报 `*_UNAVAILABLE`。

### 3.1 谁提供什么服务

| 服务名 | 提供者 | 谁在用 |
|---|---|---|
| `dialog` / `dialogues` | dsh-dafeiyu-dialog | feiyu-self、vision、qq-adapter |
| `brain` | dsh-feiyu-brain | feiyu-self、qq-adapter |
| `self` | dsh-feiyu-self | comfy、draw、mood-lite、playground、qq-adapter、vision、service-autostart |
| `memory` | dsh-memory-unified | qq-adapter、vision |
| `knowledge` | dsh-group-knowledge | qq-adapter |
| `vision` | dsh-vision | qq-adapter |
| `autostart` | dsh-service-autostart | qq-adapter |
| `comfy` / `draw` / `playground` / `finance-learn` | 各自插件 | 一般只给自己用 |

宿主自带的：`tools`、`systemPrompt`、`webServer`、`sessions`、`llm`、`deepseekAccount`。这些不用装。

### 3.2 推荐安装顺序

```
第 1 层 · 底座（互相不依赖，先装）
  dsh-dafeiyu-core      人格内核（给系统提示注入一段）
  dsh-dafeiyu-dialog    对话总线（提供 dialog/dialogues）
  dsh-feiyu-brain       认知中枢（提供 brain）
  dsh-memory-unified    长期记忆（提供 memory）

第 2 层 · 服务（依赖第 1 层）
  dsh-feiyu-self        自我模型（提供 self，依赖 brain + dialog）
  dsh-group-knowledge   知识库（提供 knowledge）
  dsh-vision            看图服务（提供 vision）

第 3 层 · 工具（本身能独立跑）
  dsh-budget-watch  dsh-screenshot  dsh-draw  dsh-comfy
  dsh-naga-tools    dsh-finance-learn   dsh-pet-diary
  dsh-feiyu-self（工具 self）  dsh-playground

第 4 层 · 渠道与界面（依赖上面全部）
  dsh-qq-adapter         需要 dialog + brain + memory + knowledge + vision + autostart
  dsh-service-autostart  服务自愈（可选，但 qq 装了它就建议一起装）
  dsh-pet-hub / dsh-pet-sync   桌宠（需要桌宠程序本体）
  dsh-feiyu-look / dsh-feiyu-mood-lite   界面与心情
```

**最省事的最小组合**（只要聊天增强）：

```
dsh-dafeiyu-core + dsh-dafeiyu-dialog + dsh-feiyu-brain + dsh-memory-unified
+ dsh-feiyu-self + dsh-pet-diary + dsh-budget-watch
```

---

## 4. 配置项

所有配置都在 `packages/<包名>/config.json`。**改完要重启才生效。**

标记说明：**必填** = 空着功能直接不可用；**可选** = 空着自动落到默认目录；**按需** = 看你要不要这个功能。

### 4.1 dsh-draw（绘图）

| 字段 | 默认 | 说明 |
|---|---|---|
| `outputDir` | 空 | **可选**，留空落到 `<DSH_HOME>/out/draw` |
| `pythonPath` | 空 | **可选**，留空自动找（`DSH_PYTHON` 环境变量优先） |

前置：跑过 `setup-pylibs.ps1`。

### 4.2 dsh-comfy（ComfyUI 绘图）

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `comfyOutputDir` | 空 | **必填**，必须等于 ComfyUI 的 `--output-directory` |
| `comfyInputDir` | 空 | **必填**，必须等于 ComfyUI 的 `--input-directory` |
| `outputDir` | 空 | 可选，插件自己的工作目录 |
| `defaultCheckpoint` | 空 | 可选，默认底模文件名 |
| `defaultControlnet` | 空 | 可选，默认 ControlNet 模型名 |

**两个目录必须和 ComfyUI 启动参数一字不差**，否则图生成了但插件找不到，报 `NO_FILE`。

外挂模型路径（模型放在整合包外面时）：

```powershell
Copy-Item packages\dsh-comfy\extra-model-paths.example.yaml packages\dsh-comfy\extra-model-paths.yaml
# 改 base_path 指向你的 ComfyUI 整合包
```

### 4.3 dsh-screenshot（截图）

| 字段 | 默认 | 说明 |
|---|---|---|
| `outDir` | 空 | **可选**，留空落到 `<DSH_HOME>/screens` |
| `maxWidth` | 1400 | 超宽图缩放 |
| `keepFiles` | 80 | 最多保留几张，旧的自动清 |

Windows 自带 GDI+，不需要额外依赖。

### 4.4 dsh-memory-unified（长期记忆）

| 字段 | 默认 | 说明 |
|---|---|---|
| `storeDir` | 空 | **可选**，留空落到 DSH 默认目录 |
| `store` | `sqlite` | `sqlite` 或 `json`（无 node:sqlite 时自动回退） |
| `autoRecall` | `false` | 是否每轮自动召回 |
| `recallLimit` | 3 | 自动召回条数 |
| `maxItemsPerFolder` | 200 | 单目录上限，超了自动整理 |
| `dedupe` | `true` | 写入去重 |

### 4.5 dsh-pet-diary（日记）

| 字段 | 默认 | 说明 |
|---|---|---|
| `dir` | 空 | **可选**，留空落到 `<DSH_HOME>/dafeiyu/diary` |
| `salt` | 空 | **按需**，私有日记的加密盐；不填则明文 |
| `routines` | 见下 | 定时生成规则 |

默认 routines：

```jsonc
[
  { "id": "daily", "enabled": true,  "time": "22:00", "kind": "daily", "maxChars": 500, "maxChats": 80 },
  { "id": "work",  "enabled": false, "time": "18:30", "kind": "work",  "maxChars": 800, "maxChats": 120 }
]
```

### 4.6 dsh-playground（试验区）

| 字段 | 默认 | 说明 |
|---|---|---|
| `profile` | `verifyx` | 默认操作哪个试验区 |
| `port` | 3080 | 实例端口 |
| `exe` | 空 | **必填**，DSH 可执行文件路径 |
| `cli` | 空 | **必填**，DSH CLI 脚本路径 |
| `profilesRoot` | 空 | 可选，留空用 `<DSH_HOME>/profiles` |
| `backupRoot` | 空 | 可选，留空用 `<DSH_HOME>/backups` |
| `bootTimeoutMs` | 45000 | 启动超时 |

`exe` / `cli` 在 DSH 安装目录里找，不同版本路径不一样，装完用 `playground_status` 验证。

### 4.7 dsh-qq-adapter（QQ 渠道）

**必填**

| 字段 | 说明 |
|---|---|
| `wsUrl` | NapCat 的 WebSocket 地址，默认 `ws://127.0.0.1:3001` |
| `httpUrl` | NapCat 的 HTTP 地址，默认 `http://127.0.0.1:3000` |
| `ownerId` | 你的 QQ 号（决定谁是「主人」，空着所有人都是陌生访客） |

**常用**

| 字段 | 默认 | 说明 |
|---|---|---|
| `groups` | `[]` | 允许的群号白名单，空 = 不收群消息 |
| `wakeWords` | `["大肥鱼","虚的鱼","小鱼","肥鱼"]` | 群里点名唤醒词 |
| `requireAtInGroup` | `true` | 群聊必须 @ 才回 |
| `maxReplyChars` | 120 | 单条回复字数上限 |
| `ratePerMinute` | 6 | 限速 |
| `accessToken` | 空 | NapCat 配了 token 才填 |
| `identityFile` | 空 | 可选，身份设定文件，留空用内置 |
| `groupPromptFile` | 空 | 可选，群聊额外提示词文件 |
| `microGroupInbox` | 空 | 可选，微决策的留言落盘文件 |
| `pauseFile` | 空 | 可选，群静默标记文件 |

**子配置**

| 字段 | 说明 |
|---|---|
| `vision.*` | 看图配置：`model`、`baseURL`（默认 `https://api.deepseek.com`）、`maxImages`、`maxBytes`、`timeoutMs` |
| `gate.*` | 本地小模型门卫：`endpoint`（默认 Ollama 11434）、`model`（默认 `qwen3:4b`） |
| `knowledge.*` | 群知识库：`dbFile`、`maxPerQuery`、`ingestLinks` |
| `local.*` | 本地模型：`exe`、`models`、`endpoint`、`model`、`numPredict` |
| `policy.*` | 群聊发言策略：概率、冷却、密度上限、静默 |

**需要配合的插件**：`dsh-dafeiyu-dialog`（对话）、`dsh-feiyu-brain`（路由）、`dsh-memory-unified`（记忆）、`dsh-group-knowledge`（知识库）、`dsh-vision`（看图）、`dsh-service-autostart`（自愈，可选）。缺哪个会对应降级，`qq_status` 能看出来。

### 4.8 dsh-service-autostart（服务自愈）

| 字段 | 默认 | 说明 |
|---|---|---|
| `napcat.enabled` | `true` | 是否自动拉起 NapCat |
| `napcat.root` | 空 | **必填**（启用时），NapCat 安装目录，里面有 `start-hidden.vbs` |
| `napcat.port` | 3001 | 检测端口 |
| `mindLoop.enabled` | `false` | 是否拉起微心跳 |
| `mindLoop.script` | 空 | **必填**（启用时），心跳脚本路径 |
| `mindLoop.node` | 空 | **必填**（启用时），node 可执行文件 |

不填时不会崩，`check` 返回 `MISSING_LAUNCHER`。

### 4.9 dsh-pet-hub / dsh-pet-sync（桌宠）

| 字段 | 默认 | 说明 |
|---|---|---|
| `petDir` | 空 | **必填**，桌宠程序目录（含入口脚本） |
| `pythonw` | 空 | **必填**，pythonw.exe 路径 |
| `autoStart`（sync） | `true` | 宿主启动时拉起桌宠 |
| `form`（sync） | `pet` | `pet` 桌宠形 / `widget` 挂件形 |

**注意**：这个仓库只包含「让 DSH 能控制桌宠」的插件，**不含桌宠程序本体**，需要自己准备。

### 4.10 其余插件（基本不用改）

| 插件 | 需要改的 |
|---|---|
| dsh-budget-watch | `sessionsRoot` 留空即可；阈值按需调 |
| dsh-dafeiyu-core | `dir` 留空即可（默认 `<DSH_HOME>/dafeiyu`） |
| dsh-dafeiyu-dialog | 无 config.json |
| dsh-feiyu-brain | 一般不改；`routing.*` / `context.*` / `reflection.*` 按需 |
| dsh-feiyu-look | 无 config.json |
| dsh-feiyu-mood-lite | `personaFile` 留空即可；`judge` / `provider` / `model` 按需 |
| dsh-feiyu-self | `knownPlugins` 列了默认插件名，装多了按需补 |
| dsh-finance-learn | `dbFile` 留空即可 |
| dsh-group-knowledge | `dbFile` 留空即可；`allowShared` 决定能否跨群共享 |
| dsh-naga-tools | 无 config.json |
| dsh-vision | 一般不改；`maxImageBytes` / `timeoutMs` 按需 |

---

## 5. 验收清单

装完每个插件，按这个顺序验：

| 步骤 | 命令 / 操作 | 期望 |
|---|---|---|
| 1. 工具注册 | 新会话里问一句「你有哪些工具」 | 能看到工具名 |
| 2. 加载日志 | 看 `packages/<包>/load.log` | 有「已注册」字样 |
| 3. 真跑一次 | 调一次工具 | 返回 `ok: true` 且产物存在 |
| 4. 跑该包测试 | `<node> packages/<包>/tests/run-all.mjs` | 全过 |

不需要外部服务的包都能跑测试；需要服务的（comfy、qq）测试会提前跳过或报 `OFFLINE`。

---

## 6. 故障码对照

| 错误码 | 出现在 | 意思 | 怎么办 |
|---|---|---|---|
| `PYTHON_NOT_FOUND` | draw | 找不到 Python | 配 `pythonPath` 或设 `DSH_PYTHON` |
| `NO_RESULT` | draw | pylibs 是空的 | 重跑 `setup-pylibs.ps1` |
| `NOT_CONFIGURED` | comfy | 两个目录没填 | 填 `comfyOutputDir` / `comfyInputDir` |
| `OFFLINE` | comfy | ComfyUI 没起 | 手动启动 ComfyUI |
| `NO_FILE` | comfy | 目录和 ComfyUI 参数不一致 | 对齐 `--output-directory` |
| `NAPCAT_DOWN` | qq | NapCat 没连上 | 启动 NapCat，检查 `wsUrl` |
| `PET_MISSING` | pet | 桌宠目录没有入口脚本 | 检查 `petDir` |
| `MISSING_LAUNCHER` | autostart | 启动脚本不存在 | 检查 `napcat.root` / `mindLoop.script` |
| `*_UNAVAILABLE` | 多个 | 依赖的服务没装 | 按 §3 补装对应插件 |

---

## 7. 出问题怎么查

| 现象 | 先看哪里 |
|---|---|
| 工具没出现 | 插件 `load.log`；profile 的 `bundles` 有没有这项 |
| 装了之后所有工具都没了 | 某个插件 apply 抛错导致 bundles 被重置 → 恢复备份，一次只装一个 |
| 启动直接失败 | **只点「重启」，绝不点「禁用第三方插件」**——那是全灭按钮 |
| 工具在但一调就报错 | 看错误码，对照 §6 |

---

## 8. 卸载

从 profile 的 `dependencies` 删掉 `link:` 那行，从 `bundles` 删掉对应项，重启。插件目录留着不影响。

---

## 9. 可移植性自查

```powershell
& <python> scripts\portability-check.py --root packages
```

`blocker = 0` 才算干净。它会揪出硬编码的本机路径。

---

## 10. 从旧版本升级

### 10.1 最省事：跑升级脚本

```powershell
# 目录本身是 git 仓库
pwsh -File scripts\upgrade.ps1

# 你是下载 zip 解压的（不是 git）
pwsh -File scripts\upgrade.ps1 -SourceDir <新版本解压目录>
```

脚本做四件事，**你的 `config.json` 不会被覆盖**：

1. 把 21 个 `config.json` 备份到临时目录
2. 更新代码（git 用户走 `fetch + reset`，不是 `pull`）
3. 把配置原样放回去
4. 打印每个插件的版本变化

**为什么不是 `git pull`**：本仓库的历史被重写过一次（清理早期提交里的本机路径），老克隆和远端已经分叉，`pull` 会报 `diverged`。只能用 `git fetch origin && git reset --hard origin/main` 对齐。

重启这一步脚本不做，请你自己按。

### 10.2 手动升级（不想跑脚本）

```powershell
# 1. 备份配置
$dst = "$env:TEMP\config-backup"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-ChildItem packages -Recurse -Filter config.json | ForEach-Object {
  $rel = $_.FullName.Substring((Resolve-Path packages).Path.Length + 1)
  New-Item -ItemType Directory -Force -Path (Split-Path (Join-Path $dst $rel)) | Out-Null
  Copy-Item $_.FullName (Join-Path $dst $rel) -Force
}

# 2. 更新代码
git fetch origin
git reset --hard origin/main

# 3. 恢复配置
Copy-Item "$dst\*" packages -Recurse -Force
```

zip 用户：把新版本解压到别处，只覆盖 `packages\` 下除 `config.json` 以外的文件。

### 10.3 这一版有破坏性变更：工具名合并成单入口

旧版的多个工具现在合成了一个入口，**旧工具名不再注册**：

| 旧工具 | 新工具 |
|---|---|
| `budget_status` / `budget_sessions` / `budget_advice` | `budget` |
| `comfy_status` / `comfy_generate` / `comfy_controlnet` | `comfy` |
| `self_status` / `self_check` / `self_metrics` …（10 个） | `self` |
| `memory_remember` / `memory_search` …（9 个） | `memory` |
| `naga_app_launcher` / `naga_weather_time` / `naga_system_control` | `naga` |
| `chatlog_*` / `diary_*`（13 个） | `chatlog` + `diary` |
| `pet_form` / `pet_say` / `pet_start` / `pet_status` / `pet_stop` | `pet` |
| `playground_check` / `playground_start` …（6 个） | `playground` |
| `qq_send` / `qq_status` | `qq` |
| `screenshot_take` / `screenshot_windows` | `screenshot` |

**影响**：模型会自动看到新工具，一般不用改什么；但如果你在系统提示、自定义 prompt 或外部脚本里写死了旧工具名，要一起改。

参数结构也变了，统一成 `action=xxx`：

```jsonc
// 旧：comfy_generate({ prompt: "..." })
// 新：comfy({ action: "generate", prompt: "..." })
```

### 10.4 升级后验证

| 检查 | 做法 |
|---|---|
| 配置还在 | 打开 `packages/<包>/config.json`，你的值应该还在 |
| 工具改名生效 | 新会话里看工具列表 |
| 版本对得上 | `packages/<包>/package.json` 的 `version` |
| 真跑一次 | 各挑一个工具调一下 |

**升级前后配置字段没有任何增删**，所以老配置可以原样用，不需要迁移。
