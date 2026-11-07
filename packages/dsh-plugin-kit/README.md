# dsh-plugin-kit

自研 DSH 插件共用的最小工具集。不是插件，不注册任何工具、路由或服务，只被其他插件 `import`。

## 为什么要有它

阶段 0 的体检发现：19 个插件各自带一份 `lib/lifecycle.js`（两份只差换行符），3 个插件各带一份完全相同的 `lib/atomic-write.js`。改一处就得改 19 处，漏一个就分叉。

阶段 1.1 把它们收到这里，全仓只剩一份实现。

## 现在提供什么

| 导出 | 路径 | 说明 |
| --- | --- | --- |
| `lifecycle(ctx, create)` | `dsh-plugin-kit/lifecycle` | 每个 ctx 一份状态实例；`own / later / dispose`，随 ctx 卸载自动释放 |
| `atomicWrite(file, data, encoding)` | `dsh-plugin-kit/atomic-write` | 临时文件 → fsync → rename；崩溃只留旧文件或新文件 |
| `atomicWriteJson(file, value, indent)` | `dsh-plugin-kit/atomic-write` | 上者的 JSON 便捷版 |
| `note(dir, message, opts)` | `dsh-plugin-kit/note` | 一行 `load.log` 追加；`{ file, mkdir }` 控制文件名与是否建目录 |
| `toolsOrRetry(ctx, st, retry, opts)` | `dsh-plugin-kit/wait-for-tools` | 等宿主 tools 服务就绪；250ms 重试、最多 120 秒（2026-11-04 从 60 秒上调），重试排在 `st.later` 里随卸载停止 |
| 桌宠助手（`petStatus` / `startPet` / `stopPet` / `switchForm` / `readPetConfig` / `writePetConfig` / `readState` / `writeState` / `DEFAULT_PET_DIR` / `defaultPythonw`） | `dsh-plugin-kit/pet` | 桌宠进程与配置读写。2026-11-04 从 pet-hub / pet-sync 的两份完全相同的副本合并而来，单一真源 |
| 进程助手（`classifyProcess` / `listOwnProcesses` / `stopOwnProcess` / `isAlive` / `portOpen` / `KINDS`） | `dsh-plugin-kit/process` | 自有 OS 子进程统一视图与安全停止：只认 pet / mindLoop / verifyx 三类，SnowLuma 只做端口探测；停进程前必须校验 pid 在自有清单内（防误杀宿主）。2026-11-04 由 pet.js / autostart.js / playground.js 三处重复实现收编 |

各插件的 `note(message)` 保留原签名，只是变成一行薄包装（`kitNote(HERE, message) / kitNote(DIR, message, { mkdir: true })`），调用点零改动。

`toolsOrRetry` 从 screenshot / memory-unified / qq-adapter 三处重复实现收进来；超时文案和重试失败文案由调用方通过 `warn` / `log` 传入，各包措辞不变。

## 怎么被解析（重要）

如果 npm/pnpm 不在 PATH，插件目录通常是用 `link:` 挂进 profile 的，模块解析沿真实路径向上找 `node_modules`。所以：

```
<你的 dsh-plugins 目录>\node_modules\dsh-plugin-kit  →  junction 指向  ..\dsh-plugin-kit
```

这条 junction 是解析的唯一依赖。它**不在** profile 的 `node_modules` 里，pnpm 重装 profile 不会动它；但如果删除 `<你的 dsh-plugins 目录>\node_modules`，所有插件会立刻 `ERR_MODULE_NOT_FOUND`。重建命令：

```powershell
New-Item -ItemType Directory -Force '<你的 dsh-plugins 目录>\node_modules' | Out-Null
cmd /c mklink /J "<你的 dsh-plugins 目录>\node_modules\dsh-plugin-kit" "<你的 dsh-plugins 目录>\dsh-plugin-kit"
```

## 用法

```js
import { lifecycle } from 'dsh-plugin-kit/lifecycle'
import { atomicWrite } from 'dsh-plugin-kit/atomic-write'
```

不要在本包内部这样 import 自己（会自引用）；包内一律用相对路径 `./lib/xxx.js`。

## 迁移记录

- 2026-11-03：建包；19 个插件改 import 并删除各自的 `lib/lifecycle.js`，3 个删 `lib/atomic-write.js`；删前备份到 `github/backups/<时间戳>-kit-migration/`。
- 2026-11-03：`note()` 收进来（19 个包变薄包装，dialog/brain/finance-learn/group-knowledge 带 `mkdir` 或自定义文件名）；`toolsOrRetry()` 替换 screenshot / memory-unified / qq-adapter 三处重复的 tools 重试。
- 2026-11-04：`process.js` 收编进程管理（`listOwnProcesses` / `stopOwnProcess` / `isAlive` / `portOpen`）；`pet.js` 的 `listPetProcesses` / `stopPet` 改为委托它，不再自带 PowerShell 与 taskkill；qq-adapter / service-autostart 的 `portOpen` / `pidAlive`、playground 的 `isAlive` / `portOpen` 一并改为薄包装。`--profile verifyx` 只认参数形态，路径里出现 verifyx 不算。

- 2026-11-04：`pet.js` 修 `DEFAULT_PET_DIR` 在 junction 下解析成 `node_modules\_pets` 的问题（realpath 不可靠，改为按 `run_pet.py` 探测候选目录）；`startPet` 前调 `clearStalePetState` 清过期 `pet.pid` 与 `state.json` 的 running；启动超时附 `pet-instance.log` 尾行。

- 2026-11-04：新增 `interaction-plan.js`（`detectActivity` / `planInteraction`，纯函数），brain 的 `classifyIntent` 输出 `activity`，qq 的回复提示按活动加动态段（稳定段不动，保前缀缓存）。
