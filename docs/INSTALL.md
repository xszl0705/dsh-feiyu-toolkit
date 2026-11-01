# 安装指南

> 目标：从 clone 到「工具出现在对话里能用」，每一步都可验证。
> 装插件会改 profile 配置，**全程一次只加一个，加完重启验一次**。

## 0. 确认前置

| 需要 | 检查方式 | 没有会怎样 |
|---|---|---|
| DSH 桌面版 | 能打开对话窗口 | 后面都没意义 |
| Node（DSH 自带即可） | 不用自己在 PATH 里装 | 跑测试要用自带那个 |
| Python（仅 dsh-draw 需要） | `python -V`，或用 DSH runtime 里的 | `draw_chart` 报 `PYTHON_NOT_FOUND` |
| ComfyUI（仅 dsh-comfy 需要） | `http://127.0.0.1:8188` 能打开 | `comfy_*` 报 `OFFLINE` |

**本机常见坑**：`node` 和 `python` 都不在 PATH 里，都在 DSH 的 runtime 目录下：

```
<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/node/bin/node.exe
<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/python/python.exe
```

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`。

## 1. 装 dsh-draw（唯一需要补依赖的）

```powershell
pwsh -File scripts\setup-pylibs.ps1
```

它会做三件事：找 Python → 下载 wheel 解压到 `packages\dsh-draw\pylibs\` → 自检 `import matplotlib`。

**为什么不用 `pip install`**：DSH 的沙箱里 pip 写盘会被拒（`Errno 13`），连 `six` 这种纯 Python 包都装不上。所以依赖以解压目录形式存在，运行时通过 `PYTHONPATH` 注入。

装完验证：

```powershell
$env:PYTHONPATH = "packages\dsh-draw\pylibs"
& <python> -c "import matplotlib; print(matplotlib.__version__)"
```

## 2. 装插件到 profile

每个插件都要做两件事：**加依赖** + **加进 bundles**。

### 方式 A：用你的插件管理器

如果你有 `dsh plugin add` 之类的命令：

```powershell
dsh plugin add link:<repo>\packages\dsh-draw
```

### 方式 B：手动改 profile

编辑 `%USERPROFILE%\.dsh\profiles\<你的 profile>\package.json`：

```jsonc
{
  "dependencies": {
    // 加这一行（路径换成你自己的）
    "dsh-draw": "link:C:/path/to/dsh-feiyu-toolkit/packages/dsh-draw"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...原有的...
        "dsh-draw"     // 加这一项
      ]
    }
  }
}
```

**改之前先备份这三个文件**：`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`。

### 然后重启宿主

重启后新会话里应该能看到工具。**装完不一定需要重启**（cordis 有热加载），但重启最稳。

## 3. 逐个验收

装一个验一个，别攒到最后：

| 检查项 | 怎么看 | 不通过说明 |
|---|---|---|
| 工具出现 | 新会话能调 `draw_chart` | bundles 没加或包名写错 |
| 加载日志 | `packages/dsh-draw/load.log` 应该有「N 个工具已注册」 | 文件不存在 = 没加载 |
| 真出一次图 | 让它画个柱状图，**打开文件看** | 返回值 ok 但文件不存在 = 输出目录问题 |
| 断服务路径 | `comfy_status` 在 ComfyUI 没起时应报 `OFFLINE` | 崩了 = 异常没兜住 |

## 4. dsh-comfy 额外配置

它**必须**知道 ComfyUI 的两个目录，否则报 `NOT_CONFIGURED`：

```jsonc
// packages/dsh-comfy/config.json
{
  "baseUrl": "http://127.0.0.1:8188",
  "comfyOutputDir": "C:/path/to/comfy-output",   // = ComfyUI 的 --output-directory
  "comfyInputDir":  "C:/path/to/comfy-input"     // = ComfyUI 的 --input-directory
}
```

**这两个值必须和启动参数一字不差**，对不上会报 `NO_FILE`（图生成了但插件找不到）。

外挂模型配置：

```powershell
Copy-Item packages\dsh-comfy\extra-model-paths.example.yaml packages\dsh-comfy\extra-model-paths.yaml
# 然后改里面的 base_path 指向你的 ComfyUI 整合包
```

## 5. 跑一遍回归

```powershell
$node = '<DSH_HOME>\dsh-runtimes\<runtime>\dependencies\node\bin\node.exe'
& $node packages\dsh-draw\tests\run-all.mjs        # 期望 ALL OK
& $node packages\dsh-comfy\tests\run-all.mjs       # 期望 ALL OK（不需要 ComfyUI）
& $node packages\dsh-comfy\tests\live.mjs          # 需要 ComfyUI 在跑
```

## 6. 出问题怎么查

| 现象 | 先看哪里 |
|---|---|
| 工具没出现 | 插件的 `load.log`；profile 的 `bundles` 有没有这项 |
| `PYTHON_NOT_FOUND` | `config.json` 的 `pythonPath`，或环境变量 `DSH_PYTHON` |
| `NO_RESULT` | `pylibs` 是不是空的，重跑 `setup-pylibs.ps1` |
| `OFFLINE` | ComfyUI 有没有在 8188 上监听 |
| `NO_FILE` | `comfyOutputDir` 和 ComfyUI 的 `--output-directory` 是否一致 |
| 启动直接失败 | **只点「重启」，绝不点「禁用第三方插件」**——那是全灭按钮 |

## 卸载

从 `dependencies` 删掉 `link:` 那行，从 `bundles` 删掉对应项，重启。插件目录留着不影响。

## 可移植性自查

```powershell
& <python> scripts\portability-check.py --root .
```

`blocker = 0` 才算干净。它会揪出硬编码的本机路径。
