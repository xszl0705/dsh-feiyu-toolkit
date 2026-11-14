# dsh-comfy

> 版本：0.1.1（与 `package.json` 一致）

接本地 ComfyUI。单入口工具 `comfy(action=…)`：

## 工具列表

| 工具 | 一句话作用 | 必填参数 |
|---|---|---|
| `comfy` | `action=status` 看服务在不在、版本、GPU 显存、有哪些底模与 ControlNet | `action` |
|  | `action=generate` 文生图（txt2img） | `action`；**`prompt` 实务上必填**（不填也能跑，但出的是无提示词的空图） |
|  | `action=controlnet` 用参考图锁构图重绘（表情差分、换装、姿势微调） | `action` + **`imagePath`**（缺/不是真图片直接 `BAD_INPUT`）；`prompt` 同理建议给 |

参数全集（`lib/tools.js:96-112`，schema 的 `required` 只有 `['action']`）：

| 参数 | 类型 | 用于 | 说明 |
|---|---|---|---|
| `action` | string | 全部 | `status` \| `generate` \| `controlnet`，缺省按 `status` 处理 |
| `prompt` | string | generate/controlnet | 正向提示词 |
| `negative` | string | generate/controlnet | 反向提示词，可选 |
| `imagePath` | string | controlnet | 参考图绝对路径，会被复制进 ComfyUI 的 input 目录 |
| `ckpt` | string | generate/controlnet | 底模名，默认 `anything-v5-PrtRE.safetensors` |
| `controlnet` | string | controlnet | ControlNet 模型名，默认 `control_v11p_sd15_canny_fp16.safetensors` |
| `strength` | number | controlnet | 控制强度，默认 0.8，钳到 0.1~1.0 |
| `width` / `height` | number | generate/controlnet | 默认 512 / 768，钳到 256~1024 |
| `steps` | number | generate/controlnet | 默认 25，钳到 4~60 |
| `cfg` | number | generate/controlnet | 默认 7，钳到 1~20 |
| `seed` | number | generate/controlnet | 不传则随机（`Math.random()*2**31`） |
| `outPath` | string | generate/controlnet | 输出文件路径；**必须落在 `outputDir` 内**，否则 `BAD_INPUT` |

返回结构：

| action | 成功 | 失败 |
|---|---|---|
| `status` | `{action, up:true, baseUrl, version, gpu, vramFreeMb, vramTotalMb, checkpoints[], controlnets[], defaultCheckpoint, defaultControlnet}` | `{action, up:false, baseUrl, error}`（不抛错） |
| `generate` / `controlnet` | `{action, ok:true, path, bytes, elapsedMs, seed, promptId, sourceFile}` | `{action, ok:false, reason, error, promptId?}` |

`reason` 取值：`OFFLINE` / `NOT_CONFIGURED` / `BAD_INPUT` / `REJECTED` / `EXEC_ERROR` / `TIMEOUT` / `NO_OUTPUT` / `NO_FILE` / `IO_FAILED`。

**最重要的一条边界：这个插件不启动 ComfyUI。**

ComfyUI 是常驻推理服务，占 GPU、会和 Ollama 抢那 8GB 显存。什么时候开、什么时候关归用户决定。服务没起时工具只报 `OFFLINE` 并告诉你启动命令在哪，**不会自己去拉起进程**（`lib/tools.js:208-215`）。

## 触发条件

**什么时候会被用到**：用户要「生成一张图 / 画一张 / 按这张参考图重画（换表情、换衣服、微调姿势）」且在本地出图；或者需要确认本地绘图服务还在不在、显存够不够、有哪些模型可选（先用 `action=status`）。图里要准确文字、要图表、要排版，不走这里。

**跑起来依赖的前置**：

1. **ComfyUI 已在跑**，地址由 `config.json` 的 `baseUrl` 决定，默认 `http://127.0.0.1:8188`（`index.js:26`）。连不上就一律 `OFFLINE`，插件不拉起、不重启、不重试。
2. **模型目录挂上了**：底模与 ControlNet 在 `<comfyui>-aki\{模型,controlnet}`，靠启动参数 `--extra-model-paths-config` 挂进来（见下节）。没挂 → `object_info` 里模型列表为空，`ckpt` / `controlnet` 传什么都会被 ComfyUI 拒收（`REJECTED`）。
3. **两个目录对齐**：`comfyOutputDir` = ComfyUI 的 `--output-directory`，`comfyInputDir` = `--input-directory`。没配 → `NOT_CONFIGURED`；配了但对不上 → 出图后 `NO_FILE`（`lib/tools.js:175-180`、`249-257`）。
4. **开关**：`config.json` 的 `enabled` 为 `false` 时**整个插件不注册工具**（`index.js:107-110`）；改成 `true` 需要重启宿主才生效（`config.json` 在 `apply` 时读一次，`index.js:34-40`）。
5. **宿主 tools 服务就绪**：插件启动后在 60s 内等 `ctx.get('tools')`，等不到就放弃注册并记日志（`index.js:59-89`）。

