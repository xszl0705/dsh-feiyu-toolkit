# dsh-pet-sync

桌宠 / 悬浮窗的**生命周期**插件：只管「起没起、怎么起、退出时停掉」，不画界面。

## 工具

| 工具 | 作用 |
|---|---|
| `pet` | 桌宠控制，`action` 选 `status`（在不在跑、形态、尺寸、置顶、配置目录）/ `start`（`form`=pet\|widget）/ `stop` / `form`（切形态，会重启进程生效）/ `say`（`text`≤60 字，替我说一句话） |

## 配置（同目录 `config.json`）

```json
{
  "enabled": true,
  "autoStart": false,
  "stopOnExit": true,
  "form": "pet",
  "petDir": "",
  "pythonw": ""
}
```

- `petDir` 留空 = `<dsh-plugins>/_pets/deepseek-dafeiyu-pet`，也可用环境变量 `DSH_PET_DIR` 覆盖
- `autoStart` 现在默认 **false**：桌宠本体（mdd111 增强版）还没恢复，起来也只会报「petDir 不存在」

## 安全设计

- 找不到 `petDir` / `run_pet.py` / pythonw 时返回错误对象，**不抛异常**
- `apply()` 外层 try/catch：加载失败也只写日志，不影响宿主
- 只在插件卸载/DSH 退出时停自己起的进程（`stopOnExit`）
- `execFile` 的 spawn 失败（如受限环境 EPERM）已兜住，工具会返回「查不到」而不是崩

## 使用说明

**什么时候用**

- 桌宠没反应 → `pet(action="status")` 看进程在不在
- 要拉起来 → `pet(action="start")`；要停 → `pet(action="stop")`
- 要换形态（桌宠 / 悬浮窗）→ `pet(action="form", form="widget")`

**工具**

| 调用 | 干什么 |
|---|---|
| `pet({action:"status"})` | 运行状态、形态、尺寸、配置目录 |
| `pet({action:"start", form})` | 启动（单实例，已在跑就复用） |
| `pet({action:"stop"})` | 停掉（两个形态一起停） |
| `pet({action:"form", form})` | `pet` 桌宠 / `widget` 悬浮窗；会重启进程生效 |
| `pet({action:"say", text})` | 让桌宠替我说一句话（≤60 字），2 秒内念出来 |

**什么时候别用**

- 别为了「刷新一下」反复 start/stop——每次重启都会打断它正在做的事
- `pet_form` 会重启进程，切换前先说一声
- 状态显示没在跑时先看日志，别直接判定坏了

## 单实例：不许分身

出现过一次状态卡重影——两个桌宠同时跑，一个连上 DSH、一个显示「未接入」。根因是单实例探测只有 300ms，桌宠一忙就误判，然后 `removeServer` 把别人的锁摘了。

现在两道判断（`桌宠.py` 的 `main()`）：

1. `QLocalSocket` 探测 **1500ms**：探到就退出
2. **pid 文件兜底**：`pet.pid` 里的进程还活着就拒绝启动

拒绝启动会写 `pet-instance.log`，原因是「pid 还活着但没响应」——那句是给人看的，不是静默退出。

**取舍**：宁可这次不开，也不要出现分身。旧实例卡死时请手动结束它。

## 让桌宠替我说句话

```
DSH → pet-say.jsonl（追加一行 {text}）→ 桌宠每 2 秒读新行 → w.say(text)
```

- DSH 侧：`pet_say` 工具写文件
- 桌宠侧：`_poll_say()` 按 offset 读，不重复念
- 不超过 60 字，长了会被截

这样桌宠不只是「显示我状态的窗口」，也是我在桌面上的嘴。

## 变更记录

- 2026-11-01 · 五个工具（`pet_status`/`pet_start`/`pet_stop`/`pet_form`/`pet_say`）合并为单个 `pet`（`action` 分发），工具定义从 225 token 降到约 110，调用方式改为 `pet({action:"..."})`；旧名不再注册。
