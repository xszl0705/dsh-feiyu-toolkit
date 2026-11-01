"""chart.py —— matplotlib 出图，stdin/stdout JSON 协议。

输入（stdin，单行 JSON）：
{
  "kind": "line" | "bar" | "pie" | "scatter" | "dual",
  "labels": ["1月", "2月", ...],
  "series": [{"name": "调用次数", "data": [40, 31, ...]}],
  "title": "...", "xlabel": "...", "ylabel": "...",
  "outPath": "E:/.../a.png",
  "width": 8, "height": 4.2, "dpi": 150
}

输出（stdout，单行 JSON）：{"ok": true, "path": ..., "width":.., "height":.., "bytes":.., "elapsedMs":..}
或 {"ok": false, "error": "...", "reason": "BAD_INPUT|NO_DATA|RENDER_FAILED"}
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback

t_start = time.time()

PALETTE = ["#5b8def", "#e07a5f", "#6cbf8f", "#d9a441", "#9b7ede", "#4fb3bf"]


def emit(obj) -> None:
    """结果写到 --result 指定的文件；没有该参数就打到 stdout（方便手工调试）。"""
    if "--result" in sys.argv:
        with open(sys.argv[sys.argv.index("--result") + 1], "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
    else:
        print(json.dumps(obj, ensure_ascii=False))


def fail(error: str, reason: str) -> None:
    emit({"ok": False, "error": error, "reason": reason})
    sys.exit(0)


def load_spec() -> dict:
    if "--spec" in sys.argv:
        with open(sys.argv[sys.argv.index("--spec") + 1], encoding="utf-8") as f:
            return json.load(f)
    return json.loads(sys.stdin.read() or "{}")


def main() -> None:
    try:
        spec = load_spec()
    except Exception as e:  # noqa: BLE001
        fail(f"参数不是合法 JSON: {e}", "BAD_INPUT")
        return

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    # 中文字体：优先微软雅黑，没有就退到黑体
    for candidate in ("Microsoft YaHei", "SimHei", "DengXian"):
        if any(candidate.lower() in f.name.lower() for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [candidate]
            break
    else:
        plt.rcParams["font.sans-serif"] = ["Microsoft YaHei"]
    plt.rcParams["axes.unicode_minus"] = False

    kind = str(spec.get("kind") or "line").lower()
    labels = spec.get("labels") or []
    series = spec.get("series") or []
    out_path = spec.get("outPath") or ""
    title = spec.get("title") or ""
    xlabel = spec.get("xlabel") or ""
    ylabel = spec.get("ylabel") or ""
    w = float(spec.get("width") or 8.0)
    h = float(spec.get("height") or 4.2)
    dpi = int(spec.get("dpi") or 150)

    if not out_path:
        fail("缺少 outPath", "BAD_INPUT")
        return
    if not series or not any(s.get("data") for s in series):
        fail("没有可绘制的数据（series 为空或 data 全空）", "NO_DATA")
        return
    for s in series:
        for v in s.get("data") or []:
            if v is not None and not isinstance(v, (int, float)):
                fail(f"series[{s.get('name')}] 里有非数字: {v!r}", "BAD_INPUT")
                return

    try:
        fig, ax = plt.subplots(figsize=(w, h), dpi=dpi)

        if kind == "pie":
            data = [v or 0 for v in series[0].get("data") or []]
            ax.pie(data, labels=labels or None, autopct="%1.1f%%", startangle=90,
                   colors=PALETTE[: len(data)], textprops={"fontsize": 11})
            ax.axis("equal")
        elif kind == "bar":
            n = len(series)
            x = range(len(labels))
            for i, s in enumerate(series):
                offset = (i - (n - 1) / 2) * (0.8 / max(n, 1))
                ax.bar([p + offset for p in x], s.get("data") or [], width=0.8 / max(n, 1),
                       label=s.get("name") or f"系列{i+1}", color=PALETTE[i % len(PALETTE)])
            if labels:
                ax.set_xticks(list(x))
                ax.set_xticklabels(labels)
        elif kind == "scatter":
            for i, s in enumerate(series):
                ax.scatter(labels or range(len(s.get("data") or [])), s.get("data") or [],
                           label=s.get("name") or f"系列{i+1}", color=PALETTE[i % len(PALETTE)],
                           s=42, alpha=0.85)
        elif kind == "dual":
            if len(series) < 2:
                fail("dual 模式需要两个系列（第 1 个柱状，第 2 个折线）", "BAD_INPUT")
                return
            ax2 = ax.twinx()
            ax.bar(labels, series[0].get("data") or [], color=PALETTE[0], label=series[0].get("name") or "系列1")
            ax2.plot(labels, series[1].get("data") or [], color=PALETTE[1], marker="o", linewidth=2,
                     label=series[1].get("name") or "系列2")
            if ylabel:
                ax.set_ylabel(ylabel)
            for y, c in ((series[0].get("name"), PALETTE[0]), (series[1].get("name"), PALETTE[1])):
                pass
            lines1, lab1 = ax.get_legend_handles_labels()
            lines2, lab2 = ax2.get_legend_handles_labels()
            ax.legend(lines1 + lines2, lab1 + lab2, loc="upper left", fontsize=9)
        else:  # line
            for i, s in enumerate(series):
                ax.plot(labels or range(len(s.get("data") or [])), s.get("data") or [],
                        label=s.get("name") or f"系列{i+1}", color=PALETTE[i % len(PALETTE)],
                        marker="o" if len(series) == 1 else None, linewidth=2)

        if kind != "pie":
            if title:
                ax.set_title(title, fontsize=14, pad=12)
            if xlabel:
                ax.set_xlabel(xlabel)
            if ylabel and kind != "dual":
                ax.set_ylabel(ylabel)
            ax.grid(True, axis="y", alpha=0.25, linestyle="--")
            ax.spines["top"].set_visible(False)
            if kind != "dual" and len(series) > 0 and any(s.get("name") for s in series):
                ax.legend(fontsize=9)
            if len(labels) > 6:
                for tick in ax.get_xticklabels():
                    tick.set_rotation(30)
                    tick.set_ha("right")
        elif title:
            ax.set_title(title, fontsize=14, pad=16)

        fig.tight_layout()
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        fig.savefig(out_path, format="PNG", facecolor="white")
        plt.close(fig)
    except Exception as e:  # noqa: BLE001
        fail(f"渲染失败: {e}", "RENDER_FAILED")
        traceback.print_exc(file=sys.stderr)
        return

    if not os.path.exists(out_path):
        fail("渲染后找不到文件", "RENDER_FAILED")
        return

    from PIL import Image

    with Image.open(out_path) as im:
        pw, ph = im.size
    emit({
        "ok": True, "path": out_path, "width": pw, "height": ph,
        "bytes": os.path.getsize(out_path),
        "elapsedMs": int((time.time() - t_start) * 1000),
    })


if __name__ == "__main__":
    main()
