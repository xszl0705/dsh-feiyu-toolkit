# dsh-fyrunner

把 **FyRunner 跑团引擎**托管成 DSH 原生工具：DSH 里直接起停本地服务、查状态、开窗、看日志，不用再双击 bat、也不用装 pywebview。

## 为什么不是一个窗口

原版 FyRunner 是 `app.py` + pywebview 的独立桌面窗口，依赖 `pip install pywebview`。
本插件把它降级成**被托管的 headless 本地服务**：

- 只跑 `runtime/run.py`（内部 exec `server.py`），纯 Python 标准库，零第三方依赖
- 界面用默认浏览器打开 `http://127.0.0.1:8760`
- 日志由 Python 侧写 `runtime/.python.log`，Node 侧不接管道（沙箱下管道/句柄会 EPERM）

## 工具

只有一个 `fyrunner`，用 `action` 分派：

| action | 作用 |
|---|---|
| `status` | 查运行状态：端口、pid、版本、MOD 数、当前模型 |
| `start` | 起服务（已在跑则直接返回，幂等） |
| `stop` | 停服务（先 `process.kill`，不行再 `taskkill /T /F`） |
| `open` | 起服务并用默认浏览器打开 |
| `restart` | 先停再起 |
| `logs` | 看 `runtime/.python.log` 尾部（`lines` 控制行数） |

## 配置（插件根 `config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | `""` | 留空则自动探测（`%LOCALAPPDATA%\Programs\Python\Python31x` → `C:\Python31x` → PATH 里的 `python`） |
| `port` | `8760` | 首选端口；被占则从该端口向后找 20 个 |
| `dataDir` | `""` | 留空 = `runtime/data`；填了就通过 `FYRUNNER_DATA` 传给 Python |
| `startTimeoutMs` | `20000` | 等 `/api/health` 就绪的上限 |

模型与采样在 **`runtime/config.json`**（FyRunner 自己的配置），默认走本机 Ollama：

```json
{ "provider": "ollama", "ollama_url": "http://127.0.0.1:11434", "ollama_model": "qwen38-27b-rp:latest", "max_tokens": 8192 }
```

想换 DeepSeek API：`provider` 改 `api`、填 `api_key`，`api_model` 默认 `deepseek-flash`。

## 数据

```
runtime/
├─ run.py / server.py / judge.py / assemble.py
├─ web/                    前端（原生 JS，无构建）
├─ data/
│  ├─ mods/                9 个 MOD（打包自带）
│  ├─ scripts/ characters/ worldbook/ sessions/   ← 首次启动自动创建
├─ .python.log             运行时日志
└─ .runtime.json           最近一次启动的 pid/端口记录（宿主重启后丢了也不影响 status）
```

## 已知限制

1. **不含 pywebview 窗口**：要窗口就自己 `pip install pywebview` 后跑原版 `app.py`。
2. **stop 只认自己起的实例**：pid 从 `/api/health` 拿；拿不到就报错，不盲杀。
3. **不做开机自启**：重大开关归用户，要自启请自行放进启动项。
4. `runtime/data` 里是成人向 RP 内容（MOD 写作包），对外分发前注意分级。
5. 分享模式默认关（完整功能）。要只读内容核，起服务前设 `FYRUNNER_SHARE=1`。

## 变更记录

- **2026-11-07** 从 `FyRunner_分享版.zip` 移植。改动：`SHARE` 改为读环境变量、`DATA` 支持 `FYRUNNER_DATA`、`/api/health` 返回 pid/port、新增 `run.py` 做日志重定向；去掉 `app.py`（pywebview）与分享版文档。
- **2026-11-07** 修 `action=logs` 返回 `undefined` 字段导致宿主报 `value is not lossless JSON`（宿主重启后生效）。
- **2026-11-08** 修「Failed to fetch」：`call_ai` 改为流式读取并默认关思考（`think:false`），qwen3:8b 单次调用从 19.3s 降到 1s；新增 `POST /api/chat/stop`（真停：断开上游 Ollama 连接即取消推理）、`GET /api/chat/tail?rid=&from=`（生成中增量预览）；`/api/chat` 接受 `request_id`，中途停止时本轮不写会话；前端发送时显示「■ 停止」按钮和实时正文。兜底 `except` 不再把客户端断开（WinError 10053）误报成「连接失败」。
- **2026-11-08** `provider=api` 但 `api_key` 为空时返回明确提示「未填写 API Key」，不再抛裸 401。
- **2026-11-08** 云端分支（OpenAI 兼容 / DeepSeek）改 SSE 流式：`stream:true` + 逐行解析 `data:`，此前非流式导致预览一次性蹦出整段、停止要等整轮生成完。实测云端 18.6s / 1309 字、chunk 逐块增长；停止从发起到请求返回 409 仅 0.03s。`/api/chat/tail` 额外返回 `chunks`（累计块数）与 `dbg`（上游状态码/传输方式/内容类型）用于诊断。
- **2026-11-08** 加一致性机制：①续写拼接去重（`join_continuation`，尾部 15 字以上重叠自动裁掉，实测轮内重复由 2 处降为 0）；②状态卡（每轮额外一次小调用输出「时间/地点/在场/随身/关系/悬念」六行，存 `session.state_card`，注入 system **绝对末尾**并附五条硬性约束）；③滚动前情（历史超 15000 字时，把最早几轮压成 250 字 `session.recap`，原文进 `session.archived_history`，不再硬截断丢弃）。默认温度 0.85 → 0.65。
