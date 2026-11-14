# -*- coding: utf-8 -*-
"""
判定引擎（运算层）—— 对齐《通用相性引擎.md》全部标准。

数据源：
  · 2.1 七档体型        → PRESS_TABLE
  · 2.2 八段判定        → judge_press_L
  · 5.1 Δ体（档位定值） → DELTA_BODY
  · 5.1 Δ心（原型加权） → DELTA_HEART
  · 5.4 阈值上移        → 破宫后 press = 破宫肉棒尺寸 L（在 server.py _merge_state 结算）
  · 5.5 破宫状态记录    → corruption 结构（reject_line = 破宫肉棒尺寸 L）
  · 5.6 上限与解锁层级  → heart_ceiling / body_ceiling

**本文件是运行时的唯一规则源**：五库底稿只作改规则时的参考，不入包；这里把规则「编译」成可执行函数。
"""

import re

# ══════ 2.1 七档体型 ══════
PRESS_TABLE = [
    ("幼女", 150, None, 10),
    ("娇小少女", 155, None, 12),
    ("标准少女", 162, None, 14),
    ("高挑少女", 165, None, 16),
    ("高挑御姐", 170, None, 18),
    ("丰满熟女", 999, "G", 20),
    ("超规格", 999, None, 24),
]
CUP_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]

# 气质词典（引擎 2.1 分层判定第一层：气质定性）
# 旧版四档词表：保留给外部脚本/旧数据参考；判定已改用下面的短语表。
QIZHI_WORDS = {
    "御姐": ["御姐", "成熟", "冷艳", "孤傲", "高冷", "威严", "女王", "大姐头", "大姐姐",
             "姐姐", "性感", "妩媚", "端庄", "优雅", "强势", "高傲", "冷峻", "冷傲",
             "上司", "前辈", "女忍", "教师", "导师", "阿姨", "风情", "御"],
    "熟女": ["熟女", "人妻", "少妇", "未亡人", "美妇", "熟妇", "贵妇", "熟透", "丰腴",
             "风韵", "徐娘", "熟龄", "熟美人", "美母", "岳母", "王妃", "夫人", "人母",
             "继母", "寡母"],
    "少女": ["少女", "JK", "美少女", "歌姬", "元气", "活泼", "天真", "纯真", "可爱",
             "学妹", "后辈", "中二", "害羞", "稚嫩", "青春", "甜", "娇小", "女高中生",
             "学生", "女孩", "青梅", "甜妹", "辣妹", "妹妹"],
    "萝莉": ["萝莉", "幼女", "幼", "稚气", "天真无邪", "孩子气", "幼童", "合法萝莉",
             "贫乳萝莉", "妹系"],
}

