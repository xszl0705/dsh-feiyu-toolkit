# -*- coding: utf-8 -*-
"""
FyRunner 本地跑团软件 — 后端服务
零依赖：只用 Python 标准库
启动：python server.py
访问：http://127.0.0.1:8765
"""
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import judge  # 判定引擎（运算层）

# ── 打包(frozen) vs 源码运行 的路径差异 ──
# 打包后：只读资源(web)在 sys._MEIPASS，可写数据(data/config)在 exe 旁边
if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(os.path.abspath(sys.executable))
    RES_DIR = getattr(sys, "_MEIPASS", APP_DIR)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
    RES_DIR = APP_DIR

BASE = APP_DIR
WEB = os.path.join(RES_DIR, "web")
# 数据目录可被 FYRUNNER_DATA 覆盖（插件托管时把可写数据放到自己目录外）
DATA = os.environ.get("FYRUNNER_DATA") or os.path.join(APP_DIR, "data")
DIRS = {
    "scripts": os.path.join(DATA, "scripts"),
    "characters": os.path.join(DATA, "characters"),
    "worldbook": os.path.join(DATA, "worldbook"),
    "mods": os.path.join(DATA, "mods"),
    "sessions": os.path.join(DATA, "sessions"),
}
CONFIG = os.path.join(APP_DIR, "config.json")

# 分享模式：只开放 MOD，隐藏角色库/剧本/世界书/存档
SHARE = os.environ.get("FYRUNNER_SHARE") == "1"  # 插件默认完整模式；外部要只读内容时置 FYRUNNER_SHARE=1

DEFAULT_CONFIG = {
    "provider": "ollama",          # ollama | openai-compatible
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": "qwen3-14b-rp",
    "api_url": "https://api.deepseek.com/v1",
    "api_key": "",
    "api_model": "deepseek-chat",
    "temperature": 0.85,
    "max_tokens": 4096,
}

for _k, _d in DIRS.items():
    if SHARE and _k != "mods":
        continue
    os.makedirs(_d, exist_ok=True)


# ══════════════════════════════ 工具 ══════════════════════════════
def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def backup_before_write(kind, oid, path):
    """覆盖/删除前自动备份（只备份内容类数据，会话不备份），每个文件保留最近 20 份。"""
    if kind not in ("characters", "scripts", "worldbook", "mods"):
        return
    if not path or not os.path.isfile(path):
        return
    try:
        bdir = os.path.join(DATA, "_backup", kind)
        os.makedirs(bdir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % int((time.time() * 1000) % 1000)
        dst = os.path.join(bdir, "%s.%s.json" % (oid, stamp))
        shutil.copy2(path, dst)
        olds = sorted(f for f in os.listdir(bdir) if f.startswith(oid + "."))
        for f in olds[:-20]:
            os.remove(os.path.join(bdir, f))
    except Exception:
        pass  # 备份失败不影响正常保存


def get_config():
    cfg = load_json(CONFIG, {})
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg or {})
    return merged


def new_id(prefix):
    return prefix + "_" + uuid.uuid4().hex[:10]


def now_ts():
    return int(time.time())


# ══════════════════════════════ AI 调用 ══════════════════════════════
_JOBS = {}
_JOBS_LOCK = threading.Lock()


class ChatCancelled(Exception):
    """用户在生成过程中按了「停止」。"""


def job_open(rid):
    with _JOBS_LOCK:
        j = {"buf": [], "cancelled": False, "active": True, "phase": "生成中"}
        _JOBS[rid] = j
        return j


def job_get(rid):
    with _JOBS_LOCK:
        return _JOBS.get(rid)


def job_close(rid):
    if not rid:
        return
    with _JOBS_LOCK:
        j = _JOBS.pop(rid, None)
        if j is not None:
            j["active"] = False


def job_cancelled(job):
    return bool(job and job.get("cancelled"))


def call_ai(messages, cfg, job=None):
    """统一调用入口：ollama 或 openai 兼容。

    job 非空时：① 每收一块先检查是否被「停止」，是则关掉上游连接（Ollama 立即取消推理）；
    ② 正文增量写进 job["buf"]，供前端轮询 /api/chat/tail 实时显示。
    """
    provider = cfg.get("provider", "ollama")

    if provider == "ollama":
        url = cfg["ollama_url"].rstrip("/") + "/api/chat"
        body = {
            "model": cfg["ollama_model"],
            "messages": messages,
            "stream": True,
            # 默认关闭思考：qwen3 开思考时一句「在的」也要先烧 300+ token
            "think": bool(cfg.get("think", False)),
            "options": {
                "temperature": float(cfg.get("temperature", 0.85)),
                "num_predict": int(cfg.get("max_tokens", 4096)),
                # 本地模型防重复循环的关键采样参数
                "repeat_penalty": float(cfg.get("repeat_penalty", 1.15)),
                "top_p": float(cfg.get("top_p", 0.9)),
                "top_k": int(cfg.get("top_k", 40)),
                "num_ctx": int(cfg.get("num_ctx", 16384)),
            },
        }
        headers = {"Content-Type": "application/json"}
    else:
        url = cfg["api_url"].rstrip("/") + "/chat/completions"
        model = cfg.get("api_model", "deepseek-chat")
        body = {
            "model": model,
            "messages": messages,
            "max_tokens": int(cfg.get("max_tokens", 4096)),
            "stream": True,
        }
        # deepseek-reasoner 不支持 temperature 参数（会报 400）
        if "reasoner" not in str(model):
            body["temperature"] = float(cfg.get("temperature", 0.85))
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg.get("api_key", ""),
        }

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    if provider == "ollama":
        parts = []
        thinking = []
        with urllib.request.urlopen(req, timeout=600) as resp:
            if job is not None:
                job["dbg"] = "status=%s te=%s ct=%s" % (
                    getattr(resp, "status", "?"),
                    resp.headers.get("Transfer-Encoding"),
                    resp.headers.get("Content-Type"))
                job.setdefault("chunks", 0)
            for raw in resp:
                if job_cancelled(job):
                    # 断掉上游连接 → Ollama 立刻停止这次推理，不再烧 GPU
                    try:
                        resp.close()
                    except Exception:
                        pass
                    raise ChatCancelled("已停止")
                line = raw.strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line.decode("utf-8", errors="replace"))
                except Exception:
                    continue
                msg = chunk.get("message") or {}
                if msg.get("thinking"):
                    thinking.append(msg["thinking"])
                delta = msg.get("content") or ""
                if delta:
                    parts.append(delta)
                    if job is not None:
                        job["buf"].append(delta)
                        job["chunks"] = job.get("chunks", 0) + 1
                if chunk.get("done"):
                    break

        out = "".join(parts)
        # 旧版 Ollama 把思考塞在 content 的 <think> 里，剥离掉
        out = re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()
        if not out and thinking:
            out = "".join(thinking).strip()
        return out

    # ── OpenAI 兼容（云端）：SSE 流式，可中途停止 ──
    if job_cancelled(job):
        raise ChatCancelled("已停止")
    _key = (cfg.get("api_key") or "").strip()
    if not _key:
        raise RuntimeError("未填写 API Key：去设置页填，或在聊天页切回本地 Ollama")
    parts = []
    with urllib.request.urlopen(req, timeout=300) as resp:
        if job is not None:
            job["dbg"] = "cloud status=%s te=%s ct=%s" % (
                getattr(resp, "status", "?"),
                resp.headers.get("Transfer-Encoding"),
                resp.headers.get("Content-Type"))
            job["chunks"] = 0
        for raw in resp:
            if job_cancelled(job):
                try:
                    resp.close()
                except Exception:
                    pass
                raise ChatCancelled("已停止")
            line = raw.strip()
            if not line:
                continue
            if line.startswith(b"data:"):
                line = line[5:].strip()
            if line == b"[DONE]":
                break
            try:
                chunk = json.loads(line.decode("utf-8", errors="replace"))
            except Exception:
                continue
            choice = (chunk.get("choices") or [{}])[0]
            delta = (choice.get("delta") or {}).get("content") or ""
            if delta:
                parts.append(delta)
                if job is not None:
                    job["buf"].append(delta)
                    job["chunks"] = job.get("chunks", 0) + 1
    return "".join(parts)


# ══════════════════════════════ 联网搜索（可选） ══════════════════════════════
_SEARCH_HINTS = re.compile(
    r"(搜一?下|查一?下|帮我查|网上|联网|最新|实时|今天|现在几点|新闻|"
    r"天气|气温|价格|多少钱|汇率|股价|谁|哪年|什么时候|多久|"
    r"是什么|怎么样|有哪些)"
)


# ══════════════ 一致性辅助：续写去重 / 状态卡 / 前情提要 ══════════════
def _tail_overlap(a, b, max_win=80, min_win=15):
    """a 的尾部与 b 的首部最长公共子串长度（用来发现续写重复）。"""
    a = (a or "").rstrip()
    b = (b or "").lstrip()
    n = min(len(a), len(b), max_win)
    for k in range(n, min_win - 1, -1):
        if a[-k:] == b[:k]:
            return k
    return 0


def join_continuation(reply, more):
    """把续写片段接到正文后面，裁掉与正文尾部重复的部分。"""
    reply = (reply or "").rstrip()
    more = (more or "").strip()
    if not more:
        return reply
    k = _tail_overlap(reply, more)
    if k >= 15:
        more = more[k:].lstrip()
    if not more:
        return reply
    return reply + "\n\n" + more


def parse_state_card(text):
    """只保留「时间/地点/在场/随身/关系/悬念」六行，至少 3 行才算有效。"""
    keep = []
    for line in (text or "").splitlines():
        ls = line.strip().lstrip("-·•*").strip()
        m = re.match(r"^(时间|地点|在场|随身|关系|悬念)[：:]\s*(.*)$", ls)
        if m and m.group(2).strip():
            keep.append("%s：%s" % (m.group(1), m.group(2).strip()[:60]))
    return "\n".join(keep) if len(keep) >= 3 else ""


def extract_state_card(sess, user_input, reply, cfg):
    """把本轮压成六行现场状态，写回 sess["state_card"]；失败保留上一版。"""
    prev = (sess.get("state_card") or "").strip()
    prompt = (
        "你是剧情场记。根据「上一轮状态 / 玩家输入 / 本轮正文」，输出本轮结束时的现场状态。\n"
        "只输出下面 6 行，不要解释、不要编号、不要写正文，每行不超过 40 字：\n"
        "时间：（具体时刻，如「深夜 02:40」；没推进就写上一轮的并注明「未变」）\n"
        "地点：（当前位置；没移动写「未变」）\n"
        "在场：（每个人 + 此刻位置姿态，用分号隔开）\n"
        "随身：（关键物品，没有写「无」）\n"
        "关系：（相对上一轮的变化方向）\n"
        "悬念：（尚未解决的事，没有写「无」）\n\n"
        "【上一轮状态】\n" + (prev or "（开局，无）") + "\n\n"
        "【玩家输入】\n" + (user_input or "（无）") + "\n\n"
        "【本轮正文】\n" + (reply or "")[:3500]
    )
    try:
        out = call_ai([{"role": "user", "content": prompt}], cfg)
    except Exception as e:
        print("[state_card] 生成失败：%s" % e, flush=True)
        return prev
    card = parse_state_card(out)
    if card:
        sess["state_card"] = card
        return card
    return prev


def rollup_recap(sess, cfg, budget=15000, keep_chars=9000):
    """历史超出预算时，把最早的几轮压成「前情提要」，而不是硬截断丢弃。"""
    hist = sess.get("history") or []
    total = sum(len(h.get("content") or "") for h in hist)
    if total <= budget:
        return ""

    dropped = []
    while total > keep_chars and len(hist) >= 2:
        # 成对弹出，避免拆散 user/assistant
        a = hist.pop(0)
        dropped.append(a)
        total -= len(a.get("content") or "")
        if hist:
            b = hist.pop(0)
            dropped.append(b)
            total -= len(b.get("content") or "")
    if not dropped:
        return ""

    prev = (sess.get("recap") or "").strip()
    text = "\n".join("%s：%s" % (h.get("role"), (h.get("content") or "")[:1200]) for h in dropped)
    prompt = (
        "把下面的剧情压缩成「前情提要」，不超过 250 字。第三人称，只保留："
        "谁做了什么、关系或处境发生了什么变化、还有什么没解决。不要评价，不要分点，不要写正文。\n\n"
        + ("【已有前情】\n" + prev + "\n\n" if prev else "")
        + "【需要压缩的剧情】\n" + text
    )
    try:
        new = call_ai([{"role": "user", "content": prompt}], cfg).strip()
    except Exception as e:
        print("[recap] 生成失败：%s" % e, flush=True)
        sess["history"] = dropped + hist   # 失败就放回，不留空洞
        return prev
    if not new:
        sess["history"] = dropped + hist
        return prev
    sess["recap"] = new[:400]
    sess.setdefault("archived_history", []).extend(dropped)
    return sess["recap"]