## 前置条件

ComfyUI 必须用这几个参数启动，且目录要和 `config.json` 对上：

```powershell
$base = '<comfyui>-aki\ComfyUI-aki-v2\ComfyUI-aki-v2'
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'
$env:GIT_PYTHON_GIT_EXECUTABLE="$base\git\cmd\git.exe"; $env:GIT_PYTHON_REFRESH='quiet'
Set-Location "$base\ComfyUI"
& "$base\python\python.exe" -u main.py --listen 127.0.0.1 --port 8188 `
  --extra-model-paths-config '<workspace>\dsh-plugins\dsh-comfy\extra-model-paths.yaml' `
  --output-directory '<workspace>\_tmp\comfy-output' `
  --input-directory  '<workspace>\_tmp\comfy-input' `
  --temp-directory   '<workspace>\_tmp\comfy-temp' `
  --user-directory   '<workspace>\_tmp\comfy-user' `
  --disable-auto-launch
```

三个参数不能省，原因都踩过：

| 参数 | 不设会怎样 |
|---|---|
| `PYTHONIOENCODING=utf-8` | rgthree 输出 emoji → `UnicodeEncodeError: gbk codec`，进程直接崩 |
| `--temp-directory` 等四个目录指到工作区 | 写 `ComfyUI\temp` 报 `WinError 5`（沙箱只让写工作区） |
| `--extra-model-paths-config` | 模型全在 `<comfyui>-aki\{controlnet,模型}` 外层，不挂载就一个模型都看不到 |

## 配置

`config.json`（代码默认值见 `index.js:24-32`，下表「现值」是仓库里这份 `config.json` 的内容）：

| 字段 | 代码默认 | 现值 | 说明 |
|---|---|---|---|
| `enabled` | `true` | `true` | 关掉就不注册工具 |
| `baseUrl` | `http://127.0.0.1:8188` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `outputDir` | 空 → `path.join(process.cwd(),'out','comfy')` | `<workspace>\out\comfy` | 插件把图复制到这里；`outPath` 也只能落在这棵树下 |
| `comfyOutputDir` | 空 → 直接 `NOT_CONFIGURED` | `<workspace>\_tmp\comfy-output` | **必须等于 ComfyUI 的 `--output-directory`** |
| `comfyInputDir` | 空 → controlnet 直接 `NOT_CONFIGURED` | `<workspace>\_tmp\comfy-input` | **必须等于 ComfyUI 的 `--input-directory`** |
| `defaultCheckpoint` | `anything-v5-PrtRE.safetensors` | 同左 | 默认底模 |
| `defaultControlnet` | `control_v11p_sd15_canny_fp16.safetensors` | 同左 | 默认 ControlNet |

注意 `comfyOutputDir` / `comfyInputDir` 的**代码默认是空字符串**：删掉这两行不会退回某个路径，而是 `generate` / `controlnet` 一律 `NOT_CONFIGURED`。

## 可用底模（全部 SD1.5，与现有 ControlNet 兼容）

放在 `<comfyui>-aki\模型`，由 `extra-model-paths.yaml` 挂到 ComfyUI 的 `checkpoints`：

| 文件 | 体量 | 定位 |
|---|---|---|
| `anything-v5-PrtRE.safetensors` | 1.99GB | 默认值，二次元/插画 |
| `Counterfeit-V3.0_fp16.safetensors` | 3.95GB | 二次元，线条干净、人像稳定 |
| `DreamShaper_8_pruned.safetensors` | 1.99GB | 通用半写实，场景/风景/人物都行 |

调用时 `ckpt` 传文件名即可；不传则用 `config.defaultCheckpoint`。**加新底模只做两件事**：文件丢进上述目录 → 重启 ComfyUI（它只在启动时扫一次模型目录，热加不认）。

下载走 `tools\download-model.mjs`（断点续传 + safetensors 头校验），示例 source 用 `https://hf-mirror.com/<repo>/resolve/main/<file>`。

## 一个实现细节

ControlNet 用的是 ComfyUI **原生 `Canny` 节点**，不是 `controlnet_aux` 那一堆预处理器。原因：`_aux` 的 `LineArtPreprocessor` 之类要先下载外部权重并写进 `custom_nodes\comfyui_controlnet_aux\ckpts`，沙箱里会 `WinError 5`。原生 Canny 不需要任何权重（`lib/comfy.js:158-164`）。

## 实测数据（RTX 4060 Laptop 8GB，2026-11-01 实测）

| 场景 | 耗时 |
|---|---|
| txt2img 冷启动首张 | ~60s（含模型加载约 50s） |
| txt2img 模型已驻留 | 6~12s |
| ControlNet（Canny, 512×768, 20 步） | 12.1s |