# 语境化短语表：(短语, 档位, 权重)
# 权重：3 = 身份/关系强信号；1.5 = 气质形容词；0.5~1 = 弱信号。
# 匹配规则：长词优先（「成熟女性」先于「成熟」），同一短语只计一次（防止评论/引语重复加权）。
QIZHI_PHRASES = [
    # 熟女：身份/关系
    ("熟女系", "熟女", 3), ("熟女", "熟女", 3), ("成熟女性", "熟女", 3), ("成熟女人", "熟女", 3),
    ("熟妇", "熟女", 3), ("美妇", "熟女", 3), ("熟美人", "熟女", 3), ("人妻", "熟女", 3),
    ("少妇", "熟女", 3), ("未亡人", "熟女", 3), ("寡妇", "熟女", 3), ("寡母", "熟女", 3),
    ("继母", "熟女", 3), ("岳母", "熟女", 3), ("美母", "熟女", 3), ("王妃", "熟女", 3),
    ("人母", "熟女", 3), ("贤妻", "熟女", 2), ("夫人", "熟女", 2), ("贵妇", "熟女", 2),
    ("熟透", "熟女", 2), ("熟龄", "熟女", 2), ("丰腴", "熟女", 2), ("风韵", "熟女", 2),
    ("徐娘", "熟女", 2),
    # 御姐：身份
    ("大姐姐", "御姐", 3), ("大姐头", "御姐", 3), ("御姐", "御姐", 3), ("女上司", "御姐", 3),
    ("女教师", "御姐", 3), ("女忍", "御姐", 3), ("女王", "御姐", 3), ("女强人", "御姐", 3),
    # 御姐：气质形容词（弱）
    ("冷艳", "御姐", 1.5), ("高傲", "御姐", 1.5), ("强势", "御姐", 1.5), ("孤傲", "御姐", 1.5),
    ("高冷", "御姐", 1.5), ("威严", "御姐", 1.5), ("性感", "御姐", 1.5), ("妩媚", "御姐", 1.5),
    ("端庄", "御姐", 1.5), ("冷峻", "御姐", 1.5), ("冷傲", "御姐", 1.5), ("风情", "御姐", 1.5),
    ("成熟", "御姐", 0.5), ("优雅", "御姐", 0.5), ("姐姐", "御姐", 0.5), ("上司", "御姐", 1.5),
    ("教师", "御姐", 0.5), ("导师", "御姐", 0.5), ("前辈", "御姐", 0.5), ("阿姨", "御姐", 1),
    # 少女
    ("美少女", "少女", 3), ("少女", "少女", 3), ("女高中生", "少女", 3), ("JK", "少女", 3),
    ("学妹", "少女", 3), ("妹妹", "少女", 3), ("甜妹", "少女", 3), ("辣妹", "少女", 3),
    ("女孩", "少女", 2), ("后辈", "少女", 2), ("学生", "少女", 2), ("歌姬", "少女", 2),
    ("元气", "少女", 1), ("活泼", "少女", 1), ("天真", "少女", 1), ("纯真", "少女", 1),
    ("可爱", "少女", 1), ("娇小", "少女", 1), ("青春", "少女", 1), ("稚嫩", "少女", 1),
    ("害羞", "少女", 1), ("青梅", "少女", 1), ("甜", "少女", 0.5),
    # 萝莉
    ("合法萝莉", "萝莉", 3), ("贫乳萝莉", "萝莉", 3), ("萝莉", "萝莉", 3), ("幼女", "萝莉", 3),
    ("幼童", "萝莉", 3), ("妹系", "萝莉", 2), ("孩子气", "萝莉", 1.5), ("稚气", "萝莉", 1.5),
    ("天真无邪", "萝莉", 1.5), ("贫乳", "萝莉", 1),
]

# 中性短语：先吃掉，避免「成熟稳重」「优雅从容」被当成御姐信号
QIZHI_NEUTRAL = ["成熟稳重", "成熟冷静", "成熟内敛", "成熟知性", "温柔知性", "温柔包容",
                 "优雅从容", "冷静沉着", "知性优雅", "端庄大方", "温柔坚强"]

_QIZHI_INDEX = None


def _qizhi_index():
    global _QIZHI_INDEX
    if _QIZHI_INDEX is None:
        idx = {}
        for ph, cat, w in QIZHI_PHRASES:
            idx.setdefault(ph[0], []).append((ph, cat, w))
        for ph in QIZHI_NEUTRAL:
            idx.setdefault(ph[0], []).append((ph, None, 0))
        for k in idx:
            idx[k].sort(key=lambda x: -len(x[0]))
        _QIZHI_INDEX = idx
    return _QIZHI_INDEX


def _qizhi_scores(text, seen=None):
    """长词优先匹配；同一短语只计一次。返回四档分数。"""
    sc = {"萝莉": 0.0, "熟女": 0.0, "御姐": 0.0, "少女": 0.0}
    seen = seen if seen is not None else set()
    idx = _qizhi_index()
    i, n = 0, len(text or "")
    while i < n:
        for ph, cat, w in idx.get(text[i], ()):
            if text.startswith(ph, i):
                if cat and ph not in seen:
                    sc[cat] += w
                    seen.add(ph)
                i += len(ph)
                break
        else:
            i += 1
    return sc


def _cup_rank(cup):
    if not cup:
        return 0
    c = str(cup).strip().upper()[:1]
    return CUP_ORDER.index(c) if c in CUP_ORDER else 0


def extract_qizhi(card):
    """从角色卡提取气质。

    规则（2026-11-07 语境化重写）：
      ① 显式字段优先（qizhi / 气质 / temperament）；
      ② 正文（tagline + comment + features + profile.personality）按短语计分：
         长词优先、同词只计一次、身份词权重高、性格形容词权重低；
      ③ appearance.body / breasts 里的体型词按半票计入（判定器以前完全不读身体）；
      ④ 取最高分；同分按 萝莉 → 熟女 → 御姐 → 少女 的顺序。
    """
    card = card or {}
    for key in ("qizhi", "气质", "temperament"):
        q = card.get(key) or (card.get("profile") or {}).get(key)
        if q:
            return str(q).strip()

    ap = card.get("appearance")
    if isinstance(ap, dict):
        body = " ".join(str(x) for x in [ap.get("body"), ap.get("breasts")] if x)
    else:
        body = ""

    text = " ".join([
        str(card.get("tagline", "")),
        str(card.get("comment", "")),
        str((card.get("profile") or {}).get("personality", "")),
        " ".join(str(x) for x in (card.get("features") or [])),
    ])
    seen = set()
    scores = _qizhi_scores(text, seen)
    for k, v in _qizhi_scores(body, seen).items():
        scores[k] += v * 0.5

    order = ["萝莉", "熟女", "御姐", "少女"]
    best = order[0]
    for c in order[1:]:
        if scores[c] > scores[best]:
            best = c
    return best if scores[best] > 0 else ""


