# dsh-service-autostart

服务自愈。从 `dsh-qq-adapter` 抽出来的独立插件。

## 为什么单独成插件

拉起 NapCat、拉起微心跳是**身体层**的事，不是 QQ 渠道的职责。

之前它寄居在 qq 里，导致：

- qq 卸了，自愈就没了
- 想给别的服务（语音桥、Ollama）加自愈，得改 qq
- qq 一个插件背着感知、表达、记忆、身体四件事

抽出来以后，qq 只在需要时调用服务；服务自己管冷却和失败上限。

## 服务

```js
const autostart = ctx.get('autostart') // 或 globalThis[Symbol.for('dsh-service-autostart.service')]

await autostart.ensureServices({ config, state, note })  // 两个都看
await autostart.ensureNapCat({ config, state, note })    // 只看 QQ
await autostart.ensureMindLoop({ config, state, note })  // 只看微心跳
autostart.stats()                                        // 调用次数、最近结果
```

`config` 传调用方自己的配置（`config.autostart`），本地默认值和它合并，**调用方优先**。

## 行为

| 探测结果 | 动作 |
|---|---|
| 端口在听 | `up`，不拉 |
| 6099 在、3001 不通 | `starting`，说明正在登录，不拉第二个 |
| 都不通 | 拉起；冷却 30 秒；失败 8 次后降到 10 分钟一次 |
| 调用方 `enabled:false` | `disabled`，完全不碰 |

## 与 qq 的关系

qq 优先用这个服务，**拿不到就回退自己那份**（`lib/autostart.js` 还在）。

回退不是浪费——是万一这个插件没装/加载失败，QQ 还能自己起来。

## 测试

```bash
node tests/service.test.mjs
```
