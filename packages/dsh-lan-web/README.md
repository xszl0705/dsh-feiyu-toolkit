# dsh-lan-web

把**桌面客户端**的 DSH 界面开放到局域网：手机/平板连同一个 WiFi，用浏览器就能跟进电脑上同一个会话，不再需要另起一个 DSH 实例（也就不会再出现「当前会话已被占用」）。

## 为什么需要它

三个已核实的事实凑在一起，导致桌面端天然连不上手机：

| 事实 | 出处 |
|---|---|
| 桌面壳启动宿主时写死 `--host 127.0.0.1 --port 0`：只绑回环、端口随机 | `dsh-desktop-host/lib/index.js` 的 `runProfile({ args })` |
| web 服务拒绝 `0.0.0.0`，只接受具体 IP 字面量 | `dsh-host-webserver/lib/index.js` 的 `WebServer.Config.host` 校验 |
| 裸访问返回 401，`launchToken` 只存在于宿主进程内存，不落盘 | 实测 `curl 127.0.0.1:59598/` → `dsh web authentication required` |

所以外部代理拿不到 token，**必须由宿主进程内的插件来做**：取端口、取 token、换 cookie，再监听一个局域网端口转发过去。

## 它做了什么

1. 等 `webServer` / `connection` 两个服务就绪，读 `webServer.port`；
2. `connection.authenticatedUrl()` 拿宿主 launchToken，先换一次 `Set-Cookie` 缓存；
3. 在选出的局域网 IP 上监听（默认 3099），转发 HTTP 与 WebSocket 升级；
4. 转发时把 `Host` 改回宿主绑定地址、注入宿主 cookie，手机侧只认网关自己的口令；
5. `content-type: text/html` 的响应注入 `crypto.randomUUID` 补丁 —— 局域网明文 HTTP 属于非安全上下文，浏览器不给这个 API，前端会白屏。

## 工具

`lan_web`：

| action | 作用 |
|---|---|
| `status` | 返回入口地址（含口令）、监听地址、后端端口、请求/升级计数 |
| `start` | 手动拉起网关（`autoStart=false` 或启动失败后重试） |
| `stop` | 停掉监听，不影响宿主 |

返回里的 `url` 形如 `http://192.168.1.8:3099/?t=<口令>`，手机打开一次就会换成干净地址并记住一个月。

## 配置 `config.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `lanIp` | `auto` | `auto` 时按网卡挑（192.168 > 10 > 172.16-31，虚拟网卡扣分）；也可写死 IP |
| `lanPort` | `3099` | 网关监听端口；被占用时 start 失败并回写 lastError |
| `autoStart` | `true` | 随宿主启动自动拉起 |
| `bootTimeoutMs` | `120000` | 等 `webServer`/`connection` 服务挂载的上限 |

口令存在插件目录 `token.txt`，首次生成后复用；删掉它就会换新口令。

## 触发条件

- **随宿主自动起**：`apply` 时若 `config.autoStart`（默认 `true`）为真，异步调 `ensureStarted()` 起网关，不阻塞宿主启动；为 `false` 时只注册工具，等手动 `lan_web({action:"start"})`（`index.js:176`）。
- **前置依赖宿主两个服务**：`webServer`（要有 `port`）与 `connection.authenticatedUrl` 就绪后才起，最长等 `bootTimeoutMs`（默认 120000ms）；超时置 `lastError="webServer/connection 未就绪"`，不重试其它端口（`index.js:59`、`index.js:139`）。
- **工具注册也要等 `tools` 服务**：未就绪时走 `toolsOrRetry` 重试，仍未就绪则 `lan_web` 不注册（`index.js:182`）。
- **手动触发**：`lan_web({action:"status"|"start"})` 会等并起网关，`stop` 直接停；失败原因回写 `lastError`，过程记进本目录 `note.log`（`index.js:233`）。
- **诊断开关**：转发 HTML 时带 `?plain=1` 跳过 polyfill / mux 自愈注入，手机出问题时分两次打开对比是哪段注入的锅；进网关先过口令 `?t=` 或 cookie，否则 401 提示页（`lib/gateway.js:250`、`lib/gateway.js:224`）。
- **配置**：`config.json` 的 `lanIp` / `lanPort` / `autoStart` / `bootTimeoutMs`，缺文件时用内置默认值（`index.js:26`）。

## 已知限制

- 只做 HTTP + WS 转发，不提供 TLS；手机走明文，仅在可信局域网里用。
- 防火墙没放行端口时手机打不开，插件不会自动加规则（需要管理员权限）。
- 宿主重启后 launchToken 会变，网关随插件重新启动并重新换 cookie；若宿主启动太慢超过 `bootTimeoutMs`，用 `lan_web action=start` 重试。
- 手机侧不落宿主 cookie，只落网关口令；宿主自己的窗口认证不受影响。

## 回归

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '<workspace>\tools\run-node.ps1' `
  -Out '<workspace>\_tmp\lan-web-tests.txt' '<workspace>\dsh-plugins\dsh-lan-web\tests\run-all.mjs'
```

`tests/run-all.mjs` 用一个假宿主（token 换 cookie、无 cookie 401、HTML 页面）跑 18 项断言：网卡挑选、口令落盘复用、polyfill 内容、401/302/200 三条认证路径、子路径转发、cookie 不外泄。

## 变更记录

- 2026-11-10：校对文档与源码（此前 README 落后于实现）。

- 2026-11-09 · 手机端「新建会话 / 历史会话点了没反应」两处加固：①**mux 自愈**——注入 `data-dsh-lan-mux-guard` 脚本，包一层 `WebSocket` 只盯 `/api/remote.mux`，连接断掉后观察 8 秒，期间若前端没自己重连就 `location.reload()` 一次（`sessionStorage` 做 60 秒节流，后端真挂时不会变无限刷新）。背景：手机切后台/锁屏时这条 WS 会被静默掐断，前端不重连，UI 还在但所有会话操作发不出去。②WS 隧道的空闲超时改为**只保护握手期**：原实现对整条连接挂 `upstream.setTimeout(10000)`，静默 10 秒就 `destroy`，长连接会被反复误杀；现在收到后端首字节即 `setTimeout(0)`。回归 22/22。

- 2026-11-08 · 首版：网关 + 口令闸门 + HTML polyfill 注入 + `lan_web` 工具；回归 18/18。
- 2026-11-08 · 修 gzip：转发时丢弃 `accept-encoding`。实测手机浏览器带 `Accept-Encoding: gzip` 时，宿主返回 13,817 字节压缩体，旧实现把压缩体当 UTF-8 注入 polyfill，页面直接白屏；现在强制明文，回归 20/20。
- 2026-11-08 · 修 Origin：手机实测「重新连接中」不出内容，根因是宿主对 `/api` 做同源校验——同一请求 `Origin: http://192.168.1.8:3099` 返回 **403**，`Origin: http://127.0.0.1:53226` 或无 Origin 返回 404（说明已过闸）。现在转发前把 `Origin` / `Referer` 改写成后端自己的 origin，HTTP 与 WebSocket 升级两条路径都改，回归 22/22。
- 2026-11-08 · 加访问日志与缓存头：手机出问题时无法区分「请求没打到网关」和「打到了被挡下」，现在每个 HTTP 请求与 WS 生命周期各记一行到 `access.log`（含对端 IP / UA / 路径 / 状态码 / 耗时，2MB 轮转保留一代）；转发 HTML 时强制 `cache-control: no-store`，宿主重启换端口后手机不会再卡在旧页面；WS 升级 10 秒无响应主动断开，让浏览器自己重连而不是干等。回归 22/22。