def body_to_press(height_cm, cup, qizhi=None):
    """按引擎 2.1 分层判定（气质定性 + 身高罩杯定量）。返回 (press, 体型名, 理由)。"""
    h = float(height_cm or 0)
    c = cup or ""
    q = (qizhi or "").strip()
    if h and h < 150:
        return 10, "幼女", "身高 <150"
    if h and h < 155:
        return 12, "娇小少女", "150 ≤ 身高 <155"
    if h >= 195:
        return 24, "超规格", "身高 ≥195"
    if q == "熟女" and h >= 170 and _cup_rank(c) >= _cup_rank("G"):
        return 20, "丰满熟女", "熟女气质 且 身高≥170 且 罩杯≥G"
    if q in ("御姐", "熟女"):
        return 18, "高挑御姐", "御姐/熟女气质"
    if q == "少女":
        if h >= 162:
            return 16, "高挑少女", "少女气质 且 身高≥162"
        return 14, "标准少女", "少女气质"
    if h < 162:
        return 14, "标准少女", "155 ≤ 身高 <162"
    if h >= 170 and _cup_rank(c) >= _cup_rank("G"):
        return 20, "丰满熟女", "身高≥170 且 罩杯≥G"
    if h >= 165:
        return 18, "高挑御姐", "身高≥165"
    return 16, "高挑少女", "身高 162-165"


# ══════ 2.2 三段判定 ══════
def judge_press_L(press, L):
    """diff = L − press（正数 = 男方更长），返回 (档位, 标签, 差距描述, diff)。
    三段：无法满足 / 可以满足 / 身体释放。"""
    p = float(press)
    l = float(L)
    diff = round(l - p, 1)
    if diff < 0:
        return "无法满足", "不满足", "差 %.1fcm" % abs(diff), diff
    if diff < 4:
        return "可以满足", "满足", "0 ~ +4cm", diff
    return "身体释放", "释放", "超 4cm 以上", diff


# ══════ 5.1 Δ体（只看档位，与性格无关 · 定值）══════
DELTA_BODY = {
    "无法满足": -2,
    "可以满足": +9,
    "身体释放": +18,
}

# ══════ 5.1 Δ心（档位 × 原型，加权）══════
TIERS = ["无法满足", "可以满足", "身体释放"]

DELTA_HEART = {
    "dom":      [-2, +1, +1],
    "mother":   [-1, +2, +5],
    "imp":      [-2, +2, +4],
    "tsun":     [-2, +2, +3],
    "yandere":  [-1, +3, +5],
    "innocent": [-1, +2, +2],
    "saint":    [-1, -1,  0],
    "soldier":  [-1, +2, +3],
    "chuuni":   [-2, +2, +2],
    "cool":     [-1, +1, +2],
    "genki":    [-1, +2, +3],
    "endure":   [-1, +2, +4],
}
DEFAULT_ARCHETYPE = "dom"   # 卡里没标原型时用最保守的一组


# ══════ 5.7 恶堕进度（按对象累积）══════
# 爱人称谓（不累积恶堕）
LOVER_WORDS = ("老公", "丈夫", "夫君", "男友", "男朋友", "爱人", "未婚夫", "初恋", "前任", "旧爱")

# NTR 称谓（累积恶堕）
NTR_WORDS = (
    "另一个男人", "别的男人", "其他男人", "第二个男人", "隔壁老王",
    "男同事", "男经理", "男上司", "男客户",
    "继父", "义父", "小叔", "叔父", "伯父", "岳父", "父亲", "公公", "爸爸", "爹", "老爹",
    "黄毛", "苦主", "第三者", "奸夫", "情夫", "姘头", "小三", "野男人", "情人", "情郎",
    "男人", "男性", "黑人", "白人",
    "陌生人", "客人", "壮汉", "混混", "学长", "学弟", "哥哥", "弟弟",
    "外公", "爷爷", "班主任", "教练", "医生", "邻居", "司机", "保镖", "管家",
    "黑皮", "巨汉", "大汉", "流氓", "打手", "护卫", "士兵", "兽人", "半兽人",
)

