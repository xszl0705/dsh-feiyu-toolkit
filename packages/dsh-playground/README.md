# dsh-playground

试验区管理。把「装插件前先进隔离 profile 验证」这条规则，从人的记性变成工具。

## 为什么要有它

2026-10-31 的事故：一次性往 desktop 的 bundles 加了 5 个市场插件，其中一个注册的工具名和现有插件撞了，宿主把整个 bundles 从 19 重置为 2——20 个插件同时熄灭。

之后定了一条规则：**涉及本体变动，先在试验区验证**。

但执行起来有三个障碍：

1. **工具里拉不起进程**——DSH 工具启动的子进程继承 agent 沙箱，`powershell`、第二个 DSH 实例都会被 EPERM 拦下
2. **profile 选不对**——环境变量 `DSH_PROFILE` 不参与启动，那是宿主启动后自己设的
3. **靠人记不可靠**——每次都要翻文档

这个插件把三件事一起解决：跑在宿主进程里（不受沙箱限制）、封装正确的 CLI 调用、把流程做成工具。

## 工具

只有一个入口 `playground`，用 `action` 分发（旧名不再注册）。

| 调用 | 干什么 |
|---|---|
| `playground({action:"status"})` | 试验区在不在跑、pid、端口、url |
| `playground({action:"start", profile?, port?})` | 启动隔离实例（默认 verifyx:3080） |
| `playground({action:"stop"})` | 停掉（只杀自己记的 pid） |
| `playground({action:"check", profile?})` | 跑 `--dump-config`，列出实际会加载的插件条目 |
| `playground({action:"conflicts", profile?})` | 扫插件树里的工具名/服务名重名——2026-10-31 的「全灭」事故就是两个插件抢同一个工具名 |
| `playground({action:"install", packageName, sourceDir?, profile?})` | 装插件进试验区：备份 → 改 deps/bundles → 建 junction → 自检 |

## 接口

单入口参数按 action 取值；只有 `action` 必填。

| 参数 | 类型 | 用在哪 | 说明 |
|---|---|---|---|
| `action` | string | 全部 | `status` / `start` / `stop` / `check` / `conflicts` / `install` |
| `profile` | string | start/check/conflicts/install | profile 名，默认 `verifyx` |
| `port` | number | start | 端口，默认 3080 |
| `packageName` | string | install | 插件包名，如 `dsh-feiyu-look`；install 必填 |
| `sourceDir` | string | install | 源码目录，`link:` 安装时必填，如 `<你的插件源码目录>` |

返回对象带 `action` 回显；未知 action 返回 `{ ok: false, action, error: '未知 action：…' }`。

## 典型流程

```
1. playground({ action: 'check', profile: 'verifyx' })        # 先看现在装着什么
2. playground({ action: 'install', packageName: 'xxx', sourceDir: '...' })
3. playground({ action: 'start', profile: 'verifyx' })        # 起在 3080
4. 浏览器打开 http://127.0.0.1:3080/ 看 UI
5. playground({ action: 'stop' })
6. 验证通过后，才考虑进 desktop
```

## 三条铁律（都踩过）

| 坑 | 正确做法 |
|---|---|
| 用 `DSH_PROFILE` 环境变量切 profile | 只能靠 `--profile <name>`，环境变量无效 |
| `dsh --profile verifyx web` | 不能加 app 名，profile 自己决定 app，多参数报 `too many arguments` |
| `.ps1` 里写中文 | PowerShell 5.1 按 ANSI 读，中文乱码破坏引号；脚本要么全 ASCII 要么带 BOM |

## 安全边界

- **默认只动 verifyx**——要动 desktop 必须显式传 `profile: 'desktop'`
- **只杀自己记的 pid**——绝不按进程名全杀（会把 desktop 一起带走）
- **apply 时不启动任何东西**——必须显式调用
- 装插件前先备份 `package.json` 到 `backups/<时间戳>-before-<包名>-in-<profile>`

## 测试

```bash
node tests/playground.test.mjs
```

## 变更记录

- 2026-11-01：启动实例的 stdout/stderr 从丢弃改为落盘 `<profileDir>/boot.log`（append、超 512KB 截断）。原因：stdio 'ignore' 下 verifyx 起不来时毫无线索，排查无从下手。
- 2026-11-01：六个工具（`playground_status`/`playground_start`/`playground_stop`/`playground_check`/`playground_conflicts`/`playground_install`）合并为单个 `playground`（`action` 分发，参数与默认值不变），压工具定义 token；旧名不再注册。