def web_search(query, cfg):
    """调 DeepSeek Anthropic 兼容接口做一次联网搜索，返回纯文本摘要。"""
    key = (cfg.get("api_key") or "").strip()
    if not key:
        raise RuntimeError("搜索需要 DeepSeek API key：设置页填 api_key")
    base = (cfg.get("search_base") or "https://api.deepseek.com/anthropic/v1").rstrip("/")
    model = cfg.get("search_model") or "deepseek-chat"
    body = {
        "model": model,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Perform a web search for the query: " + query}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + "/messages", data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        j = json.loads(resp.read().decode("utf-8", errors="replace"))
    lines = []
    for block in (j.get("content") or []):
        if block.get("type") == "web_search_tool_result":
            for r in (block.get("content") or []):
                if r.get("type") == "web_search_result":
                    lines.append("- %s %s" % (r.get("title") or "", r.get("url") or ""))
    if not lines:
        for block in (j.get("content") or []):
            if block.get("type") == "text" and block.get("text"):
                lines.append(block["text"].strip())
    if not lines:
        raise RuntimeError("搜索接口没有返回结果")
    return "\n".join(lines[:8])


def maybe_search_context(user_input, cfg):
    """判断本轮是否需要联网，需要则返回检索摘要（失败返回空串，不阻断剧情）。"""
    if not cfg.get("search_enabled", True):
        return ""
    if not (cfg.get("api_key") or "").strip():
        return ""
    if not _SEARCH_HINTS.search(user_input or ""):
        return ""
    try:
        return web_search(user_input, cfg)
    except Exception as e:
        print("[search] 失败：%s" % e, flush=True)
        return ""


def build_messages(script, history, user_input, cfg):
    """第一版：只拼「剧本设定 + 历史 + 本轮输入」"""
    sys_parts = []

    name = script.get("name", "未命名剧本")
    sys_parts.append("你现在在一个名为《%s》的互动剧情中扮演角色。" % name)

    if script.get("world"):
        sys_parts.append("【世界观】\n" + script["world"].strip())
    if script.get("character"):
        sys_parts.append("【你的角色】\n" + script["character"].strip())
    if script.get("user_role"):
        sys_parts.append("【对方的身份】\n" + script["user_role"].strip())
    if script.get("rules"):
        sys_parts.append("【补充规则】\n" + script["rules"].strip())

    sys_parts.append(
        "以第一人称沉浸式推进剧情，直接写正文，不解释、不评论、不跳出角色。"
        "每次回复写 800–2000 字。"
    )

    messages = [{"role": "system", "content": "\n\n".join(sys_parts)}]

    # 开场白作为 assistant 的第一句
    if script.get("opening"):
        messages.append({"role": "assistant", "content": script["opening"].strip()})

    for h in history[-20:]:
        role = h.get("role")
        if role in ("user", "assistant") and h.get("content"):
            messages.append({"role": role, "content": h["content"]})

    if user_input:
        messages.append({"role": "user", "content": user_input})

    return messages


# ══════════════════════════════ 组装 ══════════════════════════════
try:
    import assemble as assembler
except Exception:
    assembler = None


def _load_all(kind):
    """读某个目录下所有 json"""
    d = DIRS[kind]
    out = []
    try:
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".json"):
                obj = load_json(os.path.join(d, fn))
                if isinstance(obj, dict):
                    out.append(obj)
    except Exception:
        pass
    return out


def _body_chars(text):
    """
    只数正文：删掉所有「选项：」开头的块。
    选项块 = 从「选项：」开始，到下一个空行+非选项行为止。
    简化做法：按「选项：」切分，每段取「第一个空行之前」的部分，再拼起来。
    """
    if not text:
        return 0
    # 按「选项：」切分（行首）
    segs = re.split(r"^\s*选项[：:]\s*$", text, flags=re.M)
    body_parts = []
    for i, seg in enumerate(segs):
        if i == 0:
            body_parts.append(seg)
            continue
        # 后续段：跳过开头的选项列表，取第一个空行之后的内容
        lines = seg.split("\n")
        j = 0
        while j < len(lines):
            ln = lines[j].strip()
            if not ln:
                j += 1
                continue
            # 选项行：以数字开头
            if re.match(r"^(?:选项)?\s*\d+[.、．]", ln):
                j += 1
                continue
            break
        rest = "\n".join(lines[j:])
        if rest.strip():
            body_parts.append(rest)
    t = "\n".join(body_parts)
    t = re.sub(r"[#*>`\-]{1,}", "", t)
    t = re.sub(r"\s+", "", t)
    return len(t)


def _split_options(reply):
    """
    把回复拆成 (正文, 选项块)。
    选项块 = 从「选项：」开始到结尾（含所有选项行）。
    没有选项块则返回 (原文, "")。
    """
    if not reply:
        return reply, ""
    m = re.search(r"^\s*选项[：:]\s*$", reply, flags=re.M)
    if not m:
        return reply, ""
    body = reply[:m.start()].rstrip()
    opt = reply[m.start():].strip()
    return body, opt


def _clean_options(reply):
    """
    删掉前面所有「选项：」块，只保留最后一块。
    正文段全部保留。
    """
    if not reply:
        return reply

    lines = reply.split("\n")
    out = []
    in_opt_block = False       # 当前是否在选项块内
    opt_blocks = []            # 收集到的选项块（每块一行行）

    for ln in lines:
        stripped = ln.strip()
        # 是否是「选项：」标题行
        if re.match(r"^选项[：:]\s*$", stripped):
            in_opt_block = True
            opt_blocks.append([ln])
            continue

        if in_opt_block:
            # 选项行 → 继续收集
            if re.match(r"^(?:选项)?\s*\d+[.、．]", stripped):
                opt_blocks[-1].append(ln)
                continue
            # 空行 → 可能是选项块结束，也可能是选项块内空行
            if stripped == "":
                # 看下一行是不是选项行
                opt_blocks[-1].append(ln)
                continue
            # 非选项行 → 选项块结束，这行属于正文
            in_opt_block = False
            out.append(ln)
            continue

        out.append(ln)

    # 只保留最后一个选项块（去掉末尾的空行）
    if not opt_blocks:
        return "\n".join(out).strip()

    last = opt_blocks[-1]
    # 去掉块尾的空行
    while last and last[-1].strip() == "":
        last.pop()

    body = "\n".join(out).strip()
    return body + "\n\n" + "\n".join(last).strip()


def _validate_options(opt_block, has_ntr):
    """校验选项块是否完整：数量够 + 无空话模板。返回 (是否通过, 问题)。"""
    if not opt_block:
        return False, "空"
    opt_lines = [l.strip() for l in opt_block.split("\n")
                 if re.match(r"^(?:选项)?\s*\d+[.、．]", l.strip())]
    need = 7 if has_ntr else 6
    if len(opt_lines) < need:
        return False, "选项 %d 条，缺 %d 条" % (len(opt_lines), need - len(opt_lines))
    # 空话/模板词检测（这些是「没具体化」的标志）
    VAGUE = ("继续往下", "推动主线", "推进剧情", "推动剧情", "做点日常", "更过火",
             "跳过一段时间", "留空，由玩家填写", "具体动作", "具体时间", "具体背德")
    for l in opt_lines:
        if any(v in l for v in VAGUE):
            return False, "含空话模板：" + l[:24]
    return True, "ok"


def _validate_custom_options(opt_block, option_template):
    """校验剧本自定义选项格式（A-G 字母 + 【标签】）。返回 (是否通过, 问题)。"""
    if not opt_block:
        return False, "空"
    if not option_template:
        return False, "无模板"
    tpl = []
    for line in option_template:
        m = re.match(r"^\s*([A-G])\.\s*【([^】]+)】", line)
        if m:
            tpl.append((m.group(1), m.group(2)))
    if not tpl:
        return False, "模板无有效字母"
    if re.search(r"^\s*选项\d+\.", opt_block, re.M):
        return False, "混入「选项N.」旧格式"
    for letter, tag in tpl:
        if not re.search(r"^\s*%s\.\s*【" % letter, opt_block, re.M):
            return False, "缺 %s.【%s】" % (letter, tag)
    return True, "ok"


# ══════ 关系 → 初始心体值（A+C：通用映射 + 角色卡 relation_presets 覆盖）══════
# 关系词 → (heart, body, heart_note, body_note)
RELATION_PRESETS = {
    "夫妻": (100, 60, "命定（夫妻）", "很熟（夫妻）"),
    "妻子": (100, 60, "命定（夫妻）", "很熟（夫妻）"),
    "老公": (100, 60, "命定（夫妻）", "很熟（夫妻）"),
    "夫君": (100, 60, "命定（夫妻）", "很熟（夫妻）"),
    "结婚": (100, 60, "命定（夫妻）", "很熟（夫妻）"),
    "已婚": (100, 60, "命定（夫妻）", "很熟（夫妻）"),
    "情侣": (80, 50, "亲密（恋人）", "合适（恋人）"),
    "恋人": (80, 50, "亲密（恋人）", "合适（恋人）"),
    "爱人": (80, 50, "亲密（恋人）", "合适（恋人）"),
    "男朋友": (80, 50, "亲密（恋人）", "合适（恋人）"),
    "女朋友": (80, 50, "亲密（恋人）", "合适（恋人）"),
    "暗恋": (40, 20, "熟悉（暗恋）", "不契合（暗恋）"),
    "暧昧": (40, 20, "熟悉（暧昧）", "不契合（暧昧）"),
    "朋友": (30, 10, "熟悉（朋友）", "不契合（朋友）"),
    "熟人": (30, 10, "熟悉（熟人）", "不契合（熟人）"),
    "陌生人": (0, 0, "陌生人", "未契合"),
    "初次见面": (0, 0, "陌生人", "未契合"),
}

# 长词优先匹配（避免「夫妻」被「妻子」提前命中之类）
RELATION_ORDER = ["夫妻", "妻子", "老公", "夫君", "结婚", "已婚",
                  "情侣", "恋人", "爱人", "男朋友", "女朋友",
                  "暗恋", "暧昧", "朋友", "熟人", "陌生人", "初次见面"]


def _detect_relation(text, card=None):
    """检测关系词 → (heart, body, heart_note, body_note)。
    角色卡 relation_presets 优先，通用映射兜底；都没有返回 None。"""
    if not text:
        return None
    # 角色卡自定义预设优先（键是关系词，值是 {heart, body, heart_note?, body_note?}）
    presets = (card or {}).get("relation_presets") or {}
    for rel, cfg in presets.items():
        if rel and rel in text:
            try:
                return (float(cfg.get("heart", 0)), float(cfg.get("body", 0)),
                        cfg.get("heart_note", rel), cfg.get("body_note", ""))
            except Exception:
                continue
    # 通用映射
    for rel in RELATION_ORDER:
        if rel in text:
            h, b, hn, bn = RELATION_PRESETS[rel]
            return (float(h), float(b), hn, bn)
    return None



def _ensure_session_npcs(sess):
    """给 active_npcs 里新加的角色补 state.npcs 条目（不动已有数值）。"""
    if not sess:
        return
    st = sess.setdefault("state", {})
    npcs = st.setdefault("npcs", {})
    for cid in (sess.get("active_npcs") or []):
        k = str(cid)
        if k in npcs:
            continue
        fp = _find_char_file(cid)
        if not fp:
            continue
        card = load_json(fp) or {}
        prof = card.get("profile") or {}
        init = card.get("initial_state") or {}
        npcs[k] = {
            "name": card.get("name", ""),
            "category": card.get("category", ""),
            "relation": "陌生人",
            "evil_progress": 0,
            "gender": prof.get("gender", ""),
            "age": prof.get("age", ""),
            "height": prof.get("height", ""),
            "weight": prof.get("weight", ""),
            "measurements": prof.get("measurements", ""),
            "personality": prof.get("personality", ""),
            "identity": prof.get("identity", ""),
            "appearance": prof.get("appearance", ""),
            "body_data": card.get("body_data") or {},
            "heart": init.get("heart", init.get("affection", 0)),
            "heart_note": init.get("heart_note", init.get("affection_note", "")),
            "body": init.get("body", 0),
            "body_note": init.get("body_note", ""),
            "womb_broken": bool(init.get("womb_broken", False)),
            "married": bool(init.get("married", False)),
            "pregnant": bool(init.get("pregnant", False)),
            "outfit": init.get("outfit", ""),
            "location": init.get("location", ""),
            "mood": init.get("mood", ""),
            "inner_voice": init.get("inner_voice", ""),
        }