# 恶堕阶段（0-5 级）
EVIL_STAGES = [
    (0, "纯洁", "震惊、抗拒、哭"),
    (2, "动摇", "嘴上说不要，身体先答应"),
    (3, "沉沦", "主动迎合，但嘴上还硬"),
    (4, "迷失", "开始自贬，嘴上说「不要」身体先答应"),
    (5, "认主", "叫主人、主动索求、对爱人「例行公事」"),
]


def evil_stage(progress):
    """根据恶堕进度返回 (阶段名, 写法方向)。"""
    try:
        p = int(progress or 0)
    except Exception:
        p = 0
    stage = EVIL_STAGES[0]
    for item in EVIL_STAGES:
        if p >= item[0]:
            stage = item
    return stage[1], stage[2]


def classify_breaker(text, player_name="", npc_relation=""):
    """判定本轮性事对象：lover（爱人+0）/ ntr（NTR+2）/ force（强制+1）。
    关系层优先：npc_relation 是夫妻/情侣 → lover；否则看称谓。"""
    t = text or ""
    # ① 关系层优先：夫妻/情侣 → 爱人
    if npc_relation and any(w in npc_relation for w in ("夫妻", "情侣", "恋人", "爱人")):
        return player_name or "玩家", "lover"
    # ② 关系层：陌生人/第三者 → ntr（先看有没有具体称谓）
    if npc_relation and any(w in npc_relation for w in ("陌生", "第三者", "外人")):
        for w in NTR_WORDS:
            if w in t:
                return w, "ntr"
        return "其他男性", "ntr"
    # ③ 强制/调教
    if any(w in t for w in ("强制", "强迫", "迷奸", "灌醉", "绑", "调教", "惩罚")):
        return "施害者", "force"
    # ④ 称谓层
    for w in LOVER_WORDS:
        if w in t:
            return w, "lover"
    for w in NTR_WORDS:
        if w in t:
            return w, "ntr"
    # ⑤ 上下文层：「他 + 动作」
    if re.search(r"(?:他|那人|那个男人)\s*(?:把|将|让|按|压|抱|插|操)", t):
        return "其他男性", "ntr"
    # ⑥ 默认：玩家本人 → lover
    return player_name or "玩家", "lover"


def evil_delta(kind):
    """恶堕进度增量：lover +0 / ntr +2 / force +1。"""
    return {"lover": 0, "ntr": 2, "force": 1}.get(kind, 0)


# ══════ 5.4 阈值上移（press 上移 = 破宫肉棒尺寸 L，在 server.py _merge_state 里结算）══════
# 注：press 上移不再用固定 +4/+8/+12，而是直接 = 破宫它的肉棒尺寸 L（见 5.4 用户规则）


def get_current_press(card, npc_state):
    """
    当前 press：原始 press + 破宫上移（5.4）。
    npc_state 里若已有 corruption.press_now，优先用它。
    """
    npc_state = npc_state or {}
    corr = npc_state.get("corruption") or {}
    if corr.get("press_now"):
        try:
            return float(corr["press_now"])
        except Exception:
            pass
    prof = (card or {}).get("profile") or {}
    press = prof.get("press")
    if press:
        try:
            return float(press)
        except Exception:
            pass
    # 旧卡兜底：从身高+三围推
    height = prof.get("height") or ""
    meas = prof.get("measurements") or ""
    hm = re.search(r"(\d+(?:\.\d+)?)\s*cm", str(height))
    if not hm:
        return None
    cup_m = re.search(r"[A-K]", str(meas).upper())
    p, _bn, _rs = body_to_press(float(hm.group(1)), cup_m.group(0) if cup_m else "", extract_qizhi(card))
    return float(p)


def check_reject(npc_state, L):
    """
    检查是否触犯拒绝线。返回 (是否拒绝, 拒绝线)。
    """
    corr = (npc_state or {}).get("corruption") or {}
    rl = corr.get("reject_line")
    if rl is None:
        return False, None
    try:
        rl = float(rl)
    except Exception:
        return False, None
    return (float(L) < rl), rl


# ══════ 5.6 上限与解锁层级 ══════
def heart_ceiling(npc_state):
    s = npc_state or {}
    if s.get("pregnant"):
        return 200.0
    if s.get("married"):
        return 150.0
    return 100.0


def body_ceiling(npc_state):
    s = npc_state or {}
    if s.get("pregnant") or s.get("womb_broken"):
        return 200.0
    return 100.0


