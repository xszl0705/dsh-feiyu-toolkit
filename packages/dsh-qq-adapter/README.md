# dsh-qq-adapter

QQ 渠道适配器：**NapCat（OneBot 11）↔ 主体内核**。

```
NapCat 反向 WS 事件
   │  过滤：私聊 / 群白名单 / 必须 @ / 每分钟限速 / message_id 去重
   ▼
身份：~/.dsh/dafeiyu/compiled/identity.qq.txt（由 dsh-dafeiyu-core 生成）
   │  + 当前这句
   ▼
宿主 llm（deepseek-flash）→ 清洗（≤120 字）
   ▼
OneBot HTTP：/send_private_msg 或 /send_group_msg
   ▼
chatlog：~/.dsh/pet-diary/chats/YYYY-MM-DD.jsonl（channel:"qq"）
```

## 前提

1. 装好 NapCat 并登录 QQ（小号推荐）
2. NapCat 配好 **反向 WebSocket**（ws://127.0.0.1:3001）与 **HTTP 服务**（http://127.0.0.1:3000）
3. 两边 token 一致（可留空）

## 配置

```json
{
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": "",
  "allowPrivate": true,
  "groups": ["你的群号"],
  "requireAtInGroup": true,
  "maxReplyChars": 120,
  "ratePerMinute": 6,
  "identityFile": ""
}
```

- `groups` 为空 = 不接任何群；私聊默认接
- `requireAtInGroup`：群里必须 @ 才回
- `identityFile` 留空 = `~/.dsh/dafeiyu/compiled/identity.qq.txt`

## 工具

| 工具 | 作用 |
|---|---|
| `qq` | 单入口：`action=status` 看是否连上 NapCat、已回复/忽略多少、最近错误；`action=send` 手动发一条（测试通道用） |

## 自检

```bash
node tests/smoke.mjs   # 26 项：解析/过滤/限速/提示词/编排/HTTP 发送/chatlog
```

## 使用说明

**什么时候用**

- 查连接和收发计数 → `qq(action=status)`
- 测试发一条 → `qq(action=send, kind, targetId, text)`（**真人场景少用**，容易被判异常）
- 模型看不了图时 → `vision_describe`（把图片转成文字描述）

**工具**

| 调用 | 参数 |
|---|---|
| `qq(action="status")` | 不带其他参数；回是否连接、已回复/忽略/交微心跳多少、最近错误 |
| `qq(action="send", kind, targetId, text)` | `kind=private\|group`，targetId 是 QQ 号或群号 |
| `vision_describe(path, question, useContext)` | 本地图片 → 文字描述 |

**什么时候别用**

- **账号风控期不要用 `qq(action=send)` 测试**——每次发消息都是风险
- 群知识、消息收发这些是自动流程，别手动干预
- `connected=false` 先看 NapCat 有没有起，别急着调代码

## 变更记录

- 2026-11-01 · 工具合并：`qq_status` / `qq_send` 合并为单入口 `qq(action=status|send)`；旧名不再注册。