def _init_state(sess):
    """
    建会话时初始化 state：
      player  玩家状态
      npcs    登场角色（从角色卡 profile + initial_state 拷）
      extras  周边角色（AI 自动生成，初始为空）
    """
    state = {"player": {}, "npcs": {}, "extras": {}}

    # ── 玩家 ──
    p = dict(sess.get("player") or {})
    for k, v in list(p.items()):
        state["player"][k] = v
    state["player"].setdefault("location", "")
    state["player"].setdefault("mood", "")
    state["player"].setdefault("outfit", "")
    state["player"].setdefault("items", [])
    state["player"].setdefault("money", "")

    # ── 关系文本：玩家「其他设定」+ 剧本 story/world（用于推断初始心体值）──
    _rel_text = ""
    _p = sess.get("player") or {}
    _rel_text += (_p.get("extra") or "") + "\n"
    _sid = sess.get("script_id") or ""
    if _sid:
        _sd = DIRS.get("scripts") or ""
        try:
            for _fn in os.listdir(_sd):
                if not _fn.endswith(".json"):
                    continue
                _o = load_json(os.path.join(_sd, _fn))
                if isinstance(_o, dict) and _o.get("id") == _sid:
                    _rel_text += (_o.get("story") or "") + "\n" + (_o.get("world") or "") + "\n"
                    break
        except Exception:
            pass

    # ── 登场角色 ──
    for cid in (sess.get("active_npcs") or []):
        fp = _find_char_file(cid)
        if not fp:
            continue
        card = load_json(fp)
        if not card:
            continue
        prof = card.get("profile") or {}
        init = card.get("initial_state") or {}
        # 关系映射：角色卡 relation_presets 优先，通用映射兜底
        _rel = _detect_relation(_rel_text, card)
        if _rel:
            _h, _b, _hn, _bn = _rel
        else:
            _h = init.get("heart", init.get("affection", 0))
            _b = init.get("body", 0)
            _hn = init.get("heart_note", init.get("affection_note", ""))
            _bn = init.get("body_note", "")
        # 关系名（用于恶堕对象判定：夫妻/情侣 → lover，陌生/第三者 → ntr）
        _relation_name = ""
        for _w in ("夫妻", "情侣", "恋人", "爱人", "暗恋", "暧昧", "朋友", "熟人", "陌生人"):
            if _w in str(_hn or ""):
                _relation_name = _w
                break
        if not _relation_name:
            _relation_name = "陌生人"
        state["npcs"][str(cid)] = {
            "name": card.get("name", ""),
            "category": card.get("category", ""),
            # 关系 + 恶堕进度（用于恶堕对象判定与累积）
            "relation": _relation_name,
            "evil_progress": 0,
            # 静态（来自 profile）
            "gender": prof.get("gender", ""),
            "age": prof.get("age", ""),
            "height": prof.get("height", ""),
            "weight": prof.get("weight", ""),
            "measurements": prof.get("measurements", ""),
            "personality": prof.get("personality", ""),
            "identity": prof.get("identity", ""),
            "appearance": prof.get("appearance", ""),
            # 身体分级（静态）
            "body_data": card.get("body_data") or {},
            # 双轴（动态）——关系映射优先，initial_state 兜底
            "heart": _h,
            "heart_note": _hn,
            "body": _b,
            "body_note": _bn,
            # 阶段
            "womb_broken": bool(init.get("womb_broken", False)),
            "married": bool(init.get("married", False)),
            "pregnant": bool(init.get("pregnant", False)),
            # 其他动态
            "outfit": init.get("outfit", ""),
            "location": init.get("location", ""),
            "mood": init.get("mood", ""),
            "inner_voice": init.get("inner_voice", ""),
        }

    return state


_PLACEHOLDER_WORDS = {
    "未变", "不变", "无变化", "没有变化", "同上", "同前", "无", "（无）", "(无)",
    "none", "null", "n/a", "-", "—", "未变化",
}


def _is_placeholder(v):
    """AI 有时把 diff 占位词当真值返回，这里过滤掉"""
    if not isinstance(v, str):
        return False
    s = v.strip()
    if not s:
        return True
    if s in _PLACEHOLDER_WORDS:
        return True
    for w in ("未变", "不变", "无变化", "没有变化", "同上"):
        if s.startswith(w) and len(s) <= len(w) + 6:
            return True
    return False


def _apply_meta_max(state, meta):
    """
    元命令：把双轴推到「当前实际上限」（引擎 5.6），并触发解锁层级链。
    顺序（先 heart 后 body）：
      heart 到 100 → 结婚（heart 上限 100→150）
      婚后 body 到 100 → 孕子（heart 上限 150→200）
    body 上限：常规 100，破宫过（womb_broken）→ 200。
    """
    for cid, cs in (state.get("npcs") or {}).items():
        if meta.get("heart"):
            # heart 上限：孕子 200 / 结婚 150 / 常规 100
            if cs.get("pregnant"):
                cs["heart"] = 200.0
                cs["heart_note"] = "共生（已孕子）"
            elif cs.get("married"):
                cs["heart"] = 150.0
                cs["heart_note"] = "命定（已结婚）"
            else:
                cs["heart"] = 100.0
                cs["married"] = True                       # heart 100 → 结婚
                cs["heart_note"] = "命定（已结婚）"
        if meta.get("body"):
            # body 上限：破宫/孕子 → 200，常规 → 100（引擎 5.6）
            if cs.get("womb_broken") or cs.get("pregnant"):
                cs["body"] = 200.0
                cs["body_note"] = "彻底重塑（上限）"
            else:
                cs["body"] = 100.0
                cs["body_note"] = "极佳（上限）"
            if cs.get("married") and not cs.get("pregnant"):
                cs["pregnant"] = True                      # 婚后 body 100 → 孕子
                cs["body"] = 200.0
                cs["heart_note"] = "共生（已孕子）"
                cs["body_note"] = "已孕子（上限）"


def _merge_state(state, delta_in, tier=None, cards=None, L=None, breaker=None, breaker_kind=None):
    """
    把 AI 返回的状态增量合并进 state（只覆盖出现的非空字段）。

    tier:  引擎算出的档位。给了就用引擎 5.1 的定值结算（Δ体定值 + Δ心按原型加权），
           并应用修正 B/C/D、破宫 press 上移（5.4）、corruption 记录（5.5）。
    cards: {角色名: 角色卡}，取 archetype 和原始 press 用。
    """
    if not isinstance(delta_in, dict):
        return state
    delta = delta_in
    cards = cards or {}

    # 玩家
    dp = delta.get("player") or {}
    if isinstance(dp, dict):
        for k, v in dp.items():
            if v in (None, "", [], {}):
                continue
            if _is_placeholder(v):
                continue
            state.setdefault("player", {})[k] = v

    # 登场角色（按 name 匹配）
    dn = delta.get("npcs") or {}
    if not isinstance(dn, dict):
        dn = {}
    # 有引擎档位时，确保所有在场角色都参与结算（即使 AI 没返回这个角色）
    if tier:
        for _cid, _cs in (state.get("npcs") or {}).items():
            _nm = _cs.get("name")
            if _nm and _nm not in dn:
                dn[_nm] = {}
    if dn:
        for cname, cv in dn.items():
            if not isinstance(cv, dict):
                continue
            for cid, cs in (state.get("npcs") or {}).items():
                if cs.get("name") == cname:
                    _card = cards.get(cname) or {}
                    _arch = judge.get_archetype(_card)

                    # ★ 身体释放 → 先标记破宫（body 上限 100 → 200）
                    if tier == "身体释放":
                        cs["womb_broken"] = True

                    # ══ 双轴结算（引擎 5.1）══
                    for axis in ("heart", "body"):
                        if tier:
                            # 引擎算定：Δ体 用定值，Δ心 用原型加权
                            dv = judge.delta_body(tier) if axis == "body" else judge.delta_heart(tier, _arch)
                        else:
                            # 无引擎档位：回退到 AI 给的 delta
                            dk = axis + "_delta"
                            if dk not in cv:
                                continue
                            try:
                                dv = float(cv.pop(dk) or 0)
                            except Exception:
                                dv = 0.0

                        # ── 修正 B：未及档断崖（每 4 次额外 −25）──
                        if axis == "heart":
                            if tier == "无法满足":
                                cs["unmet_count"] = int(cs.get("unmet_count") or 0) + 1
                                if cs["unmet_count"] % 4 == 0:
                                    dv -= 25
                            elif tier:
                                cs["unmet_count"] = 0

                        # ── 修正 C：心高时惩罚减半（只作用于负值）──
                        if axis == "heart" and dv < 0:
                            cur = float(cs.get("heart") or 0)
                            if cur < 40:
                                mult = 1.0
                            elif cur < 60:
                                mult = 0.5
                            else:
                                mult = 0.25
                            dv = dv * mult

                        # ── 修正 D：♥体 > 100 时，负 Δ体 ×2 ──
                        if axis == "body" and dv < 0:
                            cur = float(cs.get("body") or 0)
                            if cur > 100:
                                dv = dv * 2

                        # ── 应用（带 5.6 上限）──
                        if axis == "heart":
                            hi = judge.heart_ceiling(cs)
                            nv = max(0.0, min(hi, float(cs.get("heart") or 0) + dv))
                            cs["heart"] = round(nv, 1)
                            # 解锁：♥心 到 100 → 结婚（上限 100→150）
                            if nv >= 100 and not cs.get("married"):
                                cs["married"] = True
                                if not cs.get("heart_note"):
                                    cs["heart_note"] = "命定（已结婚）"
                        else:
                            hi = judge.body_ceiling(cs)
                            nv = max(0.0, min(hi, float(cs.get("body") or 0) + dv))
                            cs["body"] = round(nv, 1)
                            # 解锁：婚后 ♥体 到 100 → 孕子（heart 上限 150→200）
                            if nv >= 100 and cs.get("married") and not cs.get("pregnant"):
                                cs["pregnant"] = True
                                cs["heart_note"] = "共生（已孕子）"

                    # ★ 身体释放 → corruption 记录 + press 上移（5.4 / 5.5）
                    if tier == "身体释放":
                        _old = cs.get("corruption") or {}
                        # 基准 = 原始 press（press_before），用于记录
                        _raw = _old.get("press_before")
                        if _raw is None:
                            _raw = judge.get_current_press(_card, {})
                        if _raw and L is not None:
                            # press 上移 = 破宫肉棒尺寸 L（用户规则：被 36 破宫 press 上移到 36）
                            try:
                                _now = float(L)
                            except Exception:
                                _now = float(_raw)
                            # 拒绝线 = 破宫肉棒尺寸 L（= press_now）；破宫·初 无拒绝线
                            _rl = _now   # 三段：身体释放即给拒绝线
                            cs["corruption"] = {
                                "tier": tier,
                                "by": breaker or (state.get("player") or {}).get("name", ""),
                                "press_before": float(_raw),
                                "press_now": _now,
                                "reject_line": _rl,
                            }

                    # ★ 恶堕累积（身体释放时，按对象：lover +0 / ntr +2 / force +1）
                    if tier == "身体释放":
                        _kind = breaker_kind
                        if not _kind:
                            _rel = cs.get("relation") or ""
                            if _rel in ("夫妻", "情侣", "恋人", "爱人"):
                                _kind = "lover"
                            elif breaker and breaker in judge.LOVER_WORDS:
                                _kind = "lover"
                            elif breaker and breaker in judge.NTR_WORDS:
                                _kind = "ntr"
                            else:
                                _kind = "lover"
                        _inc = judge.evil_delta(_kind)
                        if _inc:
                            _cur = int(cs.get("evil_progress") or 0)
                            _new = _cur + _inc
                            cs["evil_progress"] = _new
                            cs["evil_note"] = judge.evil_stage(_new)[0]
                            if _new >= 5:
                                cs["evil_done"] = True
                    # 其他字段直接覆盖
                    for k, v in cv.items():
                        if k.endswith("_delta"):
                            continue
                        if v in (None, "", [], {}):
                            continue
                        if _is_placeholder(v):
                            continue
                        cs[k] = v
                    # 阶段字段（bool）
                    for bk in ("womb_broken", "married", "pregnant"):
                        if bk in cv:
                            cs[bk] = bool(cv[bk])
                    break

    # 周边角色
    de = delta.get("extras") or {}
    if isinstance(de, dict):
        ex = state.setdefault("extras", {})
        for ename, ev in de.items():
            if not isinstance(ev, dict):
                continue
            if ename not in ex:
                # 上限 10 个
                if len(ex) >= 10:
                    continue
                ex[ename] = {
                    "role": ev.get("role", "路人"),
                    "appearance": ev.get("appearance", ""),
                    "personality": ev.get("personality", ""),
                    "relation": ev.get("relation", ""),
                    "affection": ev.get("affection", 0),
                    "location": ev.get("location", ""),
                    "mood": ev.get("mood", ""),
                    "first_seen": ev.get("first_seen", 0),
                    "last_seen": ev.get("last_seen", 0),
                    "status": ev.get("status", "active"),
                }
            else:
                for k, v in ev.items():
                    if v in (None, "", [], {}):
                        continue
                    if _is_placeholder(v):
                        continue
                    ex[ename][k] = v

    return state