# ══════ 5.1 取 Δ 值 ══════
def delta_body(tier):
    """Δ体：档位定值"""
    return float(DELTA_BODY.get(tier, 0))


def delta_heart(tier, archetype=None):
    """Δ心：档位 × 原型"""
    arch = str(archetype or DEFAULT_ARCHETYPE).lower()
    arr = DELTA_HEART.get(arch) or DELTA_HEART[DEFAULT_ARCHETYPE]
    if tier not in TIERS:
        return 0.0
    return float(arr[TIERS.index(tier)])


def get_archetype(card):
    """从角色卡读原型（12 种之一），没有就默认 dom"""
    c = card or {}
    prof = c.get("profile") or {}
    for src in (c.get("archetype"), prof.get("archetype"), c.get("personality_type")):
        if src:
            s = str(src).strip().lower()
            if s in DELTA_HEART:
                return s
    return DEFAULT_ARCHETYPE


# ══════ 尺寸提取 ══════
def extract_length(text):
    """从玩家输入提取「玩家自己的」尺寸 L（cm）。支持：20cm / 20厘米 / 尺寸20 / 长度20。
    排除「另一个/别的/对方/黑人」等他人角色的尺寸（否则会误当玩家尺寸）。"""
    if not text:
        return None
    # 先剔除「他人尺寸」片段：另一个黑人肉棒尺寸为30 / 另一个黑人30cm → 剔除，避免误当玩家尺寸
    OTHER = r"(?:另一个|别的|其他|对方|黑人|白人|男人|女人|那[个家伙]?|他|她)"
    OTHER_PAT1 = re.compile(OTHER + r"[^\s，,。；;]{0,10}\d+(?:\.\d+)?\s*(?:cm|厘米|公分)")
    OTHER_PAT2 = re.compile(OTHER + r"[^\s，,。；;]{0,10}(?:肉棒|鸡巴|尺寸|长度|屌|阴茎)[^\s，,。；;]{0,8}\d+(?:\.\d+)?\s*(?:cm|厘米|公分)?")
    cleaned = OTHER_PAT1.sub(" ", text)
    cleaned = OTHER_PAT2.sub(" ", cleaned)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:cm|厘米|公分)", cleaned, re.I)
    if m:
        return float(m.group(1))
    m = re.search(r"(?:尺寸|长度|长)\s*(\d+(?:\.\d+)?)", cleaned)
    if m:
        return float(m.group(1))
    return None


# 其他男性人物词（长词在前，覆盖伴侣/第三者/亲属/同事等全部 NTR 男性）
OTHER_MALE_WORDS = [
    "另一个男人", "别的男人", "其他男人", "第二个男人", "隔壁老王",
    "男朋友", "前男友", "未婚夫", "男同事", "男经理", "男上司", "男客户",
    "继父", "义父", "小叔", "叔父", "伯父", "岳父", "父亲", "公公", "爸爸", "爹",
    "黄毛", "苦主", "第三者", "奸夫", "情夫", "姘头", "小三", "野男人", "情人", "情郎",
    "男友", "老公", "丈夫", "前任", "旧爱", "初恋",
    "男人", "男性", "黑人", "白人", "对方", "另一个", "别的", "其他", "他", "她",
]


def extract_breaker(text, player_name=""):
    """识别本轮「破宫者/性事主体」：谁在做性事。默认玩家，输入里出现明确的男性称谓则记那个称谓。
    破宫者可以是任意角色——不限于玩家，也不限于 NTR 场景。
    只用明确的男性称谓，不用代词「他/她」（避免「操她」误判成破宫者是「她」）。"""
    if not text:
        return player_name or "玩家"
    BREAKER_WORDS = [
        "另一个男人", "别的男人", "其他男人", "第二个男人", "隔壁老王",
        "男朋友", "前男友", "未婚夫", "男同事", "男经理", "男上司", "男客户",
        "继父", "义父", "小叔", "叔父", "伯父", "岳父", "父亲", "公公", "爸爸", "爹",
        "黄毛", "苦主", "第三者", "奸夫", "情夫", "姘头", "小三", "野男人", "情人", "情郎",
        "男友", "老公", "丈夫", "前任", "旧爱", "初恋",
        "男人", "男性", "黑人", "白人",
    ]
    for w in BREAKER_WORDS:
        if w in text:
            return w
    return player_name or "玩家"


