# dsh-service-autostart

服务自愈。从 `dsh-qq-adapter` 抽出来的独立插件。

## 为什么单独成插件

拉起微心跳是**身体层**的事，不是 QQ 渠道的职责。NapCat 已废弃，QQ 桥（SnowLuma）由用户自己起。

之前它寄居在 qq 里，导致：

- qq 卸了，自愈就没了
- 想给别的服务（语音桥、Ollama）加自愈，得改 qq
- qq 一个插件背着感知、表达、记忆、身体四件事

抽出来以后，qq 只在需要时调用服务；服务自己管冷却和失败上限。

## 边界（2026-11-04 方案 v3）

- 只拉起**微心跳**（mind-loop）这类本机脚本；**不拉起 QQ 桥**（SnowLuma 由用户手动开），只探测 3001 端口。
- 周期自动化归 mind-loop；一次性提醒走宿主 `schedule_*`，两者不混。

## 服务

```js
const autostart = ctx.get('autostart') // 或 globalThis[Symbol.for('dsh-service-autostart.service')]

await autostart.ensureServices({ config, state, note })  // 探测桥 + 拉起微心跳 + 拉起 bsk daemon
await autostart.probeBridge({ config })                  // 只看 QQ 桥端口（3001），不拉起
await autostart.ensureMindLoop({ config, state, note })  // 只看微心跳
await autostart.ensureBskDaemon({ config, state, note }) // 只看 bsk daemon（52800），没在跑就拉起
autostart.stats()                                        // 调用次数、最近结果
autostart.portOpen(host, port)                           // 单次端口探测（同步）
```

`config` 传调用方自己的配置（`config.autostart`），本地默认值和它合并，**调用方优先**。

## bsk daemon 自愈（2026-11-05）

BrowserSkill 的 daemon 有个特殊约束：`bsk daemon start`（detached）要求从进程 breakaway，多数 Windows 环境（IDE、启动器、服务宿主）不让，会报 `daemon process still belongs to a Job Object after breakaway`。唯一可靠形态是 `bsk daemon start --foreground`，且必须挂在一个比客户端活得久的宿主进程上。

本插件跑在 DSH 宿主进程里，正好满足，所以：

- 探测 `127.0.0.1:52800`（端口在听 = daemon 活着），在跑就只报 `running`
- 没在跑 → spawn `bsk.exe daemon start --foreground`，**不 detached、不 unref**，`env.BSK_HOME` 显式指向配置的目录
- 冷却 10 分钟，避免反复拉起
- 代价与边界：daemon 是 DSH 的子进程，**DSH 退出它就停**。这是刻意的——DSH 关了，浏览器自动化没有使用方，留个孤儿进程没意义

配置（`config.json`）：

```json
"bsk": {
  "enabled": true,
  "bin": "<workspace>\\_thirdparty\\bsk\\bsk.exe",
  "home": "<workspace>\\_thirdparty\\bsk-home",
  "host": "127.0.0.1",
  "port": 52800,
  "cooldownMs": 600000
}
```

`BSK_HOME` 必须与 daemon 和客户端两端一致，否则客户端会去默认的 `~/.bsk` 找 daemon 而找不到。

## 触发条件

- **挂载即检查一次 bsk daemon**：`apply` 注册完 `autostart` 服务后立刻调一次 `ensureBskDaemon()`（没在跑就以 `--foreground` 拉起）；设 `DSH_AUTOSTART_SKIP_STARTUP=1` 可跳过（`index.js:151`）。
- **总开关**：`config.json` 的 `enabled=false` 时直接不启动，只记一行日志（`index.js:59`）。
- **其余全靠调用方显式触发**：插件自己不挂定时器，只对外提供 `ctx.get("autostart")` 的 `ensureServices` / `probeBridge` / `ensureMindLoop` / `ensureBskDaemon`，由微心跳与 `dsh-qq-adapter` 在各自轮次里调用（`index.js:99`）。
- **调用方配置优先**：调用方传 `config.autostart` 时与本地 `config.json` 合并，`bridge` / `mindLoop` / `bsk` 逐字段覆盖（`index.js:65`）。
- **冷却与销毁**：同一服务冷却期内不重复拉起（微心跳与 bsk 默认各 10 分钟）；`lifecycle` 标记 disposed 后调用直接返回 `{action:"disposed"}`（`index.js:79`）。

## 行为

| 情况 | 动作 |
|---|---|
| 微心跳在跑 | `running`，不拉 |
| 微心跳没在跑 | 拉起（冷却 10 分钟） |
| 桥端口在听 | `up`，只报告，不拉起 |
| 桥端口没人听 | `down`，只报告，不拉起（桥由 SnowLuma 自己维护） |
| bsk 端口（52800）在听 | `running`，不拉 |
| bsk 端口没人听 | 以 `--foreground` 拉起（冷却 10 分钟） |
| bsk 可执行文件不存在 | `missing-binary`，报告路径，不拉 |

## 与 qq 的关系

qq 优先用这个服务，**拿不到就回退自己那份**（`lib/autostart.js` 还在，与这里同构）。

回退不是浪费——是万一这个插件没装/加载失败，微心跳拉起和桥探测还能继续。

## 变更记录

- 2026-11-14 · **mind-loop 改为随宿主生命周期**：`ensureMindLoop` 默认 `launchOwned`（不 detached、不 unref）并通过 `DSH_PARENT_PID` 把宿主 pid 传给子进程；mind-loop 侧新增父进程看护（`DSH_PARENT_CHECK_MS`，默认 30s 一检），宿主退出即清 pid 并退出。原因：detached 残留下来的进程名与宿主同为 `DeepSeek Harness.exe`，宿主退出后仍存活 → 安装器判定「应用在运行」、且 Windows 下运行中的 exe 无法覆盖 → 更新卡在「安装并重启」。实测：伪父 pid 不存在时 4s 内自退且清 pid；父进程存活 5s 仍运行。单测 9/9。`launchHidden` 保留导出但不再用于 mind-loop。改完需重启 DSH 生效。
- 2026-11-05 · 新增 bsk daemon（BrowserSkill，52800）自愈：`ensureBskDaemon` 端口探测 + `--foreground` 拉起（不 detached，随 DSH 生命周期），config 新增 `bsk` 段；单测 9/9。改完需重启 DSH 生效。


- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-04 · 进程与状态归一（阶段 2.4）：`portOpen` / `pidAlive` 改为 `dsh-plugin-kit/process` 的薄包装，行为不变（端口探测与 pid 存活判断语义一致）。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-02 · NapCat 废弃：删除 `ensureNapCat` 拉起逻辑，改为 `probeBridge` 只探测 QQ 桥（SnowLuma，3001）端口；`ensureServices` 只拉起微心跳。配置删 `napcat` 段、加 `bridge` 段。改完需重启 DSH 生效。
- 2026-11-05 · 复核使用说明：`ensureBskDaemon` 端口探测 + `--foreground` 拉起、`config.bsk` 与调用方深合并（`withConfig`）、`launchBsk` 可注入、`portOpen` 暴露，均与「服务 / bsk daemon 自愈 / 行为」章节一致；补这条核对记录。

## 测试

```bash
node tests/service.test.mjs
```
