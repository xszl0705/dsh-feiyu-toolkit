# dsh-comfy

接本地 ComfyUI。单入口工具 `comfy(action=…)`：

| 工具 | 用途 |
|---|---|
| `comfy` | `action=status` 服务在不在、显存、有哪些底模与 ControlNet；`action=generate` 文生图；`action=controlnet` 用参考图锁构图重绘（表情差分、换装、姿势微调） |

**最重要的一条边界：这个插件不启动 ComfyUI。**

ComfyUI 是常驻推理服务，占 GPU、会和 Ollama 抢那 8GB 显存。什么时候开、什么时候关归用户决定。服务没起时工具只报 `OFFLINE` 并告诉你启动命令在哪，**不会自己去拉起进程**。

## 接口

| 调用 | 参数 |
|---|---|
| `comfy(action="status")` | 无参；回 `up` / `version` / `gpu` / `vramFreeMb` / `checkpoints[]` / `controlnets[]` |
| `comfy(action="generate", prompt, …)` | `prompt` 必填；`negative` / `ckpt` / `width` / `height` / `steps` / `cfg` / `seed` / `outPath` 可选 |
| `comfy(action="controlnet", imagePath, prompt, …)` | `imagePath` + `prompt` 必填；`controlnet` / `strength` / `ckpt` / `width` / `height` / `steps` / `seed` / `outPath` 可选 |

## 前置条件

ComfyUI 必须用这几个参数启动，且目录要和 `config.json` 对上：

```powershell
$base = 'E:\SD\ComfyUI-aki\ComfyUI-aki-v2\ComfyUI-aki-v2'
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'
$env:GIT_PYTHON_GIT_EXECUTABLE="$base\git\cmd\git.exe"; $env:GIT_PYTHON_REFRESH='quiet'
Set-Location "$base\ComfyUI"
& "$base\python\python.exe" -u main.py --listen 127.0.0.1 --port 8188 `
  --extra-model-paths-config '<工作区>\dsh-plugins\dsh-comfy\extra-model-paths.yaml' `
  --output-directory '<工作区>\_tmp\comfy-output' `
  --input-directory  '<工作区>\_tmp\comfy-input' `
  --temp-directory   '<工作区>\_tmp\comfy-temp' `
  --user-directory   '<工作区>\_tmp\comfy-user' `
  --disable-auto-launch
```

三个参数不能省，原因都踩过：

| 参数 | 不设会怎样 |
|---|---|
| `PYTHONIOENCODING=utf-8` | rgthree 输出 emoji → `UnicodeEncodeError: gbk codec`，进程直接崩 |
| `--temp-directory` 等四个目录指到工作区 | 写 `ComfyUI\temp` 报 `WinError 5`（沙箱只让写工作区） |
| `--extra-model-paths-config` | 模型全在 `E:\SD\ComfyUI-aki\{控制网,模型}` 外层，不挂载就一个模型都看不到 |

## 配置

`config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就不注册工具 |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `outputDir` | `<工作区>\out\comfy` | 插件把图复制到这里 |
| `comfyOutputDir` | `<工作区>\_tmp\comfy-output` | **必须等于 ComfyUI 的 `--output-directory`** |
| `comfyInputDir` | `<工作区>\_tmp\comfy-input` | **必须等于 ComfyUI 的 `--input-directory`** |
| `defaultCheckpoint` | `anything-v5-PrtRE.safetensors` | 默认底模 |
| `defaultControlnet` | `control_v11p_sd15_canny_fp16.safetensors` | 默认 ControlNet |

## 可用底模（全部 SD1.5，与现有 ControlNet 兼容）

放在 `E:\SD\ComfyUI-aki\模型`，由 `extra-model-paths.yaml` 挂到 ComfyUI 的 `checkpoints`：

| 文件 | 体量 | 定位 |
|---|---|---|
| `anything-v5-PrtRE.safetensors` | 1.99GB | 默认值，二次元/插画 |
| `Counterfeit-V3.0_fp16.safetensors` | 3.95GB | 二次元，线条干净、人像稳定 |
| `DreamShaper_8_pruned.safetensors` | 1.99GB | 通用半写实，场景/风景/人物都行 |

调用时 `ckpt` 传文件名即可；不传则用 `config.defaultCheckpoint`。**加新底模只做两件事**：文件丢进上述目录 → 重启 ComfyUI（它只在启动时扫一次模型目录，热加不认）。

下载走 `tools\download-model.mjs`（断点续传 + safetensors 头校验），示例 source 用 `https://hf-mirror.com/<repo>/resolve/main/<file>`。

## 一个实现细节

ControlNet 用的是 ComfyUI **原生 `Canny` 节点**，不是 `controlnet_aux` 那一堆预处理器。原因：`_aux` 的 `LineArtPreprocessor` 之类要先下载外部权重并写进 `custom_nodes\comfyui_controlnet_aux\ckpts`，沙箱里会 `WinError 5`。原生 Canny 不需要任何权重。

## 实测数据（RTX 4060 Laptop 8GB）

| 场景 | 耗时 |
|---|---|
| txt2img 冷启动首张 | ~60s（含模型加载约 50s） |
| txt2img 模型已驻留 | 6~12s |
| ControlNet（Canny, 512×768, 20 步） | 12.1s |

冷启动很贵，**批量任务要合并提交，不要一张一张串行调**。

## 已知限制

- 不写中文/文字——SD1.5 不会写字，图里要准确文字请用 `dsh-draw` 的 `draw_card`。
- 分辨率 512~768 为宜；SDXL 底模缺失，上限就在这。
- 与 Ollama 同开会 OOM（qwen3:4b 常驻约 2.7GB）。
- 内容审核：本地模型没有云端审核，但对外发布仍要自己把握。
- **`comfyOutputDir` 默认指向 `<工作区>\_tmp\comfy-output`**——那是临时工作目录，被清理后插件会报 `NO_FILE`。要长期稳定就把 ComfyUI 的 `--output-directory` 和这个配置一起挪到 `<工作区>\out\comfy-io` 这类非临时目录。

## 测试

本机 `node` 不在 PATH，必须用 DSH 自带的那个：

```powershell
$node = '<你的 DSH 自带 node.exe 路径>'
& $node 'tests\run-all.mjs'   # 离线路径，24 项，不需要 ComfyUI
& $node 'tests\live.mjs'      # 在线链路，需要 ComfyUI 已经跑起来
```

`live.mjs` 单独跑是故意的：它依赖外部服务的生命周期，不该混进每次回归。

## 变更记录



- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-01 · 0.1.0 · 首个版本：`comfy_status` / `comfy_generate` / `comfy_controlnet`，原生 Canny 替代 `_aux` 预处理器。
- 2026-11-01 · 工具合并：`comfy_status` / `comfy_generate` / `comfy_controlnet` 合并为单入口 `comfy(action=status|generate|controlnet)`；旧名不再注册。
- 2026-11-01 · 底模扩到 3 个：新增 `Counterfeit-V3.0_fp16`（二次元）与 `DreamShaper_8_pruned`（通用半写实），默认仍是 anything-v5；补 `tools\download-model.mjs` 下载器与「可用底模」小节。