def _strip_options_for_stm(reply):
    """给 STM 兜底用：去掉选项区，取正文开头"""
    if not reply:
        return ""
    m = re.search(r"^\s*选项[：:]", reply, flags=re.M)
    body = reply[:m.start()] if m else reply
    body = re.sub(r"[#*>`\-]{1,}", "", body)
    return body.strip()


def _extract_json(text):
    """从 AI 输出里抠出第一个完整 JSON 对象"""
    if not text:
        return None
    # 去掉 markdown 代码块
    t = re.sub(r"```(?:json)?\s*", "", text)
    t = t.replace("```", "")
    # 找第一个 { 到最后一个 }
    i = t.find("{")
    j = t.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(t[i:j + 1])
    except Exception:
        # 尝试修常见错误：尾逗号
        s = re.sub(r",\s*([}\]])", r"\1", t[i:j + 1])
        try:
            return json.loads(s)
        except Exception:
            return None


STATE_SUFFIX = [
    "",  # 第 1 次：标准

    # 第 2 次：强约束
    "\n\n【强制】只输出一个 JSON 对象。不要 markdown 代码块，不要解释，不要前后缀。"
    "第一个字符必须是 {，最后一个必须是 }。",

    # 第 3 次：降复杂度
    "\n\n【简化】只需要这几个字段：\n"
    '{"player":{"location":"","mood":""},'
    '"npcs":{"角色名":{"affection":0}}}'
    "\n其他字段全部省略。只输出 JSON，不要任何其他文字。",
]


def _build_state_msgs(sess, reply, attempt=0):
    """构造状态更新请求（attempt: 0/1/2 对应三次不同策略）"""
    # 现有状态摘要（让 AI 知道当前值）
    st = sess.get("state") or {}
    npc_names = [x.get("name", "") for x in (st.get("npcs") or {}).values()]
    ext_names = list((st.get("extras") or {}).keys())

    ctx = []
    if npc_names:
        ctx.append("【已在场的登场角色】" + "、".join(npc_names))
    if ext_names:
        ctx.append("【已记录的周边角色】" + "、".join(ext_names))

    base = (
        "你是状态记录员。读下面的剧情，输出一个 JSON。\n\n"
        "【任务】\n"
        "1. 更新玩家和登场角色的「变化」字段（没变的不输出）\n"
        "2. 记录剧情里新出现、有名字或有明确身份的角色（放进 extras）\n"
        "3. 更新已有周边角色的状态\n\n"
        "【周边角色判定】\n"
        "- 只记录有名字或有明确身份的角色\n"
        "- 一次性的「一个路人」「服务员」不用记\n"
        "- 会反复出现、或有剧情作用的才记\n"
        "- role 只能是：黄毛 / 苦主 / 路人 / 长期路人 / 对手\n"
        "- status 只能是：active（在场）/ background（暂时离场）/ gone（不再出现）\n\n"
        "【双轴定义】\n"
        "- ♥心（heart）：-100 ~ 100，性事最低到 0\n"
        "  -100~-60 敌意 / -59~-30 厌恶 / -29~-1 反感 / 0 陌生人\n"
        "  1-20 认识 / 21-40 熟悉 / 41-60 在意 / 61-80 亲密 / 81-100 不可取代\n"
        "- ♠体（body）：0 ~ 100（破宫后 200）\n"
        "  0-20 不契合 / 21-40 勉强 / 41-60 合适 / 61-80 很好 / 81-100 极佳\n\n"
        "【结算规则】\n"
        "1. 精神事件（被理解/被记住/被保护/被需要）→ 只加 ♥心\n"
        "2. 性事契合度 → 主要加 ♠体，契合时也可能小幅加 ♥心\n"
        "3. 性事本身不直接加心。加心的是：事后被抱着说话(+2)、被问「疼不疼」(+3)、被当人而不是洞(+5)\n"
        "4. 单次变化不超过 ±10（破宫等重大事件除外）\n\n"
        "【格式】\n"
        "{\n"
        '  "player": { "location": "", "mood": "", "outfit": "", "money": "" },\n'
        '  "npcs": {\n'
        '    "角色名": {\n'
        '      "heart_delta": 0, "heart_note": "",\n'
        '      "body_delta": 0, "body_note": "",\n'
        '      "outfit": "", "location": "", "mood": "", "inner_voice": "",\n'
        '      "womb_broken": false, "married": false, "pregnant": false\n'
        "    }\n"
        "  },\n"
        '  "extras": { "角色名": { "role": "路人", "appearance": "", "personality": "", "relation": "", "location": "", "mood": "", "status": "active" } },\n'
        '  "stm": { "scene": "地点", "event": "这一轮发生了什么（50-100 字）" }\n'
        "}\n\n"
        "【硬规则】\n"
        "- 只输出 heart_delta / body_delta（变化量），不要输出绝对值\n"
        "- heart_note / body_note 是当前区间的中文描述（如「认识」「不契合」）\n"
        "- inner_voice 是角色此刻心里想的，不超过 40 字\n"
        "- stm.event 写这一轮的关键事实（谁做了什么、关系变化、承诺、地点变化）\n"
        "- 只输出【真正变化】的字段；没变的字段直接省略，不要写进 JSON\n"
        "- 严禁输出「未变」「不变」「无变化」「同上」「（无）」这类占位词——那等于没变，直接不要这个 key\n"
        "- 空字符串也不要输出\n"
        "- 只输出 JSON，不要任何解释\n"
    )

    if ctx:
        base += "\n" + "\n".join(ctx) + "\n"

    base += "\n【剧情】\n" + (reply or "")[:4500]
    base += STATE_SUFFIX[min(attempt, 2)]

    temp = 0.85 if attempt == 0 else 0.1
    return [
        {"role": "system", "content": base},
        {"role": "user", "content": "输出 JSON。"},
    ]



_PU_NUM = r"(\d+(?:\.\d+)?)"
_PU_DELTA = ("上调", "增加", "加大", "加长", "加粗", "变长", "长到")


def _apply_player_updates(sess, text):
    """从玩家输入里抓身体数值，直接写回 session.player / state.player。"""
    if not text:
        return
    player = sess.get("player") or {}
    state = sess.setdefault("state", {})
    sp = state.setdefault("player", {})

    def _set(key, val):
        player[key] = val
        sp[key] = val

    def _cur(key, default=0.0):
        try:
            return float(player.get(key) or default)
        except Exception:
            return default

    def _is_delta(seg):
        return any(w in seg for w in _PU_DELTA) and ("到" not in seg)

    # 肉棒长度 / 尺寸
    _len_done = False
    m = re.search(r"(?:肉棒|阴茎|鸡巴|尺寸|长度)[^\d]{0,8}" + _PU_NUM + r"\s*(?:cm|厘米)?", text)
    if m:
        v = float(m.group(1))
        seg = text[max(0, m.start() - 6):m.end() + 6]
        _set("length", str(int(v + _cur("length")) if _is_delta(seg) else int(v)))
        _len_done = True
    # 「36cm长」这种写法兜底
    if not _len_done:
        m2 = re.search(r"(\d+(?:\.\d+)?)\s*(?:cm|厘米)\s*长", text)
        if m2:
            _set("length", str(int(float(m2.group(1)))))
    # 茎身直径 / 龟头直径
    m = re.search(r"(?:茎身直径|直径|粗度)[^\d]{0,6}" + _PU_NUM + r"\s*(?:cm|厘米)?", text)
    if not m:
        m = re.search(r"(\d+(?:\.\d+)?)\s*(?:cm|厘米)\s*粗", text)
        if m:
            _set("shaft_diameter", str(round(float(m.group(1)), 1)))
    if m:
        v = float(m.group(1))
        seg = text[max(0, m.start() - 6):m.end() + 6]
        _set("shaft_diameter", str(round(v + _cur("shaft_diameter"), 1) if _is_delta(seg) else v))
    # 三围 / 身高
    for k, words in (("bust", ("胸围", "罩杯")), ("waist", ("腰围",)), ("hip", ("臀围",)), ("height", ("身高",))):
        m = re.search(r"(?:" + "|".join(words) + r")[^\d]{0,6}" + _PU_NUM, text)
        if m:
            _set(k, str(int(float(m.group(1)))))
    # 敏感度 / 受孕
    for k, words in (("sensitivity", ("敏感度",)), ("fertility", ("受孕体质", "受孕"))):
        m = re.search(r"(?:" + "|".join(words) + r")[^\d]{0,4}([0-5])", text)
        if m:
            _set(k, m.group(1))
    # 乳量
    for kw, v in (("贫乳", "poor"), ("普乳", "normal"), ("巨乳", "big"), ("爆乳", "huge"), ("超乳", "super")):
        if kw in text:
            _set("milk_volume", v)
            break

def _judge_enabled_now(script, sess):
    """判定引擎 MOD 是否启用 —— 关掉就不做运算层计算"""
    try:
        if assembler is None:
            return False
        mods = _load_all("mods")
        used = assembler.filter_mods(mods, script, sess)
        return bool(assembler.is_judge_enabled(used))
    except Exception:
        return False


def _assemble_for(script, sess, user_input):
    """把六个来源交给组装层"""
    # 分类开关
    cats = load_categories().get("enabled", {})

    # 在场角色（只读被点名的，且分类必须是开着的）
    chars = {}
    for cid in (sess.get("active_npcs") or []):
        p = _find_char_file(cid)
        if not p:
            continue
        obj = load_json(p)
        if not obj:
            continue
        # 补分类
        root = os.path.normpath(DIRS["characters"])
        parent = os.path.dirname(os.path.normpath(p))
        obj["_category"] = "" if parent == root else os.path.basename(parent)
        if not char_available(obj, cats):
            continue        # 分类关了 → 这个角色不注入
        chars[str(cid)] = obj

    worldbooks = _load_all("worldbook")
    _wb_ids = sess.get("worldbook_ids")
    if isinstance(_wb_ids, list):
        _allow = set(str(x) for x in _wb_ids)
        worldbooks = [w for w in worldbooks if str(w.get("id")) in _allow]
    mods = _load_all("mods")

    if assembler is None:
        msgs = build_messages(script, sess.get("history") or [], user_input, get_config())
        return msgs, [("组装层未加载", len(msgs[0]["content"]), "兜底")]

    msgs, report = assembler.assemble(
        script=script,
        session=sess,
        characters=chars,
        worldbooks=worldbooks,
        mods=mods,
        history=sess.get("history") or [],
        user_input=user_input,
    )
    # 修正人设：本轮 prompt 末尾注入校准指令（只生效一次）
    if sess.get("persona_fix"):
        if msgs and msgs[0].get("role") == "system":
            msgs[0]["content"] += (
                "\n\n【人设校准 · 本轮回正】上一轮开始出现了偏离。本轮必须严格回到角色卡："
                "说话方式（口癖/语气/称呼）、性格（铁律）、行为逻辑（她不会做的事就别做）。"
                "不许写成通用角色，不许丢失她的口头禅与立场。"
            )
        sess["persona_fix"] = False
        try:
            _sp = os.path.join(DIRS["sessions"], (sess.get("id") or "") + ".json")
            if sess.get("id") and os.path.isfile(_sp):
                save_json(_sp, sess)
        except Exception:
            pass
    return msgs, report


