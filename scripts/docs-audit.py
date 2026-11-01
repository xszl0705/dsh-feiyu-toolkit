"""docs-audit.py —— 插件文档审计：README / capability / config 与代码是否一致。

比对的四件事：
  1. 代码里注册的工具名  vs  README 里提到的工具名
  2. capability.json 的 failureModes  vs  代码里真实会出现的 reason 码
  3. config.json 的键  vs  代码 DEFAULTS 里认识的键（多出来的键意味着「配了不生效」）
  4. 三件套是否齐（package.json / README.md / capability.json）

用法：
    python docs-audit.py [--root <packages 目录>] [--json <输出>]
退出码：0 = 没发现问题；1 = 有问题。
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOOL_DEF = re.compile(r"""\bname:\s*['"]([a-z][a-z0-9_]*(?:_[a-z0-9]+)+)['"]""")
REASON = re.compile(r"""reason['"]?\s*[:=]\s*['"]([A-Z_]{4,})['"]|fail\([^)]*,\s*['"]([A-Z_]{4,})['"]""")
DEFAULTS_START = re.compile(r"const\s+DEFAULTS\s*=\s*\{")
TOOL_MENTION = re.compile(r"`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`")

SKIP_DIRS = {"node_modules", "tests", ".tmp", "pylibs", "__pycache__", "_out"}


