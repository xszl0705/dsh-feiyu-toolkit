"""portability-check.py —— 插件可移植性体检。

扫 `dsh-plugins/*/` 里所有真插件（有 package.json 的目录），找出让「换台机器就坏」
的东西：硬编码本机绝对路径、依赖工作区外文件、体积炸弹、link 依赖。

用法：
    python portability-check.py [--root <dsh-plugins 目录>] [--json <输出文件>]

退出码：0 = 没有阻断问题；1 = 有阻断问题。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# 本机绝对路径的特征
PATTERNS = [
    (re.compile(r"[A-Za-z]:[\\/]+工作区"), "本机工作区路径"),
    (re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\\s]+"), "本机用户目录"),
    (re.compile(r"[A-Za-z]:[\\/]+SD[\\/]+ComfyUI"), "本机 SD 整合包路径"),
    (re.compile(r"[A-Za-z]:[\\/]+dsh[\\/]+", re.I), "本机 DSH 安装路径"),
]

# 不该算作插件的目录
SKIP_DIRS = {
    "_thirdparty", "_pets", "_voice", "_debug", "_tmp", "_backups",
    "docs", "tests", "tools", "local-triage", "node_modules", "pylibs",
    ".tmp", "__pycache__",
}
# 扫描时跳过的子路径
SKIP_PATH_PARTS = {
    "node_modules", "pylibs", ".tmp", "__pycache__", "_out",
    "load.log", ".git",
}
SCAN_EXT = {".js", ".mjs", ".cjs", ".py", ".json", ".yaml", ".yml"}

# 体积阈值
BIG_MB = 20.0


def iter_files(plugin_dir: Path):
    for dirpath, dirnames, filenames in os.walk(plugin_dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_PATH_PARTS and not d.startswith(".")]
        for fn in filenames:
            if fn in SKIP_PATH_PARTS:
                continue
            p = Path(dirpath) / fn
            if p.suffix.lower() in SCAN_EXT:
                yield p


def dir_size_mb(p: Path) -> float:
    total = 0
    skip = {"node_modules", ".git", "pylibs", "_out", "__pycache__", ".tmp"}
    for dirpath, dirnames, filenames in os.walk(p):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            try:
                total += (Path(dirpath) / fn).stat().st_size
            except OSError:
                pass
    return round(total / 1024 / 1024, 1)


def check_plugin(plugin: Path) -> dict:
    name = plugin.name
    issues = []

    pkg_file = plugin / "package.json"
    try:
        pkg = json.loads(pkg_file.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"plugin": name, "error": f"package.json 读不了: {e}", "issues": []}

    # 1. 硬编码本机路径
    hits = []
    for f in iter_files(plugin):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if len(line) > 500:
                continue
            for pat, label in PATTERNS:
                if pat.search(line):
                    hits.append({
                        "file": str(f.relative_to(plugin)).replace("\\", "/"),
                        "line": lineno,
                        "kind": label,
                        "text": line.strip()[:160],
                    })
                    break
    if hits:
        # 配置文件与运行时代码里的命中是阻断的；tests/ 下的、纯注释里的是提醒
        def is_hard(h):
            if h["file"].startswith("tests/"):
                return False
            if h["file"].endswith((".json", ".yaml", ".yml")):
                return True
            return not h["text"].lstrip().startswith(("*", "//", "#"))

        hard = [h for h in hits if is_hard(h)]
        issues.append({
            "level": "blocker" if hard else "warn",
            "type": "hardcoded-path",
            "count": len(hits),
            "hard": len(hard),
            "samples": (hard or hits)[:6],
        })

    # 2. 依赖工作区外/兄弟目录
    deps = pkg.get("dependencies") or {}
    local_deps = {k: v for k, v in deps.items() if isinstance(v, str) and ("link:" in v or "file:" in v)}
    if local_deps:
        issues.append({
            "level": "blocker",
            "type": "local-dependency",
            "count": len(local_deps),
            "samples": [{"name": k, "spec": v} for k, v in list(local_deps.items())[:6]],
        })

    # 3. 体积
    size = dir_size_mb(plugin)
    if size > BIG_MB:
        issues.append({"level": "warn", "type": "big", "sizeMb": size})

    # 4. 必备三件套
    for need in ("README.md", "capability.json"):
        if not (plugin / need).exists():
            issues.append({"level": "warn", "type": "missing-file", "file": need})

    # 5. package.json files 字段（发布时会不会漏东西）
    files_field = pkg.get("files")
    if files_field is not None:
        on_disk = {p.name for p in plugin.iterdir() if p.is_dir()}
        on_disk |= {p.name for p in plugin.iterdir() if p.is_file()}
        ignored = {"node_modules", "tests", ".tmp", "load.log", "__pycache__", "_out", "package.json"}
        not_declared = sorted(
            n for n in on_disk - set(files_field) - ignored
            if not n.startswith(".")
        )
        if not_declared:
            issues.append({
                "level": "warn",
                "type": "undeclared-asset",
                "count": len(not_declared),
                "samples": not_declared[:8],
            })

    return {"plugin": name, "sizeMb": size, "issues": issues}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    root = Path(args.root)
    plugins = sorted(
        p for p in root.iterdir()
        if p.is_dir() and p.name not in SKIP_DIRS and (p / "package.json").exists()
    )

    results = [check_plugin(p) for p in plugins]
    blockers = sum(1 for r in results for i in r["issues"] if i["level"] == "blocker")
    warns = sum(1 for r in results for i in r["issues"] if i["level"] == "warn")
    clean = [r["plugin"] for r in results if not r["issues"]]

    for r in results:
        tag = "OK  " if not r["issues"] else "!!  "
        print(f"{tag}{r['plugin']:<28} {r.get('sizeMb', 0):>7.1f} MB")
        for i in r["issues"]:
            head = f"     [{i['level']}] {i['type']}"
            if i["type"] == "hardcoded-path":
                print(f"{head}: {i['count']} 处（其中实打实 {i['hard']} 处）")
                for s in i["samples"]:
                    print(f"        {s['file']}:{s['line']}  {s['text']}")
            elif i["type"] == "local-dependency":
                print(f"{head}: {i['count']} 个")
                for s in i["samples"]:
                    print(f"        {s['name']} = {s['spec']}")
            elif i["type"] == "big":
                print(f"{head}: {i['sizeMb']} MB（超过 {BIG_MB} MB）")
            elif i["type"] == "missing-file":
                print(f"{head}: 缺 {i['file']}")
            elif i["type"] == "undeclared-asset":
                print(f"{head}: files 没声明 {i['samples']}")

    print(f"\n共 {len(results)} 个插件｜阻断 {blockers}｜提醒 {warns}｜干净 {len(clean)}")
    if clean:
        print("干净:", ", ".join(clean))

    if args.json:
        Path(args.json).write_text(json.dumps({
            "root": str(root), "plugins": results,
            "blockers": blockers, "warnings": warns,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print("报告已写入:", args.json)

    return 1 if blockers else 0


if __name__ == "__main__":
    sys.exit(main())
