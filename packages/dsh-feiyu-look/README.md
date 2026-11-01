# dsh-feiyu-look

大肥鱼的「外观层」第一块：**输入框上方一条只读状态条**。

```
心情 100 · 记忆 33 · 知识 9 · 技能 3 · 桌宠 在
```

- 数据全部来自本机，不联网、不上报
- 只读聚合，不注册工具、不改提示词、不碰会话
- 任何一项读不到就显示 null，状态条自动少一条，不会出现假数据
- 默认 30 秒刷新一次；宿主不可用时不渲染

## 组成

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：注册 `GET /dsh-feiyu-look/state`，聚合心情 / 记忆 / 知识 / 技能 / 桌宠 |
| `lib/client.js` | 浏览器半：手写 bundle，挂到 `shell.overlay` 槽位（右上角浮层，点击穿透） |
| `cordis.patch.yml` | 补丁层：insert 一条插件条目 |
| `test/contract.test.mjs` | 契约测试：bundle 加载形态 + 聚合端点形状 |

## 数据来源

| 字段 | 来源 |
|---|---|
| mood | `~/.dsh/feiyu-mood/state.json` 的 `moods.__default__` |
| memory.items | `~/.dsh/dsh-memory-unified/memory.db`，`status='active'` 计数 |
| knowledge.items | `~/.dsh/dafeiyu/knowledge/knowledge.db` 的 `items` 计数 |
| skills | `~/.dsh/skills` 下带 `SKILL.md` 的目录数 |
| pet | `~/.dsh/pet-hub-status.json` |

## 安装

```powershell
# 1) 备份 profile
#    package.json / cordis.patch.yml / pnpm-lock.yaml
# 2) 在 profile package.json 里加依赖与 bundle
"dsh-feiyu-look": "link:<插件源码目录>"
# bundles 数组末尾追加 "dsh-feiyu-look"
# 3) 重启 DSH（会断当前会话）
```

装上后刷新页面，输入框上方出现状态条。

## 卸载 / 回滚

从 profile `package.json` 删掉 `dependencies["dsh-feiyu-look"]` 和 `bundles` 里的那一项，重启即可。
不留任何数据文件。

## 已知边界

- 槽位 `shell.overlay` 是宿主 `ui-layout` 的 AppFrame 声明的 root 级 list 槽（2026-10-31 从 `app.asar` 里核过：`kind: "list", scope: "root"`，宿主文档明确建议「自己的浮层挂这里」）。槽位名写错不会报错，只会静默不渲染。
- 位置固定在 `top: 40px; right: 16px`：放 `top: 10px` 会压住窗口标题栏，第五个 chip 被窗口按钮挤没（同日截图确认）。
- 只依赖基座 `react`，不引 primitives，避免版本漂移。
- 目前没有「点击展开详情」，只有悬浮 tooltip；详情面板放到 U2。

## 测试

```powershell
node test/contract.test.mjs
```

期望输出 `OK client bundle + host state contract`，并打印一份真实聚合结果。