def write_char_index():
    """重新生成 角色卡总览.md（角色增删改 / 启动时调用）。"""
    try:
        import time as _t
        root = DIRS["characters"]
        out = os.path.join(APP_DIR, "角色卡总览.md")
        items = []
        for dirpath, dirnames, filenames in os.walk(root):
            for fn in filenames:
                if not fn.endswith(".json") or fn.startswith("_"):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    c = load_json(p)
                except Exception:
                    continue
                if isinstance(c, dict):
                    items.append((p, c))
        items.sort(key=lambda x: (x[1].get("name") or ""))

        def _clip(t, n):
            t = (t or "").strip().replace("\n", " ")
            return t[:n] + ("…" if len(t) > n else "")

        L = ["# 角色卡总览\n",
             "> 数据来源：`data/characters/`｜自动生成于 %s\n" % _t.strftime("%Y-%m-%d %H:%M"),
             "> 共 **%d** 个角色\n" % len(items)]
        for p, c in items:
            rel = os.path.relpath(p, APP_DIR).replace("\\", "/")
            prof = c.get("profile") or {}
            bd = c.get("body_data") or {}
            blocks = c.get("blocks") or {}
            core = ((blocks.get("core") or {}).get("text") or (c.get("core") or {}).get("text") or "").strip()
            speech = ((blocks.get("speech") or {}).get("text") or (c.get("speech") or {}).get("text") or "").strip()
            init = c.get("initial_state") or {}
            L.append("\n---\n")
            L.append("## %s（%s）\n" % (c.get("name") or "未命名", c.get("category") or "未分类"))
            L.append("- **文件**：`%s`" % rel)
            L.append("- **别名**：%s" % ("、".join(c.get("aliases") or []) or "—"))
            L.append("- **身高/三围**：%s｜%s" % (prof.get("height") or "—", prof.get("measurements") or "—"))
            L.append("- **体型/气质**：%s｜%s｜press %s" % (
                prof.get("body_type") or "—", prof.get("qizhi") or "—", prof.get("press") or "—"))
            L.append("- **身份**：%s" % _clip(prof.get("identity"), 60))
            L.append("- **外貌**：%s" % _clip(prof.get("appearance"), 80))
            L.append("- **性格**：%s" % _clip(prof.get("personality"), 80))
            if core:
                L.append("- **核心档案**：\n\n```\n%s\n```" % core[:800])
            if speech:
                L.append("- **说话方式**：\n\n```\n%s\n```" % speech[:500])
            parts = []
            for k, label in [("pussy", "小穴"), ("breast", "胸"), ("ass", "臀"), ("mouth", "嘴")]:
                v = bd.get(k)
                if isinstance(v, dict) and v.get("text"):
                    parts.append("  - **%s**%s：%s" % (
                        label, ("（%s）" % v["name"]) if v.get("name") else "", _clip(v.get("text"), 100)))
            if parts:
                L.append("- **身体特征**：")
                L.extend(parts)
            if init:
                L.append("- **初始状态**：♥%s / ♠%s｜%s" % (
                    init.get("heart", 0), init.get("body", 0), _clip(init.get("heart_note"), 30)))
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(L) + "\n")
    except Exception:
        pass


def _find_char_file(cid):
    """在 characters 根目录和子分类里找角色文件"""
    root = DIRS["characters"]
    p = os.path.join(root, str(cid) + ".json")
    if os.path.isfile(p):
        return p
    if os.path.isdir(root):
        for sub in os.listdir(root):
            sp = os.path.join(root, sub)
            if os.path.isdir(sp):
                p2 = os.path.join(sp, str(cid) + ".json")
                if os.path.isfile(p2):
                    return p2
    return None


# ══════════════════════════════ 分类与导入导出 ══════════════════════════════
CATEGORY_FILE = os.path.join(DIRS["characters"], "_categories.json")


def load_categories():
    """返回 {'enabled': {分类名: bool}}"""
    data = load_json(CATEGORY_FILE, {}) or {}
    if "enabled" not in data:
        data["enabled"] = {}
    return data


def save_categories(data):
    save_json(CATEGORY_FILE, data)


def list_categories():
    """扫 characters 下的子文件夹 + 已记录的分类"""
    root = DIRS["characters"]
    found = set()
    if os.path.isdir(root):
        for name in os.listdir(root):
            if os.path.isdir(os.path.join(root, name)):
                found.add(name)
    cfg = load_categories()
    for k in cfg["enabled"].keys():
        found.add(k)

    out = []
    for name in sorted(found):
        d = os.path.join(root, name)
        cnt = 0
        if os.path.isdir(d):
            cnt = len([f for f in os.listdir(d) if f.endswith(".json") and not f.startswith("_")])
        out.append({
            "name": name,
            "count": cnt,
            "enabled": cfg["enabled"].get(name, True),   # 默认开
        })
    # 未分类
    root_cnt = 0
    if os.path.isdir(root):
        root_cnt = len([f for f in os.listdir(root) if f.endswith(".json") and not f.startswith("_")])
    if root_cnt:
        out.insert(0, {"name": "", "count": root_cnt, "enabled": cfg["enabled"].get("", True)})
    return out


def char_available(char, cats_enabled):
    """角色是否可用：分类开 && 自身 enabled"""
    if char.get("enabled") is False:
        return False
    cat = char.get("_category", "")
    return cats_enabled.get(cat, True)


# ══════════════════════════════ 路由 ══════════════════════════════
LOG_PATH = os.path.join(BASE, "fy_server.log")


