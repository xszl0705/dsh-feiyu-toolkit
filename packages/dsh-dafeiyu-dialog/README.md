# dsh-dafeiyu-dialog

跨渠道对话总线：客户端、QQ、桌宠把每轮对话写进同一份 JSONL，按 `conversation` 取最近上下文。

## 数据

```
~/.dsh/dafeiyu/dialogues/YYYY-MM-DD.jsonl
{ at, channel, conversation, role, text, model }
```

- 客户端：`channel=client`，`conversation=owner`（会话事件采集，跳过子代理）
- QQ：`channel=qq`，`owner` / `group:<群号>` / `private:<QQ号>`
- 桌宠：`channel=pet`，`conversation=owner`

## 服务

安装后可通过 `ctx.get('dialog')` 或 `globalThis[Symbol.for('dsh-dafeiyu-dialog.service')]`：

- `append(row)`
- `recent({ conversation, limit, days })`
- `recentOwner(limit)`

HTTP 只读口（给 Python 桌宠）：`/dsh-dafeiyu-dialog/recent?conversation=owner&limit=6`

## 隐私

只按 `conversation` 取；群聊、陌生人各有自己的 key，不会读到 `owner` 的对话。

## 职责：给模型看的，不是给人看的

本插件的 `dialogues/` 是**上下文来源**，不是留痕档案。全机有两份"对话记录"，读者不同：

| 数据 | 读者 | 使用者 | 形态 |
|---|---|---|---|
| `dafeiyu/dialogues/`（本插件） | **模型** | `brain.buildContext`、`qq.planReplyPrompt` | 按 conversation 隔离、有 role |
| `pet-diary/chats/`（pet-diary 读） | **人** | `chatlog_read`、写日记时的素材 | 扁平留痕、带 channel/moment |

**它们不是重复数据，不要为了"去重"删掉任何一份**：

- `dialogues` 有会话作用域，群聊和陌生人互相看不到，主人私聊是独立 key；
- `chats` 没有作用域概念，是给人翻看的，宠物说话、QQ 群回复都会写进去。

写入方：客户端事件（`channel=client`）、QQ 的 `logDialog`（`channel=qq`）、桌宠（`channel=pet`）。

第三份是 `dafeiyu/decisions/`，只记决策与结果、**不含正文**，职责完全不同（见 `dsh-feiyu-self`）。

## 性能

`recent()` 走 `lib/reader.js` 的文件缓存：按 `(mtimeMs, size)` 判断文件是否变化，解析时按 `conversation` 预分组。同一条消息里被调用 2–3 次也只读一次盘。命中情况可以通过 `stats()` 查。

## 使用说明

**什么时候用**

- 拼上下文前取最近几条 → `recent({ conversation, limit, days })`
- 每一轮对话结束 → `append({ channel, conversation, role, text })`
- 查缓存命中 → `stats()`

**接口**

| 调用 | 说明 |
|---|---|
| `append(row)` | 追加一行，自动按日期分文件 |
| `recent({ conversation, limit, days, opposite })` | 按会话取最近消息，走缓存 |
| `recentOwner(limit)` | 主人私聊的快捷方式 |
| `stats()` | 命中 / 解析次数、缓存文件数 |

HTTP 只读口：`/dsh-dafeiyu-dialog/recent?conversation=owner&limit=6`

**什么时候别用**

- **别把它当档案**——给人看的留痕在 `pet-diary/chats`，这里只给模型拼上下文
- 群聊和陌生人各有自己的 conversation key，别跨 key 读
- 缓存按文件 mtime + size 失效，别绕过 `append` 直接写文件
