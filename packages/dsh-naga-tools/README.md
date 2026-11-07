# dsh-naga-tools

参照 [Xxiii8322766509/NagaAgent](https://github.com/Xxiii8322766509/NagaAgent) 的
`mcpserver/agent-*/agent-manifest.json` 契约，把它的三类 agent 能力改写成 **DSH 原生工具**。

不引 Python、不拉 MCP 子进程、不装它那套 UI/语音/图数据库——只搬"能立刻在 DSH 里用"的部分。

## 对照表

| NagaAgent 原模块 | 本插件工具 | 实现差异 |
|---|---|---|
| `mcpserver/agent_open_launcher`（app_launcher） | `naga`（`action=list` / `open`） | 扫开始菜单 `.lnk/.url` 建索引；`action=open` 按名字模糊匹配后 `start` 启动。原项目是缓存应用列表 + 进程拉起。 |
| `mcpserver/agent_weather_time`（weather_time） | `naga`（`action=weather`） | 时间取本机；天气走 `wttr.in?format=j1`（免 Key），支持中英文城市、缺省按 IP 定位。 |
| `mcpserver/system_control` | `naga`（`action=lock` 等固定动作） | 只暴露固定枚举动作：锁屏 / 睡眠 / 关屏 / 音量± / 静音 / 打开设置。**不接受任意命令**。 |

## 为什么只搬这三个

| NagaAgent 模块 | 结论 |
|---|---|
| `mcpserver/agent_device_switch` | 音频输出设备切换要 COM/IAudioPolicyConfig，纯 Node 做不干净；先跳过 |
| `mcpserver/agent_playwright_master` | 浏览器自动化：DSH 侧用 `web_fetch`/`ops_bash` 更稳，不重复造 |
| `mcpserver/agent_word_office` | 一整套 Python MCP + Word 服务端；DSH 已有 `office-docx` 技能，能力重叠 |
| `summer_memory/` | 图记忆（Neo4j + docker-compose + 实体抽取）。我们刚合并的 `dsh-memory-unified` 走的是"文件夹 + α/β"，两套存储会打架，暂不并 |
| `voice/` | 需要麦克风、ASR/TTS 服务与 Edge TTS websocket；属于另一条独立链路 |
| `thinking/` | 树状思考 + 难度判定，是 agent loop 内部的策略，宿主已有 reasoning effort，插件层改不动 |

## 工具契约

只有一个工具 `naga`，靠 `action` 分流（原来的三个工具名不再注册）：

```jsonc
{ "action": "list", "limit": 60 }              // 列开始菜单应用
{ "action": "open", "query": "微信" }           // 模糊匹配并启动，未命中返回候选
{ "action": "weather", "city": "杭州" }         // 省略 city 则按 IP 自动定位
{ "action": "lock" }                           // lock | sleep | screen_off | volume_up | volume_down | mute | open_settings
```

返回对象都带 `action` 回显；未知 action 返回 `{ ok: false, action, error: "未知 action：<action>" }`。

## 安装

```bash
dsh plugin --profile desktop add "link:/path/to/dsh-naga-tools"
```

卸载：

```bash
dsh plugin --profile desktop remove dsh-naga-tools
```

## 验证

```bash
node test/naga-smoke.mjs
```

覆盖：开始菜单索引非空、模糊匹配能命中、天气 JSON 能解析（网络失败时返回 error 而不是抛异常）。

## 安全边界

- 系统动作是**白名单枚举**（`action=lock` 等 7 个），命令串写死在代码里，
  不接受用户拼接——这一点和 NagaAgent 原 `system_control` 的自由度不同，是有意收窄。
- `action=open` 只启动开始菜单里已有的快捷方式，不执行任意路径。
- 天气走的是外部 HTTPS（wttr.in），只发送城市名。

## 使用说明

**什么时候用**

- 要打开本机某个应用 → `naga({ action: 'list' })` 先看有没有，再 `naga({ action: 'open', query })`
- 查时间和天气 → `naga({ action: 'weather' })`
- 锁屏、睡眠、关显示器、调音量、静音、开设置 → `naga({ action: 'lock' })` 等固定动作

**工具**

| 调用 | 参数 |
|---|---|
| `naga({ action: 'list', limit })` | 列开始菜单应用；`limit` 默认 60 |
| `naga({ action: 'open', query })` | `query` 模糊匹配并启动，未命中返回候选 |
| `naga({ action: 'weather', city })` | 不给 `city` 按 IP 定位 |
| `naga({ action: 'lock' })` | 只认白名单：lock / sleep / screen_off / volume_up / volume_down / mute / open_settings |

**什么时候别用**

- 它不是 shell——**不能跑任意命令**，只做固定动作
- 锁屏、睡眠、关机这类操作前先确认，别顺手做
- 天气查不到不算错（外网可能不通），别据此判断网络坏了

## 变更记录



- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-01：把 `naga_app_launcher` / `naga_weather_time` / `naga_system_control` 三个工具合并为单入口 `naga`（`action=list|open|weather|lock|sleep|screen_off|volume_up|volume_down|mute|open_settings`），旧名不再注册；参数名、默认值与系统动作白名单均未变。
