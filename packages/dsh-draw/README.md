# dsh-draw

给大肥鱼加「画图」能力。两个工具，一条硬规则：**图里要出现准确数字或文字的，走这里。**

| 工具 | 引擎 | 适合 |
|---|---|---|
| `draw_chart` | matplotlib | 趋势、对比、占比、双指标对照 |
| `draw_card` | Pillow | 卡片、公告、榜单、体检报告 |

不画插画、不做艺术风格——那属于 ComfyUI 或云生图 API，不属于这个插件。

## 为什么是 Python

本机 Node 侧没有可靠的绘图栈；Pillow + matplotlib 已在沙箱里实测可用。插件内真机实测：`draw_chart` 1074ms（1200×630）、`draw_card` 125ms（900×470）。

但本机 `pip` 在沙箱里**写盘被拒**（`Errno 13`），连纯 Python 包都装不上。所以依赖不接受 `pip install`，而是以 **wheel 解压后的目录**形式固化在 `pylibs/`，运行时注入 `PYTHONPATH`：

```
pylibs/          42.3 MB，含 matplotlib 3.9.0 / Pillow 10.4 及其依赖
                 （numpy 不在里面，用 dsh runtime 自带的那份）
lib/py/chart.py  matplotlib 渲染
lib/py/card.py   Pillow 渲染
lib/bridge.js    spawn python，文件当 IPC
```

## 一个必须知道的实现细节

**不能用管道和 Python 通信。** 本机沙箱对 `child_process` 的 piped stdio 返回 `spawn EPERM`（默认 `stdio: 'pipe'`）。所以 `bridge.js` 走文件 IPC：

```
参数写 spec.json → python 读 → 结果写 result.json → JS 读回来
子进程 stdio 全部 ignore
```

这不是绕路，是在这个环境里唯一能跑通的写法。

## 工具用法

### draw_chart

```json
{
  "kind": "bar",
  "labels": ["一月", "二月", "三月"],
  "series": [{ "name": "调用次数", "data": [40, 31, 52] }],
  "title": "月度调用量",
  "ylabel": "次"
}
```

`kind`：`line`（默认）/ `bar` / `pie` / `scatter` / `dual`（第 1 系列柱、第 2 系列线）。

### draw_card

段落卡片：

```json
{ "kind": "card", "title": "标题", "body": "正文，支持 \n 换行", "footer": "页脚" }
```

键值列表（体检报告这类）：

```json
{ "kind": "rows", "title": "体检结果", "rows": [["底模", "anything-v5"], ["显存", "8187MB"]] }
```

两个工具都返回 `{ ok, path, width, height, bytes, elapsedMs }`。**只回路径，不回 base64。**

## 配置

`config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就不注册工具 |
| `outputDir` | `<你的输出目录>` | 默认输出目录，文件按 `chart-<标题>-<时间戳>.png` 命名 |
| `pythonPath` | `""` | 留空则自动探测：环境变量 `DSH_PYTHON` → `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe` |

## 已知限制

- **只画图表和卡片**，不产插画。
- 中文字体依赖系统里的 `msyh.ttc` / `simhei.ttf`，缺了会返回 `NO_FONT`。
- `series[].data` 的数值会按 `Number()` 转换；`null` / 空串保留为空洞，其它非数字会返回 `BAD_INPUT`。
- 单次渲染超时 35s（图表）/ 20s（卡片）。
- `pylibs` 里的 Pillow 是 10.4，比系统自带的 12.3 旧——只影响这个插件的子进程，不影响宿主。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `PYTHON_NOT_FOUND` | 探测不到解释器 | 在 `config.json` 填 `pythonPath`，重启宿主 |
| `NO_RESULT` | Python 起来了但没写结果 | 多半是 `pylibs` 缺失或损坏，重跑 `tests/run-all.mjs` 看细节 |
| `SPAWN_FAILED` / `EPERM` | 又用回了 piped stdio | 检查 `bridge.js` 里 `stdio` 必须是 `'ignore'` |
| 图里中文是方块 | 字体没匹配上 | 装微软雅黑；`chart.py` 会依次尝试 YaHei / SimHei / DengXian |

## 测试

本机 `node` 不在 PATH，必须用 DSH 自带的那个：

```powershell
$node = '<你的 DSH 自带 node.exe 路径>'
& $node 'tests\run-all.mjs'
```

会跑完 3 个 suite（bridge / tools / apply，共 42 项），把结果落到 `tests/_out/result.json`，`allOk=true` 才算过。

## 变更记录

- 2026-11-01 · 0.1.0 · 首个版本：`draw_chart` + `draw_card`，依赖固化，文件 IPC 桥接。