def extract_other_length(text):
    """提取「其他男性」的尺寸（NTR 场景用）。匹配「黑人30cm」「男友25cm」「继父30cm」等。
    这是「其他男性」的尺寸，不是玩家的——NTR 场景下女方被这个男性破宫。"""
    if not text:
        return None
    OTHER = "(?:" + "|".join(OTHER_MALE_WORDS) + ")"
    # 用 [^\d...] 排除数字，避免贪婪匹配吃掉数字；{0,10} 覆盖「黑人肉棒尺寸为」这类中间词
    m = re.search(OTHER + r"[^\d\s，,。；;]{0,10}(\d+(?:\.\d+)?)\s*(?:cm|厘米|公分)", text)
    if m:
        return float(m.group(1))
    m = re.search(OTHER + r"[^\d\s，,。；;]{0,10}(?:肉棒|鸡巴|尺寸|长度|屌|阴茎)[^\d\s，,。；;]{0,6}(\d+(?:\.\d+)?)", text)
    if m:
        return float(m.group(1))
    return None


# ══════ 元命令识别（精确区分心 / 体）══════
MAX_WORDS = ("到上限", "达到上限", "上限", "都满", "满值", "拉满", "顶满", "封顶",
             "顶值", "满值", "满了", "拉到头", "到顶", "满掉", "100", "一百")

HEART_KEYS = ("心相性", "心值", "心上限", "心轴", "好感", "♥心", "心相")
BODY_KEYS = ("体相性", "体值", "体上限", "体轴", "♠体", "相性值")


def detect_meta_max(user_input):
    """
    识别「心/体到上限」这类元命令。
    **精确区分**：「心相性拉满」只拉心，不动体；「心体都到上限」才两个都拉。
    返回 {"heart": bool, "body": bool} 或 None。
    """
    if not user_input:
        return None
    t = user_input
    if not any(w in t for w in MAX_WORDS):
        return None

    # 「心体」合并写法 → 两个都拉
    if "心体" in t:
        return {"heart": True, "body": True}

    hit_h = any(w in t for w in HEART_KEYS)
    hit_b = any(w in t for w in BODY_KEYS)

    # 都没命中关键词时，才用裸字兜底（且要求另一个不出现）
    if not hit_h and not hit_b:
        has_h = "心" in t
        has_b = "体" in t
        if has_h and has_b:
            hit_h = hit_b = True
        elif has_h:
            hit_h = True
        elif has_b:
            hit_b = True

    if hit_h or hit_b:
        return {"heart": hit_h, "body": hit_b}
    return None


# ══════ 验证层：档位校验 ══════
# 每个档位「不该出现的词」——正文里出现这些，说明 AI 跳档写错了
TIER_FORBIDDEN = {
    "未及·无": ["撞实", "撑满", "撞到底", "顶到最深处", "整根没入", "高潮", "满足", "痉挛"],
    "未及·空": ["撞实", "撑满", "撞到底", "整根没入", "高潮", "满足"],
    "未及·浅": ["撞实", "撑满", "撞到底", "整根没入", "高潮", "满足"],
    "差一点": ["撞实", "撑满", "整根没入", "高潮", "失守"],
    "撞实":   ["够不到", "空着", "没抵住", "轻蔑", "嫌恶", "浪费时间"],
    "破宫·初": ["够不到", "空着", "轻蔑", "嫌恶"],
    "破宫·深": ["够不到", "空着"],
    "破宫·极": ["够不到", "空着", "轻蔑", "嫌恶"],
}


def check_tier_violation(tier, reply):
    """返回正文里出现的「跳档词」列表；空列表 = 没跳档。"""
    bad = TIER_FORBIDDEN.get(tier, [])
    return [w for w in bad if w in (reply or "")]


# ══════ 验证层：用词规范（简版）══════
# 禁用代称（应写器官本名）
FORBIDDEN_EUPHEMISM = ["那里", "那处", "下面", "私处", "柱身"]


def check_vocab(reply):
    """检查禁用代称。返回命中列表。"""
    return [w for w in FORBIDDEN_EUPHEMISM if w in (reply or "")]


# ══════ 验证层：床戏密度（露骨词表，对齐词库 3.2 器官专名）══════
EROTIC_WORDS = [
    # 男器
    "鸡巴", "阴茎", "肉棒", "龟头", "马眼", "冠状沟", "蛋蛋", "肉柱",
    # 女器
    "骚逼", "小穴", "肉穴", "逼", "屄", "阴唇", "阴阜", "阴蒂", "骚豆",
    "阴户", "肉缝", "阴道", "甬道", "花心", "子宫", "宫口",
    # 后穴
    "骚屁眼", "屁眼", "菊穴", "肠壁", "直肠",
    # 乳
    "奶子", "奶头", "乳首", "乳头", "乳晕", "巨乳",
    # 臀
    "骚尻", "尻", "臀肉",
    # 体液
    "淫水", "骚水", "蜜汁", "爱液", "浪水", "白浆", "精液", "浓精", "白浊",
    "骚浆", "口水", "津液", "香汗",
    # 动作
    "插入", "抽送", "抽插", "顶撞", "撞", "操", "肏", "磨", "抠", "舔", "吸", "含", "吞",
    # 状态
    "高潮", "痉挛", "射", "中出", "内射", "破处", "开苞",
]


