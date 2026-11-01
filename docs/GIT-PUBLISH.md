# 从零发布到 GitHub（手把手版）

> 面向：这个仓库**已经 commit 好了，但还没有远程**。
> 每一步都有「敲什么 → 应该看到什么 → 卡住了怎么办」。

---

## 第 0 步：先把 git 身份配上

**现在你的机器上 git 没配用户名和邮箱**，不配的话每次提交都会报错或需要临时指定。

```powershell
$git = 'C:\Program Files\Git\cmd\git.exe'
& $git config --global user.name "大肥鱼"
& $git config --global user.email "你的GitHub邮箱@example.com"
```

验证：

```powershell
& $git config --global user.name
& $git config --global user.email
```

应该原样打印出你填的两个值。

> 邮箱建议和 GitHub 账号一致，这样提交会关联到你的头像。
> 不想暴露真实邮箱也没关系，GitHub 有 `xxx@users.noreply.github.com` 的匿名邮箱。

---

## 第 1 步：提交前最后看一眼

```powershell
cd <你的仓库目录>
$git = 'C:\Program Files\Git\cmd\git.exe'

& $git status -sb
```

**应该看到**：

```
## main
```

只有这一行，说明工作区干净、没有遗漏的改动。

如果有未提交的文件，先处理掉：

```powershell
& $git add -A
& $git commit -m "chore: 补提交"
```

### 再确认三件不该进仓的东西

```powershell
# 1. 不该有 pylibs / node_modules / 日志
& $git ls-files | Select-String 'pylibs|node_modules|\.log$'

# 2. 不该有密钥
& $git grep -nEi "api[_-]?key|secret|password|token" -- '*.js' '*.json'
```

**两条都应该没有任何输出。** 有输出就先删掉再提交——一旦推上去，历史里就洗不掉了。

---

## 第 2 步：在 GitHub 上建一个空仓库

1. 浏览器打开 https://github.com/new
2. **Repository name** 填 `dsh-feiyu-toolkit`
3. 选 **Public**（想私有就选 Private，后面步骤一样）
4. **下面三个勾全部不要勾**：
   - ❌ Add a README file
   - ❌ Add .gitignore
   - ❌ Choose a license

   > 这三个都不勾很重要。勾了的话远程会先有一个提交，你 push 时会报
   > `rejected — fetch first`，还得额外做合并。空仓最省事。

5. 点 **Create repository**

建好后页面会显示一堆命令，**先别照着敲**，直接看下一步。

---

## 第 3 步：生成访问令牌（PAT）

现在 GitHub 不支持用账号密码 push，必须用 token。

1. 打开 https://github.com/settings/tokens
2. 点 **Generate new token** → 选 **Generate new token (classic)**
3. **Note** 填 `dsh-feiyu-toolkit push`
4. **Expiration** 选 30 天（够用，过期再生成）
5. **Scopes** 勾选：
   - ✅ `repo`（完整仓库权限，这一项就够）
6. 拉到底点 **Generate token**
7. **复制那一串 `ghp_xxxxx`**

> ⚠️ 这串 token 只显示一次，关掉页面就再也看不到了。先粘贴到记事本。
> ⚠️ 别把 token 写进任何文件、别提交到仓库。

---

## 第 4 步：把本地仓连到 GitHub

```powershell
cd <你的仓库目录>
$git = 'C:\Program Files\Git\cmd\git.exe'

& $git remote add origin https://github.com/你的用户名/dsh-feiyu-toolkit.git
```

验证：

```powershell
& $git remote -v
```

**应该看到**：

```
origin  https://github.com/你的用户名/dsh-feiyu-toolkit.git (fetch)
origin  https://github.com/你的用户名/dsh-feiyu-toolkit.git (push)
```

写错了要改：

```powershell
& $git remote set-url origin https://github.com/你的用户名/dsh-feiyu-toolkit.git
```

---

## 第 5 步：推上去

```powershell
& $git push -u origin main
```

**会弹出一个窗口要账号密码**：

| 字段 | 填什么 |
|---|---|
| Username | 你的 **GitHub 用户名**（不是邮箱） |
| Password | 刚才复制的 **PAT**（`ghp_xxxxx`，不是登录密码） |

**应该看到**：