def iter_src(plugin: Path):
    for p in plugin.rglob("*"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix in {".js", ".mjs", ".cjs"} and p.is_file():
            yield p


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def extract_defaults_keys(text: str) -> set[str]:
    """从 const DEFAULTS = { ... } 里抽顶层键（只处理一层嵌套，够用）。"""
    m = DEFAULTS_START.search(text)
    if not m:
        return set()
    i = text.index("{", m.start())
    depth = 0
    keys = set()
    cur = ""
    for ch in text[i:]:
        if ch == "{":
            depth += 1
            if depth == 1:
                continue
        elif ch == "}":
            depth -= 1
            if depth == 0:
                break
        if depth == 1:
            cur += ch
    # 只取最外层的 key:
    depth2 = 0
    line = ""
    for ch in cur:
        if ch in "{[":
            depth2 += 1
        elif ch in "}]":
            depth2 -= 1
        if ch == "," and depth2 == 0:
            mm = re.match(r"\s*['\"]?(\w+)['\"]?\s*:", line)
            if mm:
                keys.add(mm.group(1))
            line = ""
        else:
            line += ch
    mm = re.match(r"\s*['\"]?(\w+)['\"]?\s*:", line)
    if mm:
        keys.add(mm.group(1))
    return keys


def audit(plugin: Path) -> dict:
    name = plugin.name
    issues: list[dict] = []

    pkg_file = plugin / "package.json"
    if not pkg_file.exists():
        return {"plugin": name, "issues": [{"level": "blocker", "type": "no-package"}]}
    pkg = json.loads(read(pkg_file))

    readme = plugin / "README.md"
    cap_file = plugin / "capability.json"
    cfg_file = plugin / "config.json"

    readme_text = read(readme) if readme.exists() else ""
    cap = json.loads(read(cap_file)) if cap_file.exists() else {}
    cfg = json.loads(read(cfg_file)) if cfg_file.exists() else {}

    # 0. 三件套
    for need, path in (("README.md", readme), ("capability.json", cap_file)):
        if not path.exists():
            issues.append({"level": "warn", "type": "missing-file", "file": need})

    # 1. 工具名：代码 vs README
    src_tools: set[str] = set()
    for f in iter_src(plugin):
        src_tools |= set(TOOL_DEF.findall(read(f)))
    readme_tools = set(TOOL_MENTION.findall(readme_text)) if readme_text else set()
    # README 里提到的、看起来像工具名但代码里没有的
    # 注意：这里必然有误报——README 会提到宿主内置工具、兄弟插件的工具、SQLite 表名、
    # 以及「P1 计划补」的功能。这个检查只是提示人工过一眼，不是判定错误。
    noise = {
        "link", "dsh_plugin", "api_key", "base_url", "out_path", "source_dir", "profile_name",
        # 宿主内置工具
        "web_fetch", "read_image", "ops_bash", "bash", "write", "read", "glob", "grep",
        "edit", "present", "screenshot_take", "tool_use",
    }
    ghost = sorted(t for t in readme_tools - src_tools if t not in noise)
    if ghost:
        issues.append({"level": "warn", "type": "readme-tool-ghost", "tools": ghost[:6]})

    missing_doc = sorted(t for t in src_tools if t not in readme_text)
    if src_tools and missing_doc:
        issues.append({"level": "warn", "type": "tool-undocumented", "tools": missing_doc[:6]})

    # 2. capability 的 failureModes vs 代码 reason
    if cap_file.exists():
        src_reasons: set[str] = set()
        for f in list(iter_src(plugin)) + list(plugin.rglob("lib/**/*.py")):
            if any(part in SKIP_DIRS for part in f.parts):
                continue
            for m in REASON.finditer(read(f)):
                src_reasons.add(m.group(1) or m.group(2))
        declared = {x["code"] for x in cap.get("failureModes", [])}
        if src_reasons:
            undeclared = sorted(src_reasons - declared)
            if undeclared:
                issues.append({"level": "warn", "type": "reason-undeclared", "codes": undeclared[:8]})
            phantom = sorted(declared - src_reasons)
            if phantom:
                issues.append({"level": "blocker", "type": "reason-phantom", "codes": phantom[:8]})

    # 3. config 的键 vs 代码里真的读了哪些
    #    注意：插件普遍用 { ...DEFAULTS, ...raw } 合并配置，所以「DEFAULTS 里没有」不代表被忽略。
    #    只有「代码里根本没出现 config.xxx 这个读法」才说明这个键配了不生效。
    src_all = "\n".join(read(f) for f in iter_src(plugin))
    if cfg:
        spreads = re.search(r"\.\.\.\s*(?:config|cfg|conf)\b", src_all)
        # 判定「用到了」的宽松口径：config.xxx 形式、或键名在代码里作为标识符出现过
        #（解构、别名、拼接读法都算，宁可漏报也不要制造噪音）
        unknown = [k for k in cfg if not re.search(rf"\b{re.escape(k)}\b", src_all)]
        # 有整体展开（...config）时所有键都可能被透传，不判
        if unknown and not spreads:
            issues.append({"level": "blocker", "type": "config-unused", "keys": unknown[:8]})

    # 4. 版本号一致性
    cap_ver = cap.get("version")
    pkg_ver = pkg.get("version")
    if cap_ver and pkg_ver and cap_ver != pkg_ver:
        issues.append({"level": "warn", "type": "version-mismatch", "pkg": pkg_ver, "cap": cap_ver})

    return {"plugin": name, "tools": sorted(src_tools), "issues": issues}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    root = Path(args.root)
    plugins = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_"))
    results = [audit(p) for p in plugins]

    blockers = 0
    warns = 0
    for r in results:
        if not r["issues"]:
            print(f"OK   {r['plugin']:<26} 工具 {len(r.get('tools', []))} 个")
            continue
        print(f"!!   {r['plugin']:<26} 工具 {len(r.get('tools', []))} 个")
        for i in r["issues"]:
            blockers += i["level"] == "blocker"
            warns += i["level"] == "warn"
            tail = i.get("tools") or i.get("codes") or i.get("keys") or i.get("file") or ""
            extra = ""
            if i["type"] == "version-mismatch":
                extra = f" package={i['pkg']} capability={i['cap']}"
            print(f"     [{i['level']}] {i['type']}: {tail}{extra}")

    print(f"\n共 {len(results)} 个插件｜阻断 {blockers}｜提醒 {warns}")

    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print("报告:", args.json)
    return 1 if blockers else 0


if __name__ == "__main__":
    sys.exit(main())
