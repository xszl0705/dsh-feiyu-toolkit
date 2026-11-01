"""card.py —— 纯 Pillow 中文排版图，stdin/stdout JSON 协议。

输入（stdin，单行 JSON），两种形态：
  {"kind":"card", "title":"...", "body":"...", "footer":"...", "outPath":"...", "width":900}
  {"kind":"rows", "title":"...", "rows":[["键","值"],...], "footer":"...", "outPath":"..."}

输出：{"ok":true,"path":...,"width":..,"height":..,"bytes":..,"elapsedMs":..}
"""
from __future__ import annotations

import json
import os
import sys
import time

t_start = time.time()

FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FALLBACK = [r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\Deng.ttf"]


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


def font(path: str, size: int):
    from PIL import ImageFont

    for p in (path, *FALLBACK):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    fail("找不到中文字体（msyh.ttc / simhei.ttf）", "NO_FONT")
    raise SystemExit(0)


def gradient(size, top, bottom):
    from PIL import Image

    w, h = size
    strip = Image.new("RGB", (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return strip.resize((w, h), Image.BILINEAR)


def char_w(draw, ch, f) -> float:
    box = draw.textbbox((0, 0), ch, font=f)
    return box[2] - box[0]


def wrap(draw, text: str, f, max_w: int) -> list[str]:
    lines: list[str] = []
    for para in str(text).split("\n"):
        if not para:
            lines.append("")
            continue
        cur, cur_w = "", 0.0
        for ch in para:
            cw = char_w(draw, ch, f)
            if cur_w + cw > max_w and cur:
                if ch.isascii() and ch.isalnum() and cur[-1].isascii() and cur[-1].isalnum():
                    cut = cur.rfind(" ")
                    if cut > len(cur) * 0.5:
                        lines.append(cur[:cut])
                        cur = cur[cut + 1:] + ch
                        cur_w = sum(char_w(draw, c, f) for c in cur)
                        continue
                lines.append(cur)
                cur, cur_w = ch, cw
            else:
                cur += ch
                cur_w += cw
        lines.append(cur)
    return lines


def render_card(spec) -> str:
    from PIL import Image, ImageDraw

    title = spec.get("title") or ""
    body = spec.get("body") or ""
    footer = spec.get("footer") or ""
    out = spec.get("outPath") or ""
    width = int(spec.get("width") or 900)
    accent = tuple(spec.get("accent") or (120, 190, 255))

    pad_x, pad_y = 56, 48
    title_f = font(FONT_BOLD, 40)
    body_f = font(FONT_REG, 26)
    foot_f = font(FONT_REG, 18)
    line_h = 44

    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    card_w = width - pad_x * 2 - 40
    title_lines = wrap(probe, title, title_f, card_w)
    body_lines = wrap(probe, body, body_f, card_w) if body else []
    foot_h = 40 if footer else 0

    card_h = 40 + len(title_lines) * 54 + 18 + (len(body_lines) * line_h + 12 if body_lines else 0) + 24
    height = pad_y * 2 + card_h + foot_h

    img = gradient((width, height), (30, 46, 78), (13, 21, 38))
    d = ImageDraw.Draw(img)
    top = pad_y
    d.rounded_rectangle([pad_x, top, width - pad_x, top + card_h], radius=24,
                        fill=(255, 255, 255), outline=(220, 228, 240), width=1)
    d.rounded_rectangle([pad_x, top, pad_x + 8, top + card_h], radius=4, fill=accent)

    x, y = pad_x + 40, top + 40
    for ln in title_lines:
        d.text((x, y), ln, font=title_f, fill=(23, 33, 51))
        y += 54
    y += 18
    for ln in body_lines:
        d.text((x, y), ln, font=body_f, fill=(60, 72, 92))
        y += line_h
    if footer:
        d.text((pad_x + 40, height - pad_y - 6), footer, font=foot_f, fill=(140, 152, 172))
    return img, out


def render_rows(spec):
    from PIL import Image, ImageDraw

    title = spec.get("title") or ""
    rows = spec.get("rows") or []
    footer = spec.get("footer") or ""
    out = spec.get("outPath") or ""
    width = int(spec.get("width") or 900)

    pad_x, pad_y = 56, 48
    title_f = font(FONT_BOLD, 38)
    key_f = font(FONT_BOLD, 24)
    val_f = font(FONT_REG, 24)
    foot_f = font(FONT_REG, 18)

    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    card_w = width - pad_x * 2 - 40
    title_lines = wrap(probe, title, title_f, card_w)
    key_w = 190
    pairs = [(str(r[0]), str(r[1]) if len(r) > 1 else "") for r in rows]
    val_lines = [wrap(probe, v, val_f, card_w - key_w - 20) for _, v in pairs]
    row_h = [max(len(vl) * 38, 46) for vl in val_lines]

    card_h = 40 + len(title_lines) * 52 + 16 + sum(row_h) + 18 + 24
    foot_h = 40 if footer else 0
    height = pad_y * 2 + card_h + foot_h

    img = gradient((width, height), (30, 46, 78), (13, 21, 38))
    d = ImageDraw.Draw(img)
    top = pad_y
    d.rounded_rectangle([pad_x, top, width - pad_x, top + card_h], radius=24,
                        fill=(255, 255, 255), outline=(220, 228, 240), width=1)
    d.rounded_rectangle([pad_x, top, pad_x + 8, top + card_h], radius=4, fill=(120, 190, 255))

    x, y = pad_x + 40, top + 40
    for ln in title_lines:
        d.text((x, y), ln, font=title_f, fill=(23, 33, 51))
        y += 52
    y += 16
    for (k, _), vl, rh in zip(pairs, val_lines, row_h):
        d.text((x, y), k, font=key_f, fill=(70, 92, 130))
        yy = y
        for ln in vl:
            d.text((x + key_w, yy), ln, font=val_f, fill=(45, 55, 72))
            yy += 38
        d.line([x, y + rh - 10, width - pad_x - 40, y + rh - 10], fill=(238, 242, 248), width=1)
        y += rh
    if footer:
        d.text((pad_x + 40, height - pad_y - 6), footer, font=foot_f, fill=(140, 152, 172))
    return img, out


def main() -> None:
    try:
        spec = load_spec()
    except Exception as e:  # noqa: BLE001
        fail(f"参数不是合法 JSON: {e}", "BAD_INPUT")
        return

    kind = (spec.get("kind") or "card").lower()
    out = spec.get("outPath") or ""
    if not out:
        fail("缺少 outPath", "BAD_INPUT")
        return
    if kind == "rows" and not (spec.get("rows") or []):
        fail("rows 模式需要非空 rows", "NO_DATA")
        return
    if kind == "card" and not (spec.get("title") or spec.get("body")):
        fail("card 模式需要 title 或 body", "NO_DATA")
        return

    try:
        builder = render_rows if kind == "rows" else render_card
        img, out = builder(spec)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        img.save(out, "PNG")
        w, h = img.size
    except Exception as e:  # noqa: BLE001
        fail(f"渲染失败: {e}", "RENDER_FAILED")
        return

    emit({
        "ok": True, "path": out, "width": w, "height": h,
        "bytes": os.path.getsize(out),
        "elapsedMs": int((time.time() - t_start) * 1000),
    })


if __name__ == "__main__":
    main()
