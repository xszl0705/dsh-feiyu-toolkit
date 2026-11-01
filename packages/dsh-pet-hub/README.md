# dsh-pet-hub

把「心情挂件」「朗读桥卡片」「大肥鱼桌宠」合成**一张浮层卡片**。

**当前是第一步：只启用宿主半端（HTTP 端点）。** 客户端浮层（`client.js`）暂不声明 `dsh.client`，
等页面加载通道验证通过再开 —— 昨晚正是这一步没验就重启，导致插件首载抛错。

## 端点

| 路径 | 说明 |
|---|---|
| `GET /dsh-pet-hub/status` | 桌宠状态 + 心情值（读 `~/.dsh/feiyu-mood/state.json`） |
| `POST /dsh-pet-hub/pet` | `{"action":"start\|stop\|form","form":"pet\|widget"}` |
| `GET /dsh-pet-hub/client.js` | 浮层脚本源码（方便手工注入/调试） |

## 已修掉的三处致命问题

1. 缺 `export const inject = ['webServer']` → `cannot get property "webServer" without inject`
2. `ctx.logger?.('info')?.(...)` 调用签名错（logger 是对象）→ 统一 `safeLog`
3. `apply()` 抛错会冒到宿主 → 外层 try/catch，异常落到同目录 `hub-error.log`

## 配置

```json
{ "petDir": "", "pythonw": "" }
```

留空按 `dsh-pet-sync` 的规则解析（`<dsh-plugins>/_pets/deepseek-dafeiyu-pet`）。

## 第二步（未做）

`client.js` 现在是一个普通 IIFE。要挂进页面，需要确认 DSH 桌面端的注入通道：
- 要么按 `dsh.client` 的模块约定改写成 `window.__ModuleLoader__.load({...})`
- 要么照朗读桥的做法走 webserver 的 `index-inject` 表（`script-src` 行）

两条都得先在页面上试通，再写进 `package.json`。

## 使用说明

**什么时候用**

- 桌宠 UI 需要状态 → `GET /dsh-pet-hub/status`
- 前端要客户端脚本 → `GET /dsh-pet-hub/client.js`
- 桌宠说话写留痕 → `POST /dsh-pet-hub/line`

**接口**

| 路由 | 作用 |
|---|---|
| `/dsh-pet-hub/status` | 桌宠状态 JSON |
| `/dsh-pet-hub/pet` | 宠物资源 |
| `/dsh-pet-hub/client.js` | 客户端注入脚本 |

**什么时候别用**

- 只监听本机，别暴露到公网
- 不提供任意文件读取，别加这种口子
- 它和 `pet-sync` 各有一份 `pet.js`，改一个必须同步另一个（有测试盯着）
