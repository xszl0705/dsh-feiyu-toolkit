# dsh-screenshot

让模型自己看屏幕：**全屏截图 → 存到工作区 → 直接读图**，省得你手动截图上传。

## 工具

| 工具 | 作用 |
|---|---|
| `screenshot` | 单入口：`action=take` 截一张当前屏幕（可选 `window` 标题关键词、`maxWidth` 缩放、`noScale` 不缩放），返回 PNG 路径；`action=windows` 列出当前枚举到的窗口（受限环境可能不全，仅供参考） |

## 用法

你说「看下屏幕」「截个图给我看看那个报错」，我调 `screenshot(action=take)`，拿到路径后用 `read_image` 读，就能直接说内容。

**接口**

| 调用 | 参数 |
|---|---|
| `screenshot(action="take", window?, maxWidth?, noScale?)` | `window` 标题关键词，省略=全屏；`maxWidth` 默认 1400；`noScale=true` 不缩放 |
| `screenshot(action="windows")` | 无参；回 `windows[]`（`pid` / `process` / `title`） |

## 配置

```json
{
  "outDir": "",
  "maxWidth": 1400,
  "keepFiles": 80
}
```

- 截图默认缩到 1400px 宽（省 token）；要清晰可传 `noScale: true`
- 只保留最近 `keepFiles` 张，自动清理

## 实现要点

- 抓屏用 Windows 自带 GDI+（`System.Drawing` + `CopyFromScreen`），不引第三方依赖
- 宿主 tools 服务可能晚就绪：**250ms 重试、最多 60 秒**，不会因为启动竞争永久跳过注册
- 调 PowerShell 时 **stdout/stderr 重定向到文件**（不用管道）——受限环境里管道会被 `EPERM` 挡掉
- 元数据以 `.png.json` 旁车文件返回（UTF-8），避免控制台编码把中文路径弄乱
- 窗口标题匹配在非交互会话里可能枚举不到，所以**默认全屏**最稳

## 自检

```bash
node -e "import('./index.js').then(async m => console.log(await m.capture({ maxWidth: 1200 })))"
```

## 变更记录



- 2026-11-03 · `note()` 改为 `dsh-plugin-kit/note` 的薄包装，签名与调用点不变。
- 2026-11-03 · tools 晚就绪的重试逻辑并入 `dsh-plugin-kit/wait-for-tools` 的 `toolsOrRetry()`。
- 2026-11-03 · `lifecycle` 改为从 `dsh-plugin-kit` 导入；本包不再保留 `lib/lifecycle.js` 副本。
- 2026-11-01 · 工具合并：`screenshot_take` / `screenshot_windows` 合并为单入口 `screenshot(action=take|windows)`；旧名不再注册。