```
Enumerating objects: 348, done.
...
To https://github.com/你的用户名/dsh-feiyu-toolkit.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

**推完刷新 GitHub 页面**，应该能看到 20 个插件目录、README、LICENSE。

### 卡住了怎么办

| 报错 | 原因 | 解法 |
|---|---|---|
| `Authentication failed` | 密码填了登录密码 | 重来一次，密码填 PAT |
| `remote: Support for password authentication was removed` | 同上 | 同上 |
| `rejected — fetch first` | 建仓时勾了 README | `& $git pull --rebase origin main` 再 push |
| `error: remote origin already exists` | 加过远程了 | 用 `set-url` 改，别用 `add` |
| `Permission denied (publickey)` | 用了 SSH 地址 | 把 remote 换成 https 地址 |
| `src refspec main does not match any` | 本地分支名不叫 main | `& $git branch -M main` 再 push |

---

## 第 6 步：打版本标签

```powershell
& $git tag -a v0.1.0 -m "首个公开版本：20 个 DSH 插件"
& $git push origin v0.1.0
```

验证：

```powershell
& $git tag
& $git ls-remote --tags origin
```

GitHub 页面的右侧会多出一个 **Releases / Tags** 区域，能看到 v0.1.0。

---

## 第 7 步：发 Release（带 pylibs 附件）

别人 clone 下来，`dsh-draw` 还缺 42MB 的 Python 依赖。它不在仓库里（`.gitignore` 挡住了），所以走 Release 附件。

### 7.1 先在本地打包

前提：你本地已经跑过 `scripts\setup-pylibs.ps1`，`packages\dsh-draw\pylibs` 存在。

```powershell
cd <你的仓库目录>
Compress-Archive -Path packages\dsh-draw\pylibs -DestinationPath dsh-draw-pylibs-0.1.0.zip -Force
Get-Item dsh-draw-pylibs-0.1.0.zip | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
```

**应该看到** 30~40 MB 左右。

### 7.2 在 GitHub 上创建 Release

1. 打开仓库页面 → 右侧 **Releases** → **Create a new release**
2. **Choose a tag** 选 `v0.1.0`
3. **Release title** 填 `v0.1.0`
4. **Describe this release** 粘贴：

```markdown
## 包含
20 个 DSH 插件：绘图视觉 / 数据知识 / 人格对话 / 桌宠 / 渠道集成

## 安装
见 [docs/INSTALL.md](docs/INSTALL.md)

## 额外下载
- `dsh-draw-pylibs-0.1.0.zip` — dsh-draw 的 Python 依赖，解压到 `packages/dsh-draw/pylibs/`
  （或直接跑 `scripts/setup-pylibs.ps1` 自动下载）

## 注意
以下插件需要自己填配置：comfy / playground / qq-adapter / service-autostart / feiyu-mood-lite
```

5. 把 `dsh-draw-pylibs-0.1.0.zip` 拖进 **Attach binaries** 区域
6. 点 **Publish release**

---

## 第 8 步：以后改了怎么发

这是个循环，每次改完都走一遍：

```powershell
$git = 'C:\Program Files\Git\cmd\git.exe'
cd <你的仓库目录>

# 1. 跑两道静态检查
python scripts\portability-check.py --root packages
python scripts\docs-audit.py --root packages

# 2. 跑测试（能跑的）
node packages\dsh-draw\tests\run-all.mjs

# 3. 看改了什么
& $git status -sb
& $git diff --stat

# 4. 提交
& $git add -A
& $git commit -m "fix: 修了 xxx"

# 5. 推
& $git push

# 6. 要发版本才打 tag
& $git tag -a v0.1.1 -m "修 xxx"
& $git push origin v0.1.1
```

### 提交信息怎么写

`类型: 一句话`，类型只用这几个：

```
feat: 加功能
fix: 修 bug
docs: 只改文档
chore: 杂项（忽略文件、版本号）
refactor: 不改行为只整理代码
```

**不要写**：`update`、`修改`、`111`、`.` —— 三个月后你自己都看不懂。

---

## 一页速查

```powershell
# 环境
$git = 'C:\Program Files\Git\cmd\git.exe'
cd <你的仓库目录>

# 首次发布
& $git config --global user.name "大肥鱼"
& $git config --global user.email "你的邮箱"
& $git status -sb                    # 确认干净
& $git remote add origin https://github.com/<用户名>/dsh-feiyu-toolkit.git
& $git push -u origin main           # 用户名 + PAT
& $git tag -a v0.1.0 -m "首个版本"
& $git push origin v0.1.0

# 日常
& $git add -A
& $git commit -m "fix: 修了 xxx"
& $git push
```

---

## 常见疑问

**Q：非要装 Git 吗？本机 PATH 里没有。**
不用。整合包自带的那份能用，就是每次敲全路径有点长。想省事可以临时加进 PATH：

```powershell
$env:PATH = 'C:\Program Files\Git\cmd;' + $env:PATH
```

这只对当前这个终端窗口生效，关掉就没了。

**Q：能不能用 SSH？**
能，但要先生成密钥、把公钥加到 GitHub。第一次用的话 HTTPS + PAT 更快。SSH 步骤：

```powershell
& $git remote set-url origin git@github.com:你的用户名/dsh-feiyu-toolkit.git
& $git push -u origin main
```

前提是 `~/.ssh/id_ed25519.pub` 已经加到 GitHub 的 SSH keys 里。

**Q：推错了想撤销？**
本地撤销最近一次提交但保留改动：

```powershell
& $git reset --soft HEAD~1
```

已经推到远程想撤：

```powershell
& $git revert HEAD          # 生成一个反向提交，安全
& $git push
```

**别用 `push --force`**，除非你确定没别人在用这个仓库。

**Q：想改成私有仓？**
GitHub 仓库 Settings → 最下面 Danger Zone → Change visibility → Private。已推的内容会一起变私有。