冷启动很贵，**批量任务要合并提交，不要一张一张串行调**。

## 已知限制

每条都对应代码里的一个 guard 或 catch，不是泛泛而谈：

1. **不启动、不重启、不重试服务**：`systemStats` 失败即返回 `OFFLINE`，没有拉起进程的分支（`lib/tools.js:208-215`、`lib/comfy.js:92-94`、`107`）。
2. **目录没配就连网都不试**：`comfyOutputDir` 为空直接 `NOT_CONFIGURED`；`controlnet` 另需 `comfyInputDir`，ControlNet 模型名解析不出来也归 `NOT_CONFIGURED`（`lib/tools.js:175-180`、`234`）。
3. **参考图必须是真图片**：按文件头判 PNG/JPEG/GIF/BMP/WebP，不信扩展名，否则 `BAD_INPUT`——这是为了拦住「把任意文件复制进 ComfyUI input 目录」构成任意文件读取（`lib/tools.js:186-197`、`looksLikeImage` 22-42）。
4. **`outPath` 出不了输出目录**：`path.relative` 判定越界或绝对路径一律 `BAD_INPUT`，防止被提示词注入后覆盖任意文件（`lib/tools.js:260-274`）。
5. **数值参数被静默钳制，不报错**：`width`/`height` 256~1024、`steps` 4~60、`cfg` 1~20、`strength` 0.1~1.0；传 0 或 2000 不会失败，只会被改成边界值（`lib/tools.js:222-232`）。`Number(args?.steps) || 25` 这类写法还意味着**传 0 会被当成「没传」用默认值**。
6. **等待上限硬编码**：`generate` 150s、`controlnet` 200s，到点回 `TIMEOUT` 且不重试；工具级 `timeoutMs` 是 240000（`lib/tools.js:242`、`145`、`lib/comfy.js:102-124`）。
7. **`NO_FILE` 几乎总是目录没对齐**：`/history` 说有图但磁盘上找不到，只重试 10 次 × 200ms 就放弃（`lib/tools.js:249-257`、`73-80`）；`comfyOutputDir` 指向 `_tmp` 被清理后也会这样——要长期稳定就把 ComfyUI 的 `--output-directory` 和这个配置一起挪到 `<workspace>\out\comfy-io` 这类非临时目录。
8. **没有 SaveImage 节点就是白跑**：任务成功但 `outputs` 里没有图片 → `NO_OUTPUT`（`lib/tools.js:245-248`、`lib/comfy.js:126-134`）。
9. **错误详情会被截断**：ComfyUI 拒收只回前 400 字符（`lib/comfy.js:92-98`），执行期异常只回 `exception_message` 前 500 字符（`lib/comfy.js:111-116`）；模型名写错是最常见原因，得靠这段文本自己判。
10. **并发不安全**：`isConcurrencySafe: () => false`（`lib/tools.js:146`），同时提交多个任务会在同一张卡上互抢显存。
11. **注册只等 60s**：宿主 `tools` 服务 60s 内没就绪就永久放弃注册，只记一行日志（`index.js:70-89`）。
12. **`enabled=false` 是整体熄灯**：不注册任何工具，且配置只在 `apply` 时读一次，改完要重启宿主（`index.js:103-110`）。

能力边界（非代码 guard，附来源）：只回 PNG 路径、不回 base64（`lib/tools.js:283-291`）；SD1.5 不会写字，图里要准确文字请用 `dsh-draw` 的 `draw(kind=chart)`；与 Ollama 同开 8GB 显存会 OOM（`capability.json:12-13`）。

## 测试

本机 `node` 不在 PATH，必须用 DSH 自带的那个：

```powershell
$node = '<你的 DSH 自带 node.exe 路径>'
& $node 'tests\run-all.mjs'   # 离线路径，21 项（offline 9 + apply 12），不需要 ComfyUI
& $node 'tests\live.mjs'      # 在线链路，需要 ComfyUI 已经跑起来
```

`live.mjs` 单独跑是故意的：它依赖外部服务的生命周期，不该混进每次回归。

## 变更记录

- 2026-11-10 · 0.1.1：README 重写到与代码一致，补全工具列表/触发条件/已知限制。
- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-01 · 0.1.0 · 首个版本：`comfy_status` / `comfy_generate` / `comfy_controlnet`，原生 Canny 替代 `_aux` 预处理器。
- 2026-11-01 · 工具合并：`comfy_status` / `comfy_generate` / `comfy_controlnet` 合并为单入口 `comfy(action=status|generate|controlnet)`；旧名不再注册。
- 2026-11-01 · 底模扩到 3 个：新增 `Counterfeit-V3.0_fp16`（二次元）与 `DreamShaper_8_pruned`（通用半写实），默认仍是 anything-v5；补 `tools\download-model.mjs` 下载器与「可用底模」小节。
