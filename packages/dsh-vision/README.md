# dsh-vision

看图。从 `dsh-qq-adapter` 抽出来的独立插件。

## 为什么单独成插件

视觉是**感知器官**，不是「QQ 渠道」的一部分。

之前它寄居在 qq 里：

- 客户端拖图、QQ 消息图，两条链路各写一份
- 想给别的渠道加看图，得改 qq

抽出来以后，谁要看图都调同一个服务。

## 服务

```js
const vision = ctx.get('vision') // 或 globalThis[Symbol.for('dsh-vision.service')]

await vision.askVision({ prompt, images, maxTokens })        // 远程图：先下载再转 base64
await vision.askVisionBytes({ prompt, images })             // 本地字节：不下载
vision.buildVisionContextPrompt({ question, memory, recent }) // 拼图片上下文
vision.installClientVisionContext(ctx)                       // 给宿主装图片注入
vision.stats()                                               // 调用次数、失败数
```

## 工具

| 工具 | 作用 |
|---|---|
| `vision_describe` | 本地图片 → 文字描述（模型看不了图时兜底）。参数 `path`（必填）、`question`、`useContext`（默认 true，检索相关记忆与最近对话）。只读 `~/.dsh` 附件/图片库、系统临时目录与 `vision.allowedRoots` 下的真实图片，按文件头认类型；越界路径与非图片直接拒绝。 |

2026-11-04 从 `dsh-qq-adapter` 迁来，工具名不变：看图是感知能力，不该由某个渠道提供。看图后如果 qq 暴露了 `imageLibrary` 服务，仍会自动入库（服务缺席就只描述、不入库）。

## 安全边界

| 边界 | 做法 |
|---|---|
| 远程图地址 | 只收公网；DNS 解析后钉地址，逐跳校验重定向 |
| 图片大小 | 有上限，超了**拒绝**而不是截断 |
| 失败 | 返回 `{ ok:false, error }`，不抛错、不编描述 |

## 认证（2026-11-04 修）

两条路径，**优先用官方 API key**：

1. `config.json` 里 `vision.apiKey`，或环境变量 `DEEPSEEK_API_KEY` → 发 `Authorization: Bearer <key>`
2. 什么都没配 → 退回宿主 `deepseekAccount.resolveToken()`，发 `x-dsh-auth-token`

**为什么加第 1 条**：宿主账号 token 只对 DSH 自己的推理网关有效，直连 `api.deepseek.com` 会被判 `Authentication Fails (invalid dsh token)`——2026-10-31 到 11-04 累积 115 次 401，看图功能实际一直是坏的。现在没配 key 时 401 会直接说清「要配 `vision.apiKey`」，不再只丢原始报文。

配置模板见 `config.example.json`。

**模型**：默认 `deepseek-chat`（能看图，content 正常返回）。`deepseek-flash` 是 reasoning 模型，看图时内容常落在 `reasoning_content`、`content` 为空——代码已兜底读 `reasoning_content`，但默认不用它。

## 与 qq 的关系

qq 优先用这个服务，**拿不到就回退自己那份**（`lib/vision.js` 还在）。

`reply.js` 里通过 `vision.ask` 调用——注入进来的函数，不再写死 import。

`vision_describe` 与其路径白名单在 2026-11-04 迁到本插件；反过来，本插件只通过 `ctx.get('imageLibrary')`（或 `globalThis[Symbol.for('dsh-image-library.service')]`）取图片库，不直接依赖 qq。

## 测试

```bash
node tests/service.test.mjs
node tests/client-vision-context.test.mjs
node tests/vision-path.test.mjs
```

## 变更记录


- 2026-11-04 · `vision_describe` 从 `dsh-qq-adapter` 迁回本插件（工具名不变），注册改用 `toolsOrRetry`（冷启动等 tools 服务最多 120s）；`lib/vision-path.js` 与 `vision-path.test.mjs` 一起搬过来。看图后的入库改为调 qq 暴露的 `imageLibrary` 服务，服务缺席只描述不入库。
- 2026-11-04 · 认证修复：`vision.apiKey` / `DEEPSEEK_API_KEY` 两条路径，优先 Bearer key；宿主账号 token 直连 api.deepseek.com 会 401（`invalid dsh token`），没配 key 时改为给出明确提示。新增 `config.example.json`。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。


- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