def _log(line):
    """pythonw 下 sys.stderr 是 None，必须自己兜底；同时落盘"""
    try:
        text = "[%s] %s\n" % (time.strftime("%H:%M:%S"), line)
        if getattr(sys, "stderr", None):
            try:
                sys.stderr.write(text)
                sys.stderr.flush()
            except Exception:
                pass
        try:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 2 * 1024 * 1024:
                os.remove(LOG_PATH)
        except Exception:
            pass
        with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as f:
            f.write(text)
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "FyRunner/0.1"

    def log_message(self, fmt, *args):
        try:
            _log(fmt % args)
        except Exception:
            pass

    # ---------- 响应工具 ----------
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json_ok(self, data=None):
        self._send(200, {"ok": True, "data": data})

    def _json_err(self, msg, code=400):
        self._send(code, {"ok": False, "error": str(msg)})

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n).decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            return {}

    # ---------- 静态文件 ----------
    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(os.path.normpath(WEB)):
            self._send(403, "forbidden", "text/plain; charset=utf-8")
            return
        if not os.path.isfile(full):
            self._send(404, "not found", "text/plain; charset=utf-8")
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, ctype)

    # ---------- 通用 CRUD ----------
    def _scan_dir(self, root):
        """递归一层子文件夹：子文件夹 = 分类"""
        items = []
        if not os.path.isdir(root):
            return items
        # 根目录下的文件（未分类）
        for fn in sorted(os.listdir(root)):
            fp = os.path.join(root, fn)
            if os.path.isfile(fp) and fn.endswith(".json") and not fn.startswith("_"):
                obj = load_json(fp)
                if isinstance(obj, dict):
                    obj.setdefault("_category", "")
                    items.append(obj)
        # 子文件夹
        for sub in sorted(os.listdir(root)):
            sp = os.path.join(root, sub)
            if not os.path.isdir(sp):
                continue
            for fn in sorted(os.listdir(sp)):
                fp = os.path.join(sp, fn)
                if os.path.isfile(fp) and fn.endswith(".json") and not fn.startswith("_"):
                    obj = load_json(fp)
                    if isinstance(obj, dict):
                        obj["_category"] = sub
                        items.append(obj)
        items.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
        return items

    def _crud_list(self, kind):
        items = self._scan_dir(DIRS[kind])
        self._json_ok(items)

    def _path_for(self, kind, oid, category=""):
        """根据分类决定存放位置"""
        if category:
            d = os.path.join(DIRS[kind], category)
            os.makedirs(d, exist_ok=True)
            return os.path.join(d, oid + ".json")
        return os.path.join(DIRS[kind], oid + ".json")

    def _find_file(self, kind, oid):
        """在根目录和所有子文件夹里找这个 id"""
        root = DIRS[kind]
        p = os.path.join(root, oid + ".json")
        if os.path.isfile(p):
            return p
        if os.path.isdir(root):
            for sub in os.listdir(root):
                sp = os.path.join(root, sub)
                if os.path.isdir(sp):
                    p2 = os.path.join(sp, oid + ".json")
                    if os.path.isfile(p2):
                        return p2
        return None

    def _crud_get(self, kind, oid):
        p = self._find_file(kind, oid)
        if not p:
            return self._json_err("not found", 404)
        obj = load_json(p)
        if obj is None:
            return self._json_err("not found", 404)
        # 补分类
        root = os.path.normpath(DIRS[kind])
        parent = os.path.dirname(os.path.normpath(p))
        obj["_category"] = "" if parent == root else os.path.basename(parent)
        self._json_ok(obj)

    def _crud_create(self, kind, data, prefix):
        oid = data.get("id") or new_id(prefix)
        obj = dict(data)
        obj["id"] = oid
        category = obj.pop("_category", "") or obj.get("category", "") or ""
        obj.pop("category", None)
        obj.setdefault("created_at", now_ts())
        obj["updated_at"] = now_ts()

        # 会话：初始化 state（玩家 / 登场角色 / 周边角色）
        if kind == "sessions" and not obj.get("state"):
            obj["state"] = _init_state(obj)

        save_json(self._path_for(kind, oid, category), obj)
        obj["_category"] = category
        if kind == "characters":
            write_char_index()
        self._json_ok(obj)

    def _crud_update(self, kind, oid, data):
        p = self._find_file(kind, oid)
        if not p:
            return self._json_err("not found", 404)
        obj = load_json(p) or {}
        backup_before_write(kind, oid, p)   # 改动前留一份，误删可回滚
        old_cat = ""
        root = os.path.normpath(DIRS[kind])
        parent = os.path.dirname(os.path.normpath(p))
        if parent != root:
            old_cat = os.path.basename(parent)

        new_cat = data.pop("_category", None)
        if new_cat is None:
            new_cat = data.get("category", old_cat)
        data.pop("category", None)

        obj.update(data)
        obj["id"] = oid
        obj["updated_at"] = now_ts()
        if kind == "sessions":
            try:
                _ensure_session_npcs(obj)
            except Exception:
                pass

        # 分类变了 → 移动文件
        if str(new_cat or "") != str(old_cat or ""):
            try:
                os.remove(p)
            except Exception:
                pass
            save_json(self._path_for(kind, oid, new_cat or ""), obj)
        else:
            save_json(p, obj)

        obj["_category"] = new_cat or ""
        if kind == "characters":
            write_char_index()   # 角色改动后立即刷新「角色卡总览.md」
        self._json_ok(obj)

    def _crud_delete(self, kind, oid):
        p = self._find_file(kind, oid)
        if p and os.path.exists(p):
            backup_before_write(kind, oid, p)
            os.remove(p)
            if kind == "characters":
                write_char_index()
            return self._json_ok({"deleted": oid})
        self._json_err("not found", 404)

    # ---------- HTTP 方法 ----------
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)

        try:
            if path.startswith("/api/"):
                return self._api_get(path, q)
            return self._serve_static(path)
        except Exception as e:
            if isinstance(e, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
                return  # 客户端已断开（用户刷新/取消），静默，不当成服务端错误
            self._json_err(e, 500)

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path
        try:
            if path.startswith("/api/"):
                return self._api_post(path, self._read_body())
            self._json_err("not found", 404)
        except Exception as e:
            if isinstance(e, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
                return  # 客户端已断开（用户刷新/取消），静默，不当成服务端错误
            self._json_err(e, 500)

    def do_PUT(self):
        u = urlparse(self.path)
        try:
            if u.path.startswith("/api/"):
                return self._api_put(u.path, self._read_body())
            self._json_err("not found", 404)
        except Exception as e:
            if isinstance(e, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
                return  # 客户端已断开（用户刷新/取消），静默，不当成服务端错误
            self._json_err(e, 500)

    def do_DELETE(self):
        u = urlparse(self.path)
        try:
            if u.path.startswith("/api/"):
                return self._api_delete(u.path)
            self._json_err("not found", 404)
        except Exception as e:
            if isinstance(e, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
                return  # 客户端已断开（用户刷新/取消），静默，不当成服务端错误
            self._json_err(e, 500)

    # ---------- API 分发 ----------
    def _api_get(self, path, q):
        # 分类列表
        if path == "/api/categories":
            return self._json_ok(list_categories())

        # 导出
        if path == "/api/export":
            kind = (q.get("kind") or ["characters"])[0]
            ids = (q.get("ids") or [""])[0]
            if kind not in DIRS:
                return self._json_err("未知类型")
            all_items = self._scan_dir(DIRS[kind])
            if ids:
                want = set(ids.split(","))
                all_items = [x for x in all_items if x.get("id") in want]
            # 清理内部字段
            out_items = []
            for it in all_items:
                o = dict(it)
                cat = o.pop("_category", "")
                if kind == "characters" and cat:
                    o["category"] = cat
                out_items.append(o)
            return self._json_ok({
                "version": 1,
                "kind": kind,
                "count": len(out_items),
                "items": out_items if kind != "characters" else [],
                "characters": out_items if kind == "characters" else [],
            })

        # /api/scripts, /api/scripts/<id>
        m = re.match(r"^/api/(scripts|characters|worldbook|mods|sessions)(?:/([^/]+))?$", path)
        if m:
            kind, oid = m.group(1), m.group(2)
            if SHARE and kind != "mods":
                return self._json_ok([] if not oid else None)
            return self._crud_get(kind, oid) if oid else self._crud_list(kind)

        if path == "/api/settings":
            cfg = get_config()
            cfg["api_key"] = "***" if cfg.get("api_key") else ""
            return self._json_ok(cfg)

        if path == "/api/mode":
            return self._json_ok({"share": SHARE})

        if path == "/api/health":
            return self._json_ok({
                "version": "0.1",
                "time": now_ts(),
                "pid": os.getpid(),
                "port": self.server.server_address[1],
            })

        # ── 生成中实时预览：返回 buf 里 from 之后的增量 ──
        if path == "/api/chat/tail":
            rid = (q.get("rid") or [""])[0]
            try:
                frm = int((q.get("from") or ["0"])[0])
            except Exception:
                frm = 0
            j = job_get(rid)
            if not j:
                return self._json_ok({"text": "", "n": 0, "closed": True, "cancelled": False})
            buf = list(j.get("buf") or [])
            return self._json_ok({
                "text": "".join(buf[frm:]),
                "n": len(buf),
                "chunks": j.get("chunks", 0),
                "dbg": j.get("dbg", ""),
                "closed": not j.get("active"),
                "cancelled": bool(j.get("cancelled")),
            })

        self._json_err("not found", 404)

    def _api_post(self, path, body):
        # 新建
        m = re.match(r"^/api/(scripts|characters|worldbook|mods|sessions)$", path)
        if m:
            kind = m.group(1)
            if SHARE and kind != "mods":
                return self._json_err("分享版仅开放 MOD", 403)
            prefix = {"scripts": "sc", "characters": "ch", "worldbook": "wb", "mods": "md", "sessions": "se"}[kind]
            return self._crud_create(kind, body, prefix)

        if path == "/api/settings":
            cfg = get_config()
            for k, v in (body or {}).items():
                if k == "api_key" and v == "***":
                    continue  # 前端没改
                cfg[k] = v
            save_json(CONFIG, cfg)
            out = dict(cfg)
            out["api_key"] = "***" if out.get("api_key") else ""
            return self._json_ok(out)

        if path == "/api/test":
            cfg = get_config()
            try:
                reply = call_ai([{"role": "user", "content": "回复两个字：在的"}], cfg)
                return self._json_ok({"reply": reply.strip()[:80]})
            except Exception as e:
                return self._json_err("连接失败：%s" % e)

        # ── 修正人设：标记会话，下一轮 prompt 注入校准指令 ──
        if path == "/api/fix-persona":
            sid = (body or {}).get("session_id", "")
            if not sid:
                return self._json_err("缺 session_id")
            p = os.path.join(DIRS["sessions"], sid + ".json")
            sess = load_json(p)
            if not sess:
                return self._json_err("会话不存在")
            sess["persona_fix"] = True
            save_json(p, sess)
            return self._json_ok({"session_id": sid, "status": "armed",
                                  "msg": "下一轮将重新校准人设"})

        # ── 记忆修复：清空短期记忆（STM），保留长期记忆（LTM）与配置 ──
        if path == "/api/fix-memory":
            sid = (body or {}).get("session_id", "")
            if not sid:
                return self._json_err("缺 session_id")
            p = os.path.join(DIRS["sessions"], sid + ".json")
            sess = load_json(p)
            if not sess:
                return self._json_err("会话不存在")
            mem = sess.get("memory") or {}
            mem["stm"] = []
            sess["memory"] = mem
            save_json(p, sess)
            return self._json_ok({"session_id": sid, "status": "reset",
                                  "msg": "短期记忆已清空"})

        # ── 角色分类 ──
        if path == "/api/categories":
            cats = list_categories()
            for c in cats:
                if "enabled" in (body or {}):
                    pass
            # 支持两种写法：{enabled: {name: bool}} 或 {name: bool, action:"toggle"}
            if isinstance(body, dict) and "enabled" in body and isinstance(body["enabled"], dict):
                cfg = load_categories()
                cfg["enabled"].update(body["enabled"])
                save_categories(cfg)
                return self._json_ok(list_categories())
            if isinstance(body, dict) and body.get("name") is not None and "value" in body:
                cfg = load_categories()
                cfg["enabled"][body["name"]] = bool(body["value"])
                save_categories(cfg)
                return self._json_ok(list_categories())
            return self._json_ok(cats)

        # ── 导入角色 ──
        if path == "/api/import/characters":
            items = (body or {}).get("characters") or []
            if not isinstance(items, list):
                return self._json_err("格式错误：需要 {characters: [...]}")
            created, updated, failed = [], [], []
            for raw in items:
                try:
                    if not isinstance(raw, dict) or not raw.get("name"):
                        failed.append({"reason": "缺少 name"})
                        continue
                    cat = raw.pop("category", "") or raw.pop("_category", "") or ""
                    nm = raw["name"].strip()

                    # 同名同分类 → 覆盖更新
                    exist = None
                    for it in self._scan_dir(DIRS["characters"]):
                        if it.get("name") == nm and (it.get("_category") or "") == cat:
                            exist = it
                            break
                    if exist:
                        oid = exist["id"]
                        raw["id"] = oid
                        raw["updated_at"] = now_ts()
                        save_json(self._path_for("characters", oid, cat), raw)
                        updated.append(nm)
                    else:
                        oid = raw.get("id") or new_id("ch")
                        raw["id"] = oid
                        raw.setdefault("created_at", now_ts())
                        raw["updated_at"] = now_ts()
                        save_json(self._path_for("characters", oid, cat), raw)
                        created.append(nm)
                except Exception as e:
                    failed.append({"item": str(raw)[:40], "reason": str(e)[:60]})
            return self._json_ok({
                "created": created, "updated": updated, "failed": failed,
                "categories": list_categories(),
            })

        # ── 导入剧本/世界书/MOD（通用）──
        if path in ("/api/import/scripts", "/api/import/worldbook", "/api/import/mods"):
            kind = path.rsplit("/", 1)[-1]
            items = (body or {}).get("items") or []
            if not isinstance(items, list):
                return self._json_err("格式错误：需要 {items: [...]}")
            created, updated, failed = [], [], []
            for raw in items:
                try:
                    if not isinstance(raw, dict) or not (raw.get("name") or raw.get("title")):
                        failed.append({"reason": "缺少 name/title"})
                        continue
                    oid = raw.get("id") or new_id(kind[:2])
                    raw["id"] = oid
                    raw.setdefault("created_at", now_ts())
                    raw["updated_at"] = now_ts()
                    save_json(os.path.join(DIRS[kind], oid + ".json"), raw)
                    created.append(raw.get("name") or raw.get("title"))
                except Exception as e:
                    failed.append({"item": str(raw)[:40], "reason": str(e)[:60]})
            return self._json_ok({"created": created, "updated": updated, "failed": failed})

        # ── 移动角色到分类 ──
        if path == "/api/characters/move":
            oid = (body or {}).get("id")
            cat = (body or {}).get("category", "")
            if not oid:
                return self._json_err("缺少 id")
            p = self._find_file("characters", oid)
            if not p:
                return self._json_err("角色不存在", 404)
            obj = load_json(p) or {}
            try:
                os.remove(p)
            except Exception:
                pass
            save_json(self._path_for("characters", oid, cat or ""), obj)
            return self._json_ok({"id": oid, "category": cat})

        if path == "/api/chat":
            rid = str((body or {}).get("request_id") or "")
            job = job_open(rid) if rid else None
            sid = body.get("session_id")
            script_id = body.get("script_id")
            user_input = (body.get("input") or "").strip()
            active_npcs = body.get("active_npcs")

            script = load_json(os.path.join(DIRS["scripts"], script_id + ".json"))
            if not script:
                job_close(rid)
                return self._json_err("剧本不存在", 404)

            # 载入或新建会话
            sess = None
            if sid:
                sess = load_json(os.path.join(DIRS["sessions"], sid + ".json"))
            if not sess:
                sess = {
                    "id": new_id("se"),
                    "script_id": script_id,
                    "script_name": script.get("name", ""),
                    "title": (user_input[:16] or "新对话"),
                    "player": body.get("player") or {},
                    "role_choice": body.get("role_choice", ""),
                    "active_npcs": active_npcs or (script.get("character_pool") or [])[:2],
                    "opening_index": body.get("opening_index", 0),
                    "word_target": body.get("word_target") or 0,
                    "enable_options": body.get("enable_options", True),
                    "memory": {"config": {"stm_limit": 6, "ltm_min": 300, "ltm_max": 500}, "stm": [], "ltm": []},
                    "history": [],
                    "created_at": now_ts(),
                    "updated_at": now_ts(),
                }
            elif active_npcs is not None:
                sess["active_npcs"] = active_npcs

            if body.get("word_target") is not None:
                sess["word_target"] = body.get("word_target")
            if "enable_options" in body:
                sess["enable_options"] = bool(body.get("enable_options"))
            if not sess.get("memory"):
                sess["memory"] = {"config": {"stm_limit": 6, "ltm_min": 300, "ltm_max": 500}, "stm": [], "ltm": []}

            # 玩家在输入里改了身体数值 → 先写回会话，再组装
            try:
                _apply_player_updates(sess, user_input)
            except Exception:
                pass

            # 组装
            msgs, report = _assemble_for(script, sess, user_input)

            cfg = get_config()
            # 联网检索：命中搜索意图时抓一份资料，拼进 system 作参考（不改变角色口吻）
            _search_ctx = maybe_search_context(user_input, cfg)
            if _search_ctx and msgs and msgs[0].get("role") == "system":
                msgs[0]["content"] += (
                    "\n\n【联网检索资料 · 仅作事实参考，不要照抄，保持角色口吻】\n" + _search_ctx
                )
            try:
                reply = call_ai(msgs, cfg, job)
            except ChatCancelled:
                job_close(rid)
                return self._json_err("已停止", 409)
            except Exception as e:
                job_close(rid)
                return self._json_err("AI 调用失败：%s" % e)

            # ── 先把选项块拆出来（续写会冲掉它，最后再拼回）──
            body_only, opt_block = _split_options(reply)
            reply = body_only

            # ── 字数保障：不足则续写（最多 2 次）──
            target = 0
            try:
                target = int(sess.get("word_target") or 0)
            except Exception:
                target = 0

            retries = 0
            if target > 0:
                # 达标线：小目标要求严，大目标（万字）必须写满 95%
                if target <= 1500:
                    thresh = 0.90
                elif target <= 3000:
                    thresh = 0.90
                elif target <= 6000:
                    thresh = 0.92
                else:
                    thresh = 0.95
                need_min = target * thresh

                # 续写次数按目标动态给：万字需要更多次
                max_cont = 2 if target <= 3000 else (3 if target <= 6000 else 5)

                for _ in range(max_cont):
                    cur = _body_chars(reply)
                    if cur >= need_min:
                        break
                    need = max(0, target - cur)
                    # 每次要求「至少写 X 字」，而不是「还差 X 字」——后者 AI 会偷懒只写一小段
                    chunk = max(800, min(need, 4000))
                    try:
                        cont_msgs = list(msgs) + [
                            {"role": "assistant", "content": reply},
                            {"role": "user", "content": (
                                "继续写，从最后一句之后接着往下，只写正文。\n"
                                "【本次要求】至少写 %d 字，少于 %d 字视为未完成，必须写够。\n"
                                "【排版】必须分段：每段 2–4 句（约 60–140 字），段与段之间空一行。严禁一整段写到底。\n"
                                "【严禁】不要写「选项：」、不要列编号、不要收尾、不要总结、不要跳到新场景。\n"
                                "【保持场面】这是床戏，必须继续写性爱场面（抽插、体位、器官、淫叫、体液），"
                                "严禁跳去写日常对话、工作、数据、任务、回忆等剧情。\n"
                                "当前 %d 字，总目标 %d 字。把这场性事继续往下推，写足字数。"
                                % (chunk, chunk, cur, target)
                            )},
                        ]
                        more = call_ai(cont_msgs, cfg, job)
                        if not more or len(more.strip()) < 20:
                            break
                        reply = join_continuation(reply, more)
                        retries += 1
                    except Exception:
                        break

            # 续写后清理：删掉正文里所有残留的选项块（续写时 AI 可能违规又生成，导致两组）
            reply = re.split(r"^\s*选项[：:]\s*$", reply, flags=re.M)[0].rstrip()

            # opt_block 也可能含多组选项（AI 第一次生成时照抄模板 + 又具体化），只保留最后一组
            if opt_block:
                _segs = re.split(r"^\s*选项[：:]\s*$", opt_block, flags=re.M)
                opt_block = "选项：\n" + _segs[-1].strip()

            # 判断本轮是否该有 NTR 选项（extras 黄毛/苦主 + 输入/历史迹象词）
            st0 = sess.get("state") or {}
            has_ntr = any(
                (v.get("role") in ("黄毛", "苦主"))
                for v in (st0.get("extras") or {}).values()
            )
            if not has_ntr and assembler:
                _hay = (user_input or "") + "\n" + "\n".join(
                    h.get("content", "") for h in (sess.get("history") or [])[-4:]
                )
                has_ntr = any(w in _hay for w in assembler.NTR_HINT_WORDS)

            # AI 给了选项但漏了 NTR → 强制重写为含 NTR 的选项
            if opt_block and has_ntr and "NTR" not in opt_block:
                opt_block = ""
            # 选项完整性校验：数量不够或含空话 → 视为无效，走兜底重生成
            if opt_block and not _validate_options(opt_block, has_ntr)[0]:
                opt_block = ""
            # 剧本自定义选项格式校验：AI 惯性写「选项1.剧情推进」→ 视为无效，重写
            _slow_model = any(k in str((cfg or {}).get("api_model", "")) for k in ("pro", "reasoner"))
            _opt_tpl = (script or {}).get("option_template") or []
            if opt_block and _opt_tpl and not _validate_custom_options(opt_block, _opt_tpl)[0]:
                opt_block = ""

            # 拼回第 1 次生成时抽出的选项块
            if opt_block:
                reply = reply.rstrip() + "\n\n" + opt_block
            elif _opt_tpl:
                # 剧本自定义选项：用剧本模板重写（AI 惯性写「选项1」→ 强制 A-G）
                _opt_lines_ok = ""
                _tpl_text = "\n".join(_opt_tpl)
                for _retry in range(0 if _slow_model else 2):
                    try:
                        _opt_msgs = list(msgs) + [
                            {"role": "assistant", "content": reply},
                            {"role": "user", "content": (
                                "上面这段正文漏了选项区。请基于这段正文的剧情，生成选项。\n"
                                "必须严格按下面的格式输出，一个字母一条，"
                                "严禁用「选项1」「选项2」这类编号：\n"
                                "选项：\n" + _tpl_text + "\n"
                                "只输出选项区，不要写任何正文。"
                            )},
                        ]
                        _opt_reply = call_ai(_opt_msgs, cfg, job)
                        if _opt_reply and _validate_custom_options(_opt_reply.strip(), _opt_tpl)[0]:
                            _opt_lines_ok = _opt_reply.strip()
                            break
                    except Exception:
                        pass
                if _opt_lines_ok:
                    reply = reply.rstrip() + "\n\n" + _opt_lines_ok
                else:
                    # 模板兜底：用剧本的字母和标签，括号里写「（具体动作）」
                    fb = []
                    for line in _opt_tpl:
                        m = re.match(r"^\s*([A-G])\.\s*【([^】]+)】", line)
                        if m:
                            _acts = {"激进": "直接动手，把场面推到不可回头", "稳妥": "先稳住局面，看清再动",
                                     "智谋": "用话试探，套出实情", "逃避": "抽身退开，避开这一场",
                                     "欲望": "顺着自己的欲念往前一步", "色欲": "把注意力放到身体上",
                                     "背德": "越过规矩，做不该做的"}
                            fb.append("%s. 【%s】%s。" % (m.group(1), m.group(2),
                                                        _acts.get(m.group(2), "按这个方向做一个具体动作")))
                    reply = reply.rstrip() + "\n\n选项：\n" + "\n".join(fb)
            else:
                # 兜底：调用 AI 基于正文生成具体选项（最多重试 2 次，校验通过才用）
                _opt_lines_ok = ""
                _ntr_line = ("选项5.NTR恶堕剧情：（具体背德动作）\n"
                             "选项6.时间跳跃：（具体时间点）\n"
                             "选项7.自定义行动：\n" if has_ntr else
                             "选项5.时间跳跃：（具体时间点）\n"
                             "选项6.自定义行动：\n")
                for _retry in range(0 if _slow_model else 2):
                    try:
                        _opt_msgs = list(msgs) + [
                            {"role": "assistant", "content": reply},
                            {"role": "user", "content": (
                                "上面这段正文漏了选项区。请基于这段正文的剧情，生成选项，"
                                "每条括号里写具体的动作路线（谁、对谁、做什么、怎么做），"
                                "严禁写「继续往下」「推动剧情」「做点日常的事」这类空话。\n"
                                "格式严格如下：\n"
                                "选项：\n"
                                "选项1.剧情推进：（具体动作）\n"
                                "选项2.日常互动：（具体动作）\n"
                                "选项3.性爱剧情：（具体动作）\n"
                                "选项4.极致欢愉：（具体动作）\n"
                                + _ntr_line +
                                "只输出选项区，不要写任何正文。"
                            )},
                        ]
                        _opt_reply = call_ai(_opt_msgs, cfg, job)
                        if _opt_reply and _validate_options(_opt_reply.strip(), has_ntr)[0]:
                            _opt_lines_ok = _opt_reply.strip()
                            break
                    except Exception:
                        pass
                if _opt_lines_ok:
                    reply = reply.rstrip() + "\n\n" + _opt_lines_ok
                else:
                    # 兜底失败，用模板（保证数量完整，但文案笼统）
                    fb = ["选项1.剧情推进：（沿着刚才的情境继续往下）",
                          "选项2.日常互动：（和在场角色做点日常的事）",
                          "选项3.性爱剧情：（把关系往身体上推一步）",
                          "选项4.极致欢愉：（更过火一点）"]
                    if has_ntr:
                        fb.append("选项5.NTR恶堕剧情：（往背德方向走）")
                        fb.append("选项6.时间跳跃：（跳过一段时间）")
                        fb.append("选项7.自定义行动：")
                    else:
                        fb.append("选项5.时间跳跃：（跳过一段时间）")
                        fb.append("选项6.自定义行动：")
                    opt_block = "选项：\n" + "\n".join(fb)
                    reply = reply.rstrip() + "\n\n" + opt_block

            # 最终去重：确保 reply 里只有一组选项（AI 可能照抄模板 + 又具体化生成两组）
            _opt_cnt = len(re.findall(r"^\s*选项[：:]\s*$", reply, flags=re.M))
            if _opt_cnt > 1:
                _segs = re.split(r"^\s*选项[：:]\s*$", reply, flags=re.M)
                reply = _segs[0].rstrip() + "\n\n选项：\n" + _segs[-1].strip()
            final_chars = _body_chars(reply)

            # ══════ 运算层：先算本轮档位（供状态结算用）══════
            if not sess.get("state"):
                sess["state"] = _init_state(sess)
            cur_state = sess["state"]

            cur_tier = None
            cur_info = None
            cur_cards = {}
            _is_bed_now = False
            _mod_data_now = {}
            if assembler:
                try:
                    _mods_now = _load_all("mods")
                    _used_now = assembler.filter_mods(_mods_now, script, sess)
                    _vocab_now = assembler.parse_mod_vocab(_used_now)
                    _is_bed_now = assembler.detect_scene(user_input, "", _vocab_now)
                    _mod_data_now = assembler.get_judge_mod_data(_used_now)
                except Exception:
                    _is_bed_now = False
            if _judge_enabled_now(script, sess) and _is_bed_now:
                try:
                    _pairs = []
                    for _cid in (sess.get("active_npcs") or []):
                        _fp = _find_char_file(_cid)
                        if not _fp:
                            continue
                        _c = load_json(_fp)
                        if not _c:
                            continue
                        _cs = ((cur_state.get("npcs") or {}).get(str(_cid))
                               or (cur_state.get("npcs") or {}).get(_cid) or {})
                        _pairs.append((_c, _cs))
                        cur_cards[_c.get("name", "")] = _c
                    _jt, cur_info = judge.build_judge_inject(_pairs, cur_state, user_input, _mod_data_now)
                    if cur_info:
                        cur_tier = cur_info.get("tier")
                except Exception:
                    cur_tier = None

            # 元命令：玩家在输入里直接命令「心体都到上限」
            meta_max = None
            try:
                meta_max = judge.detect_meta_max(user_input)
            except Exception:
                meta_max = None

            # ══════ 验证层：档位校验 + 用词/密度检测 ══════
            verify_report = {}
            if cur_tier and cur_tier != "拒绝":
                # 收集所有问题：跳档 / 代称 / 密度 / 说字 / 句长
                _violations = judge.check_tier_violation(cur_tier, reply)
                _euphemism = judge.check_vocab(reply)
                _density, _ecnt, _elen = judge.measure_density(reply)
                _said_cnt, _said_per_k = judge.measure_said(reply)
                _sent_len = judge.measure_sent_len(reply)

                _issues = []
                if _violations:
                    _issues.append("跳档词：%s" % "、".join(_violations))
                if _euphemism:
                    _issues.append("禁用代称：%s（写器官本名）" % "、".join(_euphemism))
                # 密度：床戏高档位（撞实/破宫）密度过低 → 触发重写补露骨
                if cur_tier in ("撞实", "破宫·初", "破宫·深", "破宫·极") and _density < 16:
                    _issues.append("露骨密度 %.1f/千字不足 16（床戏档必须够露骨，补器官词/淫叫/体液描写）" % _density)

                # 大篇幅正文（>6000 字）：所有校验只记录、不重写
                # 理由：万字篇幅必然有瑕疵（跳档词/代称/短句），整体重写要重复整个 prompt，
                #       成本翻倍且字数剧烈波动；只记录不影响正文
                _big_body = _body_chars(reply) > 6000
                if _big_body:
                    verify_report["recorded_only"] = {
                        "violations": _violations or [],
                        "euphemism": _euphemism or [],
                        "said_per_k": _said_per_k,
                        "sent_len": _sent_len,
                    }
                    _issues = []
                else:
                    if _said_per_k > 3:
                        _issues.append("「说」字 %.1f/千字超 3" % _said_per_k)
                    if _sent_len < 40:
                        _issues.append("句长 %.1f 字太短" % _sent_len)

                if _issues:
                    # 一次重写，把问题全部列给 AI
                    try:
                        _body_only, _opt_keep = _split_options(reply)
                        _fix_msgs = list(msgs) + [
                            {"role": "assistant", "content": _body_only},
                            {"role": "user", "content": (
                                "【内容修正】本轮判定「%s」，正文问题：%s。\n"
                                "请重写，严格按档位 + 露骨零件写：\n"
                                "1. 去掉跳档词，代称改成器官本名\n"
                                "2. 露骨密度提到 31–50/千字（多写器官词、动作词、体液）\n"
                                "3. 句长 50–100 字，少用短句\n"
                                "4. 删掉「她说」「他说」\n"
                                "正文连贯，不要列选项。"
                                % (cur_tier, "；".join(_issues))
                            )},
                        ]
                        _fixed = call_ai(_fix_msgs, cfg, job)
                        if _fixed and len(_fixed.strip()) >= 20:
                            reply = _fixed.strip()
                            if _opt_keep:
                                reply = reply.rstrip() + "\n\n" + _opt_keep
                            verify_report["fixed"] = _issues
                            retries += 1
                            # ★ 重写会缩短正文 → 补足字数（否则万字目标会缩水成三千字）
                            if target > 0:
                                try:
                                    if target <= 1500:
                                        _thr = 0.90
                                    elif target <= 3000:
                                        _thr = 0.90
                                    elif target <= 6000:
                                        _thr = 0.92
                                    else:
                                        _thr = 0.95
                                    _need_now = target * _thr
                                    _max_c2 = 2 if target <= 3000 else (3 if target <= 6000 else 5)
                                    _cur_body, _cur_opt = _split_options(reply)
                                    for _ in range(_max_c2):
                                        _cur_now = _body_chars(_cur_body)
                                        if _cur_now >= _need_now:
                                            break
                                        _chunk2 = max(800, min(max(0, target - _cur_now), 4000))
                                        _cont2 = list(msgs) + [
                                            {"role": "assistant", "content": _cur_body},
                                            {"role": "user", "content": (
                                                "继续写，从最后一句之后接着往下，只写正文，不要写选项。\n"
                                                "【本次要求】至少写 %d 字。\n"
                                                "【排版】每段 2–4 句（约 60–140 字），段与段之间空一行，严禁一整段写到底。\n"
                                                "当前 %d 字，总目标 %d 字。"
                                                % (_chunk2, _cur_now, target)
                                            )},
                                        ]
                                        _more2 = call_ai(_cont2, cfg, job)
                                        if not _more2 or len(_more2.strip()) < 20:
                                            break
                                        _cur_body = join_continuation(_cur_body, _more2)
                                        retries += 1
                                    reply = _cur_body.rstrip()
                                    if _cur_opt:
                                        reply = reply + "\n\n" + _cur_opt
                                except Exception:
                                    pass
                            # 重写后重新统计（让报告反映最终正文）
                            _density, _ecnt, _elen = judge.measure_density(reply)
                            _said_cnt, _said_per_k = judge.measure_said(reply)
                            _sent_len = judge.measure_sent_len(reply)
                    except Exception:
                        pass
                else:
                    verify_report["ok"] = True

                verify_report["density"] = _density
                verify_report["said_per_k"] = _said_per_k
                verify_report["sent_len"] = _sent_len
                if _density < 16 and cur_tier in ("撞实", "破宫·初", "破宫·深", "破宫·极"):
                    verify_report["density_low"] = True

            final_chars = _body_chars(reply)

            # ══════ 状态更新（3 次尝试，全失败则阻断）══════
            st_err = None
            for attempt in range(3):
                try:
                    upd_msgs = _build_state_msgs(sess, reply, attempt)
                    cfg2 = dict(cfg)
                    cfg2["temperature"] = 0.85 if attempt == 0 else 0.1
                    raw = call_ai(upd_msgs, cfg2, job).strip()
                    delta = _extract_json(raw)
                    if delta is None:
                        raise ValueError("AI 未返回合法 JSON")
                    # 用引擎档位结算（5.1 定值 + 修正 B/C/D + 破宫 corruption）
                    _breaker = judge.extract_breaker(user_input, (sess.get("player") or {}).get("name", ""))
                    _breaker_kind = None
                    try:
                        _rel0 = ""
                        for _c in (sess["state"].get("npcs") or {}).values():
                            _rel0 = _c.get("relation") or ""
                            break
                        _breaker, _breaker_kind = judge.classify_breaker(
                            user_input, (sess.get("player") or {}).get("name", ""), _rel0)
                        # 只有「其他男性尺寸」或「明确的他人性动作」才把破宫记到别人头上；
                        # 只是提到「其他男人盯上」不算。
                        _other_L = judge.extract_other_length(user_input)
                        _other_act = re.search(
                            r"(让他|让别人|其他人|别的男人|黄毛|大野|贞二|村人|村民)[^。！？]{0,12}"
                            r"(操|插|上|干|睡|侵犯|轮|射)", user_input or "")
                        if not _other_L and not _other_act:
                            _breaker = (sess.get("player") or {}).get("name", "") or _breaker
                            _breaker_kind = "lover"
                    except Exception:
                        pass
                    _merge_state(sess["state"], delta, tier=cur_tier, cards=cur_cards,
                                 L=(cur_info.get("L") if cur_info else None), breaker=_breaker,
                                 breaker_kind=_breaker_kind)
                    # 存本轮档位（前端面板「当前档位」折叠 + 聊天区徽章显示用）
                    if cur_tier and cur_info:
                        for _cid in (sess.get("active_npcs") or []):
                            _npc = (sess["state"].get("npcs") or {}).get(_cid)
                            if _npc:
                                _npc["last_tier"] = cur_tier
                                _npc["last_tag"] = cur_info.get("tag", "")
                                _npc["last_position"] = cur_info.get("position", "")
                    # 元命令：直接把双轴设到上限
                    if meta_max:
                        try:
                            _apply_meta_max(sess["state"], meta_max)
                        except Exception:
                            pass
                    # ── STM：优先用 AI 返回的，没有就本地兜底 ──
                    try:
                        mem = sess.setdefault("memory", {
                            "config": {"stm_limit": 6, "ltm_min": 300, "ltm_max": 500},
                            "stm": [], "ltm": [],
                        })
                        mem.setdefault("stm", [])
                        round_no = len([h for h in (sess.get("history") or [])
                                        if h.get("role") == "assistant"]) + 1
                        ai_stm = delta.get("stm") if isinstance(delta, dict) else None
                        if isinstance(ai_stm, dict) and (ai_stm.get("event") or "").strip():
                            scene = (ai_stm.get("scene") or "").strip()
                            event = (ai_stm.get("event") or "").strip()[:200]
                        else:
                            scene = ((sess.get("state") or {}).get("player") or {}).get("location", "")
                            body_txt = _strip_options_for_stm(reply)
                            event = body_txt[:100].replace("\n", "")
                        mem["stm"].append({
                            "round": round_no,
                            "scene": scene,
                            "event": event,
                            "ts": now_ts(),
                        })
                        # 超上限自动总结（留给前端点「立即总结」，这里只标记）
                    except Exception:
                        pass
                    st_err = None
                    break
                except Exception as e:
                    st_err = str(e)[:120]
                    continue

            if st_err:
                return self._json_err(
                    "状态更新失败（已重试 3 次）：%s\n这是最后一轮出错，正文已生成但未保存。请点重试。" % st_err
                )

            # 用户在续写/补选项阶段按了「停止」→ 本轮作废，不写进会话
            if job_cancelled(job):
                job_close(rid)
                return self._json_err("已停止", 409)

            # 一致性：超预算时先把最早几轮压成「前情提要」，再把本轮压成「状态卡」
            try:
                rollup_recap(sess, cfg)
            except Exception as e:
                print("[recap] 跳过：%s" % e, flush=True)
            try:
                extract_state_card(sess, user_input, reply, cfg)
            except Exception as e:
                print("[state_card] 跳过：%s" % e, flush=True)

            if user_input:
                sess["history"].append({"role": "user", "content": user_input, "ts": now_ts()})
            sess["history"].append({"role": "assistant", "content": reply, "ts": now_ts(),
                                    "tier": cur_tier,
                                    "tag": (cur_info.get("tag") if cur_info else None)})
            sess["updated_at"] = now_ts()
            save_json(os.path.join(DIRS["sessions"], sess["id"] + ".json"), sess)

            # 拒绝提示：破宫后阈值上移，尺寸不够被拒时，把原因带出去给前端面板显示
            reject_info = None
            if cur_tier == "拒绝" and cur_info:
                reject_info = {
                    "name": cur_info.get("name", ""),
                    "press_now": cur_info.get("press"),
                    "reject_line": cur_info.get("reject_line"),
                    "player_length": cur_info.get("L"),
                }

            job_close(rid)
            return self._json_ok({
                "reply": reply,
                "model": cfg.get("api_model") or cfg.get("ollama_model") or "",
                "session_id": sess["id"],
                "report": report,
                "prompt_chars": len(msgs[0]["content"]),
                "body_chars": final_chars,
                "word_target": target,
                "retries": retries,
                "verify": verify_report,
                "reject": reject_info,
                "tier": cur_tier,
                "tag": (cur_info.get("tag") if cur_info else None),
                "position": (cur_info.get("position") if cur_info else None),
            })

        # ── 停止当前生成（前端「停止」按钮）──
        if path == "/api/chat/stop":
            rid = str((body or {}).get("request_id") or "")
            j = job_get(rid)
            if not j:
                return self._json_ok({"stopped": False, "reason": "任务不存在或已结束"})
            j["cancelled"] = True
            return self._json_ok({"stopped": True})

        # ── 记忆：总结 STM → LTM ──
        if path == "/api/memory/summarize":
            sid = (body or {}).get("session_id")
            force = bool((body or {}).get("force"))
            if not sid:
                return self._json_err("缺少 session_id")
            sp = os.path.join(DIRS["sessions"], sid + ".json")
            sess = load_json(sp)
            if not sess:
                return self._json_err("会话不存在", 404)

            mem = sess.get("memory") or {}
            mem.setdefault("config", {"stm_limit": 6, "ltm_min": 300, "ltm_max": 500})
            mem.setdefault("stm", [])
            mem.setdefault("ltm", [])
            stm = mem["stm"]
            limit = int(mem["config"].get("stm_limit") or 6)

            if len(stm) < limit and not force:
                return self._json_ok({
                    "summarized": False,
                    "stm_count": len(stm),
                    "limit": limit,
                    "memory": mem,
                })

            if not stm:
                return self._json_ok({"summarized": False, "stm_count": 0, "limit": limit, "memory": mem})

            # 调 AI 总结
            cfg = get_config()
            stm_text = "\n".join(
                "#%s %s：%s" % (x.get("round", "?"), x.get("scene", ""), x.get("event", ""))
                for x in stm
            )
            lmin = int(mem["config"].get("ltm_min") or 300)
            lmax = int(mem["config"].get("ltm_max") or 500)
            prompt = (
                "把下面这段剧情摘要，压缩成一条长期记忆。\n"
                "要求：\n"
                "1. 只保留对后续剧情有影响的事实（谁做了什么、关系变化、承诺、秘密、地点变化）\n"
                "2. %d–%d 字，纯客观陈述，不评价、不抒情\n"
                "3. 第一行写「场景：xxx」，第二行开始写事件\n"
                "4. 不要写「以上」「总结」这类词\n\n"
                "剧情摘要：\n%s" % (lmin, lmax, stm_text)
            )
            try:
                summary = call_ai([{"role": "user", "content": prompt}], cfg).strip()
            except Exception as e:
                return self._json_err("总结失败：%s" % e)

            # 解析场景
            scene = ""
            body_txt = summary
            m2 = re.match(r"^场景[：:]\s*(.+)$", summary.split("\n")[0].strip())
            if m2:
                scene = m2.group(1).strip()
                body_txt = "\n".join(summary.split("\n")[1:]).strip()

            rng = "%s-%s" % (stm[0].get("round", "?"), stm[-1].get("round", "?"))
            mem["ltm"].append({
                "range": rng,
                "scene": scene,
                "event": body_txt,
                "chars": len(body_txt),
                "ts": now_ts(),
            })
            mem["stm"] = []

            sess["memory"] = mem
            sess["updated_at"] = now_ts()
            save_json(sp, sess)

            return self._json_ok({
                "summarized": True,
                "ltm_count": 1,
                "range": rng,
                "scene": scene,
                "chars": len(body_txt),
                "memory": mem,
            })

        # ── 记忆：手动加一条 STM（调试/补记用）──
        if path == "/api/memory/add_stm":
            sid = (body or {}).get("session_id")
            if not sid:
                return self._json_err("缺少 session_id")
            sp = os.path.join(DIRS["sessions"], sid + ".json")
            sess = load_json(sp)
            if not sess:
                return self._json_err("会话不存在", 404)
            mem = sess.setdefault("memory", {"config": {"stm_limit": 6}, "stm": [], "ltm": []})
            mem.setdefault("stm", []).append({
                "round": (body or {}).get("round") or (len(mem.get("stm", [])) + 1),
                "scene": (body or {}).get("scene", ""),
                "event": (body or {}).get("event", ""),
                "ts": now_ts(),
            })
            sess["memory"] = mem
            sess["updated_at"] = now_ts()
            save_json(sp, sess)
            return self._json_ok(mem)

        # ── prompt 预览（不调 AI）──
        if path == "/api/preview":
            script_id = body.get("script_id")
            sid = body.get("session_id")
            user_input = (body.get("input") or "").strip()
            active_npcs = body.get("active_npcs")

            script = load_json(os.path.join(DIRS["scripts"], script_id + ".json"))
            if not script:
                return self._json_err("剧本不存在", 404)

            sess = None
            if sid:
                sess = load_json(os.path.join(DIRS["sessions"], sid + ".json"))
            if not sess:
                sess = {
                    "script_id": script_id,
                    "player": body.get("player") or {},
                    "role_choice": body.get("role_choice", ""),
                    "active_npcs": active_npcs or (script.get("character_pool") or [])[:2],
                    "opening_index": body.get("opening_index", 0),
                    "word_target": body.get("word_target") or 0,
                    "enable_options": body.get("enable_options", True),
                    "history": [],
                }
                # ★ 补 state（判定引擎/双轴面板都读 state，preview 也要一致）
                try:
                    sess["state"] = _init_state(sess)
                except Exception:
                    pass
            elif active_npcs is not None:
                sess["active_npcs"] = active_npcs
            if body.get("word_target") is not None:
                sess["word_target"] = body.get("word_target")

            msgs, report = _assemble_for(script, sess, user_input)
            return self._json_ok({
                "system": msgs[0]["content"],
                "messages": msgs,
                "report": report,
                "total_chars": len(msgs[0]["content"]),
            })

        self._json_err("not found", 404)

    def _api_put(self, path, body):
        m = re.match(r"^/api/(scripts|characters|worldbook|mods|sessions)/([^/]+)$", path)
        if m:
            if SHARE and m.group(1) != "mods":
                return self._json_err("分享版仅开放 MOD", 403)
            return self._crud_update(m.group(1), m.group(2), body)
        self._json_err("not found", 404)

    def _api_delete(self, path):
        m = re.match(r"^/api/(scripts|characters|worldbook|mods|sessions)/([^/]+)$", path)
        if m:
            if SHARE and m.group(1) != "mods":
                return self._json_err("分享版仅开放 MOD", 403)
            return self._crud_delete(m.group(1), m.group(2))
        self._json_err("not found", 404)


# ══════════════════════════════ 启动 ══════════════════════════════
def find_port(start=8800, tries=20):
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return start


def main():
    if not SHARE:
        write_char_index()   # 启动时刷新「角色卡总览.md」
    port = int(os.environ.get("FY_PORT", "0")) or find_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 50)
    print("  FyRunner 已启动")
    print("  http://127.0.0.1:%d" % port)
    print("  按 Ctrl+C 停止")
    print("=" * 50)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
