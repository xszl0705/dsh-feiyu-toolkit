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

## 安全边界

| 边界 | 做法 |
|---|---|
| 远程图地址 | 只收公网；DNS 解析后钉地址，逐跳校验重定向 |
| 图片大小 | 有上限，超了**拒绝**而不是截断 |
| 失败 | 返回 `{ ok:false, error }`，不抛错、不编描述 |

## 与 qq 的关系

qq 优先用这个服务，**拿不到就回退自己那份**（`lib/vision.js` 还在）。

`reply.js` 里通过 `vision.ask` 调用——注入进来的函数，不再写死 import。

## 测试

```bash
node tests/service.test.mjs
node tests/client-vision-context.test.mjs
```
