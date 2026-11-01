# dsh-memory-unified 0.5

跨会话长期记忆。**工具优先**：只提供显式工具，不接管、不压缩、不改写你的上下文。

> 0.1 是 fork 自 `dsh-rofm` 的，底座源码随旧工作区一起没了；0.2 是无依赖重写。
> 0.3（P0）修掉三个洞：检索拒答、写入去重/失效、可删除。
> 0.4（P1）换存储引擎：SQLite（`node:sqlite`）+ FTS5 bigram 索引，JSON 退为导出/回滚格式。
> 0.5（P2）加体检与导入导出：`memory_doctor` / `memory_export` / `memory_import`。
> 设计见 [../docs/MEMORY-DESIGN-v2.md](../docs/MEMORY-DESIGN-v2.md)。

## 0.4 存储后端

| 项 | 说明 |
|---|---|
| 主库 | `~/.dsh/dsh-memory-unified/memory.db`（WAL，事务，FTS5 索引） |
| 回退 | Node 无 `node:sqlite` 或初始化失败 → 自动用 `index.json` + `folders/*.json` |
| 切换 | `config.json` 的 `"store": "sqlite" | "json"` |
| 迁移 | 首次启动自动导入 JSON 里库中不存在的条目（已删除/已失效的 id 不会被复活）；也可手动跑脚本 |
| 回滚 | 把 `store` 改回 `"json"` 重启即可；JSON 文件一直原样保留 |

脚本：

```bash
node scripts/migrate-to-sqlite.mjs --dry-run     # 看要迁移多少
node scripts/migrate-to-sqlite.mjs               # 首次迁移（库非空则跳过）
node scripts/migrate-to-sqlite.mjs --force-import # 增量补齐（幂等）
node scripts/consolidate.mjs --dry-run           # 看有多少重复
node scripts/consolidate.mjs --ratio 0.75        # 合并近重复（旧的标 superseded）
```

## 工具

| 工具 | 作用 |
|---|---|
| `memory` | 单入口，`action` 分发九件事（2026-11-01 由九个独立工具合并而来，省工具定义 token）。返回 `{ ok, action, result }` |

| action | 作用 |
|---|---|
| `remember` | 写一条：`text` + `folder`（主题）+ `keywords` + `importance` + `category`；重复内容自动合并/失效 |
| `search` | 整句检索，中文按「整串 + 相邻二字」切分；**无词面命中时返回空**；可用 `folder` 限定主题 |
| `related` | 给 id 或文本，找关键词重叠的其它记忆 |
| `digest` | 总览：几个主题、各多少条、最近更新了什么 |
| `judge` | 该不该记：0~1 分 + 理由；**含密码/密钥/证件直接拒绝** |
| `forget` | 软删除：按 id 或 folder+query 批量删（保留历史、不再参与检索） |
| `doctor` | 体检：后端、主题/条目、重复组、FTS 漂移、体积、时间范围 |
| `export` | 导出可 diff 的 JSON（含失效/删除条目），默认写到 `<记忆库>/exports` |
| `import` | 从 JSON 导入（导出格式或 v1 格式），按 id 去重、只导入活跃条目 |

旧工具名（`memory_remember` / `memory_search` / `memory_related` / `memory_digest` / `memory_judge` / `memory_forget` / `memory_doctor` / `memory_export` / `memory_import`）**不再注册**。

> 注意：`memory_log` / `memory_note` / `memory_recall` / `memory_read` / `memory_user` / `memory_rules` 等来自另一个插件（`@a9i5k4/dsh-auto-memory`，负责 `.dsh-memory/` 日志与白板），与本插件的 sqlite 语义库是**两套不同的记忆**。

## 变更记录

- 2026-11-01：九个工具合并为单入口 `memory`（action 分发），工具定义从 9 个降到 1 个（约 −3.2k 字符）；旧工具名不再注册，各 action 的参数与返回字段不变，外层返回改为 `{ ok, action, result }`。

## 0.3 行为变化

- **拒答**：`searchFolders` 要求至少一个词面命中，且分数 ≥ 0.08；无关查询返回空而不是噪声。
- **去重**：写入时算 SimHash；完全重复 → 合并关键词（`action: duplicate`）；近似重复（Jaccard ≥ 0.6）→ 旧条标 `superseded`、插入新条（`action: updated`）。
- **失效而非覆盖**：旧条目保留在文件里（`status: superseded` + `supersededBy`），可追溯。
- **文件夹关键词封顶 20 个**，避免越用越长稀释打分。
- **淘汰优先清失效条目**，不再一律砍最旧。

## 存储

`~/.dsh/dsh-memory-unified/`

```
index.json          主题索引 { folders: [...], nextId }
folders/f1.json     每个主题一个文件 { id, name, keywords, items: [...] }
```

纯 JSON、可备份、可 diff、坏一条不影响全局（读失败按空处理）。

## 配置

```json
{
  "storeDir": "",
  "autoRecall": false,
  "recallLimit": 3,
  "maxItemsPerFolder": 200
}
```

- `autoRecall`：默认关。开启后若宿主暴露 `systemPrompt.section`，只挂一句「记忆库有 N 条，需要时用工具查」；挂不上静默跳过。
- `storeDir` 留空 = `~/.dsh/dsh-memory-unified`

## 自检

`tests/verify-all.mjs` 的 `[4/4]` 段：写一条「改 DSH 前先备份」的规则 → 用「重启之前要先做什么」整句检索 → 判定 → 总览 → 关联，全用临时目录，不污染真实记忆。

## 使用说明

**什么时候用**

- 用户交代了要长期记住的事（偏好、规则、决定、约定）→ `memory({action:'remember'})`
- 想确认以前聊过什么 → `memory({action:'search'})`（整句也能搜）
- 拿不准值不值得记 → 先 `memory({action:'judge'})`，它会告诉你值不值、有没有敏感内容
- 定期体检 → `memory({action:'doctor'})`（重复组、失效条目）

**工具**

| 调用 | 干什么 |
|---|---|
| `memory({action:'remember', text, folder, keywords, importance, category})` | 写一条；重复会合并，近似会更新并让旧条失效 |
| `memory({action:'search', query})` | 检索；没有词面命中就返回空，不硬凑 |
| `memory({action:'related', text \| id})` | 找相关条目，补上下文 |
| `memory({action:'digest'})` | 总览：有哪些主题、各多少条 |
| `memory({action:'judge', text})` | 软评分：值不值得记、是否敏感 |
| `memory({action:'forget', id \| folder+query})` | 软删除（保留历史，不再检索） |
| `memory({action:'doctor' \| 'export' \| 'import', file?, dir?})` | 体检 / 导出 / 导入 |

**什么时候别用**

- **会话细节不要往里存**——那些在 `dialog` 里，记忆库只放跨会话仍有用的东西
- 敏感内容（密钥、密码、身份证号）会被硬拒，别反复试
- `importance` 别都填 0.9，长期规则才给高分，日常事实 0.5 就够
