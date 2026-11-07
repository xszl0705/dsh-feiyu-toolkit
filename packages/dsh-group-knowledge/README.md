# dsh-group-knowledge

群知识库。从 `dsh-qq-adapter` 抽出来的独立插件。

## 为什么单独成插件

群知识是 **L2 世界模型**，不是「QQ 渠道」的一部分。之前它住在 qq 插件里，导致：

- 客户端、桌宠想用知识库时没法复用
- qq 一个插件同时干感知、表达、记忆、身体四件事

抽出来以后：qq 变回纯渠道，知识库可以被任何渠道消费。

## 服务

```js
const knowledge = ctx.get('knowledge') // 或 globalThis[Symbol.for('dsh-group-knowledge.service')]
knowledge.search('关键词', { channel: 'qq-group', groupId: '123456789' })
knowledge.ingestLink(url, { groupId, sourceChannel })
knowledge.ingestImage({ url, caption, groupId })
knowledge.stats()  // { items, dbFile }
```

## 作用域

查询**必须带 `groupId`**，不带就返回空（fail closed）。

`config.allowShared` 默认 `false`：跨群共享要显式打开。

## 兼容

默认读同一份数据库 `~/.dsh/dafeiyu/knowledge/knowledge.db`，**不搬数据**。

qq 侧优先用这个服务；如果本插件没加载，qq 会回退自己开库，功能不丢。

## 测试

```bash
node tests/service.test.mjs
```

## 使用说明

**什么时候用**

- 群里之前聊过的链接、图片说明 → `search(query, { channel:'qq-group', groupId })`
- 群消息里出现链接 → `ingestLink(url, { groupId })`（自动抓取有公网校验）
- 图片识别完 → `ingestImage({ url, caption, groupId })`

**接口**

| 调用 | 说明 |
|---|---|
| `search(query, { limit, channel, groupId })` | **必须带 groupId**，不带返回空 |
| `ingestLink(url, { groupId, sourceChannel })` | 抓取走公网地址校验 + 字节上限 |
| `ingestImage({ url, caption, groupId })` | 存图片描述 |
| `stats()` | 条目数、库路径 |

**什么时候别用**

- 别指望它跨群——同一个词在 A 群和 B 群是两份数据
- 别往里塞私有内容，它只收群聊公开信息
- 链接抓取失败（内网地址、超大响应）是设计如此，不是 bug

## 变更记录


- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