def measure_density(reply):
    """
    统计床戏密度（每千字露骨词数）。
    引擎标准：床戏段 31–50/千字。
    返回 (密度, 露骨词数, 总字数)。
    """
    if not reply:
        return 0, 0, 0
    n = len(reply)
    cnt = sum(reply.count(w) for w in EROTIC_WORDS)
    return round(cnt * 1000.0 / max(1, n), 1), cnt, n


def measure_said(reply):
    """统计「说」字（每千字）。引擎标准：≤3/千字。返回 (计数, 每千字)。"""
    if not reply:
        return 0, 0.0
    n = len(reply)
    cnt = reply.count("说")
    return cnt, round(cnt * 1000.0 / max(1, n), 1)


def measure_sent_len(reply):
    """统计平均句长（按。！？…分割）。引擎标准：50–100 字。"""
    if not reply:
        return 0
    sents = [s.strip() for s in re.split(r"[。！？…]", reply) if s.strip()]
    if not sents:
        return 0
    return round(sum(len(s) for s in sents) / len(sents), 1)


# ══════ 运算层入口 ══════
def build_judge_inject(active_pairs, state, user_input, mod_data=None):
    """
    床戏轮的运算层入口。
    active_pairs: [(card, npc_state)] —— 角色卡 + 该角色当前 state
    mod_data: 引擎 MOD 的 dict（含 reactions / mingqi），用于「按需注入」当前档位的写法。
    返回 (judge_text, info_dict) 或 (None, None)。

    尺寸 L 读取顺序：先 state.player.length，输入里「尺寸XX」临时覆盖。
    判定用「当前 press」（含破宫上移）+ 拒绝线（5.4）。
    公式全部程序算；AI 只拿到「本轮档位 + 当前档位的写法 + 当前名器钩子」。
    """
    mod_data = mod_data or {}
    reactions = mod_data.get("reactions") or {}
    mingqi = mod_data.get("mingqi") or {}
    kinks_db = mod_data.get("kinks") or {}
    positions_db = mod_data.get("positions") or {}
    luogu = mod_data.get("luogu") or {}

    L = (state.get("player") or {}).get("length")
    if L in (None, "", 0, "0"):
        L = None
    input_L = extract_length(user_input)
    if input_L is not None:
        L = input_L
    # NTR 场景：输入含「其他男性尺寸」（黑人30cm等）→ 用其他男性尺寸判定（女方被其他男性破宫）
    other_L = extract_other_length(user_input)
    is_ntr = False
    if other_L is not None:
        L = other_L
        is_ntr = True
    if L is None:
        return None, None
    try:
        L = float(L)
    except Exception:
        return None, None

    for card, cs in active_pairs:
        press = get_current_press(card, cs)
        if not press:
            continue

        name = (card or {}).get("name", "她")
        arch = get_archetype(card)

        # 拒绝线检查（5.4）
        rejected, rl = check_reject(cs, L)
        if rejected:
            judge_text = (
                "【本轮判定（程序算定，必须遵守）】\n"
                "%s：已破宫（press 上移后 = %s，拒绝线 = %s），玩家尺寸 %scm 低于拒绝线 → **拒绝**。\n"
                "她不会接受，请写她如何拒绝（冷淡、推开、起身离开、或明确说不）。"
                % (name, press, rl, L)
            )
            info = {"name": name, "press": press, "L": L, "diff": round(L - press, 1),
                    "tier": "拒绝", "tag": "拒绝", "gap": "低于拒绝线 %s" % rl,
                    "archetype": arch, "reject_line": rl}
            return judge_text, info

        tier, tag, gap, diff = judge_press_L(press, L)
        db = delta_body(tier)
        dh = delta_heart(tier, arch)

        # 按需注入：当前档位的写法（不是全表）—— 位置 + 生理 + 反应 三列都注入
        reaction = reactions.get(tier) or {}
        if isinstance(reaction, dict):
            reaction_text = reaction.get("text", "")
            reaction_pos = reaction.get("position", "")
            reaction_phys = reaction.get("physio", "")
        else:
            reaction_text = reaction_pos = reaction_phys = ""

        # 按需注入：当前角色的名器钩子
        bd = (card or {}).get("body_data") or {}
        pussy = bd.get("pussy") or {}
        pussy_name = pussy.get("name", "") if isinstance(pussy, dict) else ""
        mq = mingqi.get(pussy_name) or {}
        mq_hook = mq.get("钩子", "") if isinstance(mq, dict) else ""

        _subject = "其他男性的尺寸" if is_ntr else "玩家尺寸"
        judge_text = (
            "【本轮判定（程序算定，必须遵守）】\n"
            "%s：%s %scm − press %s = diff %s → 档位「%s」（%s，%s）。\n"
            "结算：Δ体 %+.0f，Δ心 %+.0f（原型 %s）。\n"
            % (name, _subject, L, press, diff, tier, tag, gap, db, dh, arch)
        )
        if reaction_pos or reaction_phys or reaction_text:
            judge_text += "【本档位写法】\n"
            if reaction_pos:
                if tier == "身体释放":
                    # 身体释放：生理位置是核心，必须逐字写出来
                    judge_text += "位置（必须逐字写出这段生理细节）：%s\n" % reaction_pos
                else:
                    judge_text += "位置：%s\n" % reaction_pos
            if reaction_phys:
                judge_text += "生理：%s\n" % reaction_phys
            if reaction_text:
                judge_text += "反应：%s\n" % reaction_text

        # 恶堕进度（按对象累积）
        _evil = int(cs.get("evil_progress") or 0)
        _stage_name, _stage_dir = evil_stage(_evil)
        judge_text += "【恶堕进度】%d/5（%s：%s）\n" % (_evil, _stage_name, _stage_dir)
        # 对象判定（关系层优先）
        _relation = (cs.get("relation") or "")
        _breaker, _kind = classify_breaker(user_input, (state.get("player") or {}).get("name", ""), _relation)
        _kind_desc = {"lover": "爱人，不累积恶堕", "ntr": "NTR，恶堕+2", "force": "强制，恶堕+1"}.get(_kind, "")
        judge_text += "【本轮对象】%s（%s）\n" % (_breaker, _kind_desc)

        if pussy_name and mq_hook:
            judge_text += "名器「%s」钩子：%s\n" % (pussy_name, mq_hook)

        # 按需注入：角色卡声明的性癖 + 体位（从招式库数据取对应条目）
        _kink_parts = []
        for k in (card or {}).get("kinks") or []:
            _code = k.get("code", "") if isinstance(k, dict) else str(k)
            _entry = kinks_db.get(_code) or {}
            if not _entry:
                continue
            _nm = _entry.get("name", _code)
            _def = _entry.get("definition", "")
            _kink_parts.append("%s %s（%s）" % (_code, _nm, _def[:60]) if _def else "%s %s" % (_code, _nm))
        if _kink_parts:
            judge_text += "性癖参考：" + "；".join(_kink_parts) + "\n"

        _pos_parts = []
        for p in (card or {}).get("positions") or []:
            _code = p.get("code", "") if isinstance(p, dict) else str(p)
            _entry = positions_db.get(_code) or {}
            if not _entry:
                continue
            _nm = _entry.get("name", _code)
            _act = _entry.get("男方动作", "")
            _pos_parts.append("%s %s：%s" % (_code, _nm, _act[:60]) if _act else "%s %s" % (_code, _nm))
        if _pos_parts:
            judge_text += "体位参考：" + "；".join(_pos_parts) + "\n"

        # 露骨零件（床戏轮注入，保证密度/句长达标）
        if luogu.get("organs"):
            judge_text += "【器官词（必用本名，保证露骨密度）】\n%s\n" % luogu["organs"]
        if luogu.get("juices"):
            judge_text += "【体液描写】\n%s\n" % luogu["juices"]
        if luogu.get("jushi"):
            judge_text += "【句式参考（写长句，句长 50–100 字）】\n%s\n" % luogu["jushi"]
        if luogu.get("moans"):
            judge_text += "【呻吟淫语（用❤不用～）】\n%s\n" % luogu["moans"]

        judge_text += "请严格按这个档位写她的反应，不要自己重新判定、不要跳档。"

        info = {
            "name": name, "press": press, "L": L, "diff": diff,
            "tier": tier, "tag": tag, "gap": gap,
            "archetype": arch, "delta_body": db, "delta_heart": dh,
            "position": reaction_pos,
        }
        return judge_text, info

    return None, None
