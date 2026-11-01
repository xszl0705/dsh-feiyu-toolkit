# Git 发布指南

> 这份是给 **仓库所有者** 看的：第一次把项目推上去、之后怎么发版本、哪些东西绝对不能提交。

## 一、首次发布

### 1. 初始化并检查要提交的东西

```powershell
cd dsh-feiyu-toolkit
git init -b main

# 关键：先看 .gitignore 有没有挡住不该进仓的东西
git status --short
```

**提交前必须确认这些没被包含**：

| 不该进仓 | 原因 | 挡它的规则 |
|---|---|---|
| `packages/dsh-draw/pylibs/` | 42 MB 解压依赖，且与 Python 版本绑定 | `.gitignore` |
| `node_modules/` | 同上，且可由 lockfile 重建 | `.gitignore` |
| `packages/*/load.log` | 是运行时日志，含本机 pid | `.gitignore`（`*.log`） |
| `packages/*/tests/_out/` | 测试产物 | `.gitignore` |
| `packages/dsh-comfy/extra-model-paths.yaml` | 含本机路径，每个人不一样 | `.gitignore` |

发现该忽略的没忽略，补进 `.gitignore` 再 `git rm --cached`。

### 2. 确认没有秘密

```powershell
# 扫一遍可能的密钥
git grep -nEi "api[_-]?key|token|secret|password|sk-[a-z0-9]{20,}"
```

有就**先删掉再提交**。一旦推上去，历史里就洗不掉了（要 `filter-repo` 重写历史，很麻烦）。

### 3. 首次提交

```powershell
git add -A
git commit -m "chore: 初始提交，5 个 DSH 插件"
```

### 4. 建远程并推送

```powershell
# GitHub 上先建空仓（不要勾选 README / .gitignore，否则要处理合并）
git remote add origin https://github.com/<你的用户名>/dsh-feiyu-toolkit.git
git push -u origin main
```

## 二、版本号约定

用语义化版本 `MAJOR.MINOR.PATCH`，**每个插件各自独立**：

| 改动 | 版本 |
|---|---|
| 加工具 / 加能力 | MINOR +1 |
| 修 bug、改文档 | PATCH +1 |
| 破坏性改动（工具改名、参数删除、配置结构变化） | MAJOR +1 |

改版本号要同步三处：`packages/<插件>/package.json` 的 `version`、`capability.json` 的 `version`、该插件 `README.md` 的变更记录。

## 三、打 tag 与发 Release

### 打 tag

两种粒度，按需选：

```powershell
# 整仓版本（推荐，简单）
git tag -a v0.1.0 -m "首个公开版本：draw / comfy / finance-learn / memory-unified / screenshot"
git push origin v0.1.0

# 单插件版本（插件会单独发布时才用）
git tag -a dsh-draw-v0.1.0 -m "dsh-draw 首个版本"
```

### 发 Release

**重点：`pylibs` 走 Release 附件，不进仓库。**

```powershell
# 1. 本地打包 pylibs（假设已经跑过 scripts/setup-pylibs.ps1）
Compress-Archive -Path packages\dsh-draw\pylibs -DestinationPath dsh-draw-pylibs-0.1.0.zip -Force

# 2. 在 GitHub Release 页面上传这个 zip
```

Release 说明模板：

```markdown
## 包含
- dsh-draw 0.1.0
- dsh-comfy 0.1.0
- ...

## 安装
见 [docs/INSTALL.md](docs/INSTALL.md)

## 需要额外下载
- dsh-draw 的 Python 依赖：`dsh-draw-pylibs-0.1.0.zip`，解压到 `packages/dsh-draw/pylibs/`
  或直接跑 `scripts/setup-pylibs.ps1` 自动下载
```

## 四、日常维护

### 提交信息

用 `类型: 简述` 的单行格式：

```
feat: dsh-draw 加饼图
fix: dsh-comfy 参数校验提前到连接服务之前
docs: 补 NO_FILE 的排查步骤
chore: 忽略 tests/_out
```

类型只用这几个：`feat` / `fix` / `docs` / `chore` / `refactor`。

### 改完必做的三件事

1. **跑回归**：`& $node packages/<插件>/tests/run-all.mjs`，必须 `ALL OK`
2. **跑可移植性体检**：`& <python> scripts\portability-check.py --root .`，`blocker` 必须是 0
3. **同步文档**：改了工具就改 `README.md` 的工具表和 `capability.json` 的 `failureModes`

### 分支

小项目不必复杂：

- `main` 随时可安装
- 大改动开 `feat/xxx` 分支，验完再合
- 不要长期存在偏离 main 的活分支

## 五、更新已安装的插件

别人装了旧版本，你改了插件，他们怎么更新？

**如果是 `link:` 安装的（本仓推荐方式）**：

```powershell
cd dsh-feiyu-toolkit
git pull origin main
```

然后重启宿主。插件目录是软链，代码变了但宿主已加载的是旧模块，**必须重启**。

**如果是复制目录安装的**：重新拷一次，同样要重启。

## 六、常见问题

**Q：推上去发现 pylibs 混进去了怎么办？**
```powershell
git rm -r --cached packages/dsh-draw/pylibs
git commit -m "chore: 移除误提交的 pylibs"
```
如果已经 push 过，历史里还留着 42MB，要清理得用 `git filter-repo`。所以第一次提交前一定先 `git status` 看一眼。

**Q：能不能把 5 个插件拆成 5 个仓？**
能，但没必要。插件之间零依赖，monorepo 一次 clone 全拿到，维护成本更低。真的需要单插件发布时，用单独 tag + Release 即可。

**Q：别人 clone 下来装不上怎么办？**
先让他按 `docs/INSTALL.md` 第 0 节确认 Python / node 路径。最常见的失败是：`node` 不在 PATH，却照着 README 敲了 `node tests/...`。

**Q：要不要提交 `pnpm-lock.yaml`？**
本仓没有根 `package.json`（不做 workspaces），所以没有 lockfile。如果你加上了根 package.json，就提交 lockfile。

## 七、仓库体检清单

发布前逐条打勾：

- [ ] `git status` 里没有 `pylibs/`、`node_modules/`、`*.log`
- [ ] 没有密钥（`git grep` 扫过）
- [ ] `scripts/portability-check.py --root .` 的 blocker 为 0
- [ ] 每个插件的 `tests/run-all.mjs` 都 ALL OK
- [ ] README 里的快速开始照着敲能走通（自己试一遍）
- [ ] `.gitignore` 挡住了 `extra-model-paths.yaml` 这类本机配置
- [ ] LICENSE 在
- [ ] 各插件 `package.json` 的 `version` 与 `capability.json` 一致
