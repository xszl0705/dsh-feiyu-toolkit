# -*- coding: utf-8 -*-
"""
组装层：把「剧本 + 玩家 + 在场角色 + 世界书 + MOD + 历史」拼成 messages。
纯函数，不碰网络，方便单测和预览。
"""

import re

import judge  # 判定引擎（运算层，三层分离第一步）

# 注入顺序 = 优先级（前者压后者）
SECTION_ORDER = ["MOD", "世界观", "故事", "你的角色", "在场角色", "场景资料", "补充规则"]

# 每个角色默认注入哪些块、各取多少字
BLOCK_BUDGET = {
    "core": 400,        # 永远注入
    "speech": 300,      # 精简注入
    "appearance": 0,    # 按需
    "history": 0,
    "relations": 0,
    "kinks": 0,
    "secrets": 0,
}

BLOCK_TITLES = {
    "core": "核心",
    "speech": "说话方式",
    "appearance": "外貌",
    "history": "过往",
    "relations": "关系",
    "kinks": "敏感点",
    "secrets": "她不会说的事",
}


def _clip(text, n):
    if not text:
        return ""
    t = text.strip()
    if n <= 0 or len(t) <= n:
        return t
    return t[:n].rstrip() + "…"


def pick_char_blocks(card, user_input, history_text="", scene="normal", affection=0, outfit=""):
    """
    决定这个角色这次注入哪些块。
    scene: "normal"（剧情轮）| "bed"（床戏轮）
    affection: 当前好感值（决定注入 matrix 哪一档）
    outfit: 当前衣着名（决定注入哪套）
    支持两种结构：新结构（profile/matrix/body_data）与旧结构（blocks）
    """
    out = []

    # ══════ 新结构 ══════
    if card.get("profile"):
        p = card["profile"] or {}
        _blocks = card.get("blocks") or {}

        def _blk(_k):
            """读 blocks[_k].text（编辑器写这里）；没有返回空。"""
            return ((_blocks.get(_k) or {}).get("text") or "").strip()

        # ① 核心档案（永远注入）——blocks.appearance 优先，profile 兜底
        bits = []
        _app = _blk("appearance") or (p.get("appearance") or "")
        if _app:
            bits.append("外貌：" + _app)
        if p.get("personality"):
            bits.append("性格：" + p["personality"])
        if p.get("identity"):
            bits.append("身份：" + p["identity"])
        if p.get("height") or p.get("measurements"):
            bits.append("体态：%s / %s" % (p.get("height", ""), p.get("measurements", "")))
        if bits:
            out.append(("核心", _clip("\n".join(bits), 900)))

        # ② 铁律（永远注入）——blocks.core 优先，顶层 core 兜底
        ct = _blk("core") or (card.get("core") or {}).get("text", "")
        if ct:
            out.append(("铁律", _clip(ct, 500)))

        # ③ 说话方式——blocks.speech 优先，顶层 speech 兜底
        sp = _blk("speech") or (card.get("speech") or {}).get("text", "")
        if sp:
            out.append(("说话方式", _clip(sp, 400)))

        # ④ 人格矩阵（按好感档取）
        m = card.get("matrix") or {}
        if m:
            try:
                aff = int(affection or 0)
            except Exception:
                aff = 0
            if aff < 30:
                key, label = "to_user_low", "对玩家（尚不亲近）"
            elif aff < 70:
                key, label = "to_user_mid", "对玩家（已亲近）"
            else:
                key, label = "to_user_peak", "对玩家（深爱）"
            if m.get(key):
                out.append((label, m[key]))
            if scene == "bed" and m.get("on_bed"):
                out.append(("床上", m["on_bed"]))

        # ⑤ 身体数据（只在床戏轮）——精简版：核心 3 部位（小穴/胸/臀）+ 按需（嘴/菊/腿）
        # 去掉 SR/SSR 分级标签和「XX 级兑现」元话术，只留具体特征；子宫合并进小穴。
        if scene == "bed":
            bd = card.get("body_data") or {}
            _inp = (user_input or "")
            order = ["pussy", "breast", "ass"]
            if any(w in _inp for w in ("口交", "含", "吞", "舔", "嘴", "舌", "喉")):
                order.append("mouth")
            if any(w in _inp for w in ("菊", "后穴", "肛", "屁眼")):
                order.append("anus")
            if any(w in _inp for w in ("腿", "足", "丝袜", "脚")):
                order.append("legs")
            names = {"pussy": "小穴", "breast": "胸", "ass": "臀",
                     "mouth": "嘴", "anus": "菊", "legs": "腿足"}

            def _clean_body_text(t):
                if not t:
                    return ""
                t = re.sub(r"[A-Z]{1,3}\s*级兑现[：:]\s*", "", t)
                return t.strip()

            lines = []
            for k in order:
                v = bd.get(k)
                if not isinstance(v, dict):
                    continue
                nm = (v.get("name") or "").strip()
                t = _clean_body_text(v.get("text") or "")
                if k == "pussy":
                    _w = bd.get("womb") or {}
                    if isinstance(_w, dict) and _w.get("text"):
                        t = (t + " " if t else "") + "深处（子宫）：" + _clean_body_text(_w.get("text") or "")
                if not t:
                    continue
                head = ("（%s）" % nm) if nm else ""
                lines.append("· %s%s：%s" % (names.get(k, k), head, t))
            if lines:
                out.append(("身体（%s）" % scene, "\n".join(lines)))

        # ⑥ 性癖 / 体位（永远注入，但只列编号+名）
        ks = card.get("kinks") or []
        if ks:
            s = "、".join("%s %s" % (x.get("code", ""), x.get("name", "")) if isinstance(x, dict) else str(x) for x in ks)
            out.append(("性癖", s))
        ps = card.get("positions") or []
        if ps:
            s = "、".join("%s %s" % (x.get("code", ""), x.get("name", "")) if isinstance(x, dict) else str(x) for x in ps)
            out.append(("喜好体位", s))

        # ⑦ 当前衣着
        ofs = card.get("outfits") or []
        if ofs:
            cur = outfit or ""
            chosen = None
            for o in ofs:
                if cur and o.get("name") == cur:
                    chosen = o
                    break
            if not chosen:
                for o in ofs:
                    if o.get("default"):
                        chosen = o
                        break
            if not chosen:
                chosen = ofs[0]
            out.append(("当前衣着", "%s｜%s｜机关：%s" % (
                chosen.get("name", ""), chosen.get("desc", ""), chosen.get("key", ""))))

        # ⑧ 其余块（按关键词命中）
        hay = (user_input or "") + "\n" + (history_text or "")[-800:]
        blocks = card.get("blocks") or {}
        for key in ("history", "relations", "kinks", "secrets"):
            txt = (blocks.get(key) or {}).get("text", "")
            if not txt or txt.startswith("（"):
                continue
            trig = (blocks.get(key) or {}).get("triggers") or []
            hit = any(t and t in hay for t in trig) if trig else (key == "history" and any(
                w in hay for w in ("过去", "以前", "曾经", "那次", "当年")))
            if hit:
                out.append((BLOCK_TITLES.get(key, key), _clip(txt, 500)))

        return out

    # ══════ 旧结构兜底 ══════
    blocks = card.get("blocks") or {}

    core = (blocks.get("core") or {}).get("text", "")
    if core:
        out.append(("核心", _clip(core, BLOCK_BUDGET["core"])))

    speech = (blocks.get("speech") or {}).get("text", "")
    if speech:
        out.append(("说话方式", _clip(speech, BLOCK_BUDGET["speech"])))

    hay = (user_input or "") + "\n" + (history_text or "")[-800:]
    for key in ("appearance", "history", "relations", "kinks"):
        txt = (blocks.get(key) or {}).get("text", "")
        if not txt:
            continue
        trig = (blocks.get(key) or {}).get("triggers") or []
        hit = any(t and t in hay for t in trig) if trig else False
        if hit:
            out.append((BLOCK_TITLES.get(key, key), _clip(txt, 500)))

    return out


def split_worldbook(wb_list, script, user_input, history_text=""):
    """决定哪些世界书命中"""
    mode = (script.get("worldbook_mode") or "all")
    excl = set(script.get("worldbook_exclude") or [])
    hay = (user_input or "") + "\n" + (history_text or "")[-800:]
    hits = []
    for wb in wb_list:
        if wb.get("enabled") is False:
            continue
        if mode == "whitelist" and wb["id"] in excl:
            continue
        keys = wb.get("keys") or []
        if any(k and k in hay for k in keys):
            hits.append(wb)
        if len(hits) >= 3:      # 一次最多 3 条
            break
    return hits


def filter_mods(mods, script, session):
    """
    MOD 三层过滤：
    ① 全局 enabled=false → 排除
    ② scope=script 且 script_id 不等于当前剧本 → 排除
    ③ mod_overrides 里明确 false → 排除
    """
    sid = (script or {}).get("id")
    overrides = {}
    overrides.update((script or {}).get("mod_overrides") or {})
    overrides.update((session or {}).get("mod_overrides") or {})

    out = []
    for m in mods:
        mid = m.get("id")
        if m.get("enabled") is False:
            continue
        scope = m.get("scope") or "global"
        if scope == "script" and m.get("script_id") and m.get("script_id") != sid:
            continue
        if mid in overrides and overrides[mid] is False:
            continue
        out.append(m)
    return out


def is_judge_enabled(used_mods):
    """
    判定引擎 MOD 是否启用。
    判定计算只在引擎 MOD 开启时进行——关掉 MOD，运算层整体不介入。
    识别方式：MOD 标了 role="judge"，或名字里含「判定引擎」。
    """
    for m in (used_mods or []):
        if m.get("role") == "judge":
            return True
        if "判定引擎" in (m.get("name") or ""):
            return True
    return False


SCENE_WORDS = ("脱", "插", "进", "做", "操", "干", "顶", "射", "床", "衣服", "解",
               "吻", "舔", "含", "摸", "揉", "抱", "压", "骑", "趴", "腿", "胸", "腰")

# ── 明确的性事输出（不是氛围，是实打实的性行为）──
EXPLICIT_SEX_WORDS = (
    # 进入
    "插进", "插入", "进入", "顶进", "送进", "没入", "整根", "破宫", "宫口", "撞开",
    # 动作
    "抽送", "顶撞", "抽插", "抽动", "挺动", "研磨", "磨蹭", "抽出来", "再送",
    # 结果
    "中出", "内射", "射在", "射进", "射满", "高潮", "潮吹", "痉挛", "失守",
    # 口手与部位
    "口交", "含住", "吞下", "舔舐", "抠", "揉弄",
    # 状态
    "淫水", "骚穴", "小穴", "阴道", "子宫", "湿透", "花心",
    # 暴力 / 强迫
    "强奸", "强暴", "迷奸", "轮奸", "奸淫", "侵犯", "强行", "强迫", "逼迫",
    "强行扒", "按倒", "压制",
    # 口语直述（单字太宽泛，用双字/三字组合）
    "干了", "干她", "干他", "操了", "操她", "操他", "操你",
    "肉干", "狠干", "猛干", "爆干", "狠操", "猛操", "爆操", "狠狠干", "狠狠操",
    "睡了", "睡她", "睡过", "上了她", "上了他", "把她上了", "把他上了",
    # 性事本名
    "做爱", "性爱", "性交", "交合", "肏", "破处", "开苞", "破瓜",
)

# ── 选项类型标签（前端渲染选项时的前缀）──
SEX_OPTION_TAGS = ("性爱剧情", "极致欢愉", "NTR恶堕剧情", "恶堕剧情", "NTR",
                   "色欲", "欲望", "情欲", "床戏", "交合", "肉体")
NEUTRAL_OPTION_TAGS = ("剧情推进", "日常互动")
TIME_SKIP_TAG = "时间跳跃"
CUSTOM_ACTION_TAG = "自定义行动"

# ── NTR 迹象词（出现第二个男性/背德/出轨/偷窥等情境时，触发「NTR恶堕剧情」选项）──
# 覆盖多类 NTR 情景：伴侣/前任、第三者、出轨背叛、偷窥偷拍、多人交换、抓奸、背德亲属、乘虚而入
NTR_HINT_WORDS = (
    # 伴侣 / 前任
    "男友", "男朋友", "老公", "丈夫", "前男友", "未婚夫", "前任", "旧爱", "初恋",
    # 第三者 / 介入者
    "黄毛", "苦主", "第三者", "奸夫", "情夫", "姘头", "小三", "野男人", "情人", "情郎", "隔壁老王",
    # 出轨 / 背叛
    "出轨", "劈腿", "偷情", "外遇", "红杏出墙", "戴绿帽", "不忠", "背叛", "背德", "NTR", "寝取", "绿帽",
    # 偷窥 / 偷拍
    "偷窥", "偷看", "偷听", "偷拍", "窥视", "窥探", "偷瞄",
    # 男性 / 肤色
    "男人", "男性", "黑人", "白人", "男同事", "男经理", "男上司", "男客户",
    "别的男人", "其他男人", "另一个男人", "第二个男人",
    # 多人 / 交换
    "3P", "群交", "轮奸", "多人", "交换", "换妻",
    # 抓奸
    "捉奸", "抓奸",
    # 背德亲属（家庭伦理 NTR）
    "继父", "义父", "小叔", "叔父", "伯父", "岳父", "父亲", "公公", "爸爸", "爹", "老爹",
    # 乘虚而入（下药 / 灌醉 / 迷奸）
    "下药", "灌醉", "迷奸", "失去意识",
    # 勾引 / 诱惑
    "勾引", "诱惑",
)


def has_explicit_sex(text):
    """是否含「明确的性事输出」"""
    return any(w in (text or "") for w in EXPLICIT_SEX_WORDS)


def get_judge_mod_data(mods):
    """
    返回启用的引擎 MOD 的完整 dict（含 vocab / reactions / mingqi）。
    没有则返回 {}。
    """
    for m in (mods or []):
        is_judge = (m.get("role") == "judge") or ("判定引擎" in (m.get("name") or ""))
        if is_judge and m.get("enabled") is not False:
            return m
    return {}


def parse_mod_vocab(mods):
    """
    从引擎 MOD 的 `vocab` 字段读词表（JSON，程序读，不进 prompt）。
    vocab 结构：{scene_words: [...], explicit_sex_words: [...], ...}
    返回 {TAG: [词, ...]}；MOD 没给 vocab 则返回 {}。
    """
    m = get_judge_mod_data(mods)
    v = m.get("vocab") if m else None
    if not isinstance(v, dict):
        return {}
    return {k: (list(v[k]) if isinstance(v[k], list) else []) for k in v}


# 插入/口交动作词——自由输入时，「氛围词够了」还必须含至少一个，才算床戏
INSERT_VERBS = ("插进", "插入", "顶进", "送进", "没入", "整根", "抽送", "顶撞",
                "抽插", "操进", "肏进", "插她", "插他", "含住", "吞下", "骑上",
                "坐上去", "舔", "吸", "磨")


def _after_bed(hist, explicit_words):
    """上一轮是床戏？取历史末尾 800 字，含 ≥2 个明确性事词就判延续。"""
    if not hist:
        return False
    tail = hist[-800:]
    return sum(1 for w in explicit_words if w in tail) >= 2


def detect_scene(user_input, history_text="", vocab=None):
    """
    判断本轮是不是床戏轮（是否触发性事床戏判定）。

    词表优先从引擎 MOD 的 vocab 读（vocab 参数）；MOD 没给就用代码内默认值兜底。

    判定优先级：
      ① 性爱剧情 / 极致欢愉 / NTR恶堕剧情  → 是
      ② 剧情推进 / 日常互动                → 否
      ③ 时间跳跃                          → 只认明确性事
      ④ 自定义行动                        → 只认明确性事
      ⑤ 自由输入                          → 明确性事 或 氛围词≥4
    """
    inp = (user_input or "").strip()
    if not inp:
        return False
    if len(inp) < 4:
        return _after_bed(history_text, EXPLICIT_SEX_WORDS)

    v = vocab or {}
    scene_words = v.get("scene_words") or list(SCENE_WORDS)
    explicit_words = v.get("explicit_sex_words") or list(EXPLICIT_SEX_WORDS)
    sex_tags = v.get("sex_option_tags") or list(SEX_OPTION_TAGS)
    neutral_tags = v.get("neutral_option_tags") or list(NEUTRAL_OPTION_TAGS)
    time_tags = v.get("time_skip_tag") or [TIME_SKIP_TAG]
    custom_tags = v.get("custom_action_tag") or [CUSTOM_ACTION_TAG]

    def _explicit(t):
        return any(w in t for w in explicit_words)

    # ① 性事类选项 → 直接是
    if any(tag in inp for tag in sex_tags):
        return True

    # ② 中性选项 → 直接否
    if any(tag in inp for tag in neutral_tags):
        return False

    # ③ 时间跳跃 → 必须有明确性事
    if any(tag in inp for tag in time_tags):
        return _explicit(inp)

    # ④ 自定义行动 → 只认明确性事
    if any(tag in inp for tag in custom_tags):
        return _explicit(inp)

    # ⑤ 自由输入 → 明确性事 或 (氛围词≥4 且 含插入/口交动作) 或 上一轮床戏延续
    if _explicit(inp):
        return True
    # 上一轮已经是床戏 → 本轮默认延续（用户选「剧情推进/日常互动」才会退出，
    # 前面 ② 已经拦掉了这两种）
    if _after_bed(history_text, explicit_words):
        return True
    hit = sum(1 for w in scene_words if w in inp)
    if hit >= 4:
        # 光有氛围词不够——还要确认真在做事：含插入/口交动作，或上一轮是床戏
        if any(w in inp for w in INSERT_VERBS):
            return True
        if _after_bed(history_text, explicit_words):
            return True
    return False


def assemble(script, session, characters, worldbooks, mods, history, user_input):
    """
    返回 (messages, report)
    report 是给「prompt 预览」用的分段统计
    """
    parts = []          # [(段名, 文本)]
    report = []         # [(段名, 字数, 来源)]

    # ① MOD（三层过滤后，按 priority 降序）
    used_mods = filter_mods(mods, script, session)
    used_mods.sort(key=lambda m: m.get("priority", 0), reverse=True)

    # 先算场景（供 MOD 注入判断）：剧情轮不注入判定引擎的写作规范，
    # 否则「性格通过动作表现，不用台词」等规则会压制叙事/台词/心理。
    _hist_text0 = "\n".join(h.get("content", "") for h in (history or [])[-4:])
    _vocab0 = parse_mod_vocab(used_mods)
    _is_bed0 = detect_scene(user_input, _hist_text0, _vocab0)

    for m in used_mods:
        txt = (m.get("content") or "").strip()
        if not txt:
            continue
        # 判定引擎 MOD：只在床戏轮注入；剧情轮跳过（减负 + 解放叙事）
        if m.get("role") == "judge" and not _is_bed0:
            continue
        parts.append(("MOD·" + (m.get("name") or "未命名"), txt))
        report.append(("MOD·" + (m.get("name") or ""), len(txt), "勾选"))

    # 叙事词库：从 data 里按输入抽动作/心理/口癖各一条
    try:
        _nv = None
        for _m in used_mods:
            if (_m.get("id") or "") == "md_narrative_vocab":
                _nv = _m.get("data") or {}
                break
        if _nv:
            _seed = sum(ord(_c) for _c in (user_input or "scene"))
            _lines = []
            for _key, _label in (("actions", "动作"), ("psych", "心理"), ("voices", "口癖")):
                _arr = list((_nv.get(_key) or {}).values())
                if _arr:
                    _p = _arr[_seed % len(_arr)]
                    if _p.get("line"):
                        _lines.append("%s：%s" % (_label, _p["line"]))
            if _lines:
                parts.append(("叙事词库参考", "\n".join(_lines)))
                report.append(("叙事词库参考", len("\n".join(_lines)), "词库抽样"))
    except Exception:
        pass

    # 剧情轮安全网：性事 MOD 存在但不注入时，补一段「轻度规范」兜底，
    # 避免剧情轮/误判时写得太素（器官用本名、允许暧昧，但不要求露骨密度）。
    _has_judge_mod = any(
        (m.get("role") == "judge") or ("判定引擎" in (m.get("name") or ""))
        for m in used_mods)
    if _has_judge_mod and not _is_bed0:
        _lite = ("【叙事规范·轻度】器官用本名（不写「那里」「下面」「私处」）；"
                 "允许暧昧描写（吻、抱、摸、贴着、喘），写感官不写器官细节；不要求露骨密度。")
        parts.append(("叙事·轻度", _lite))
        report.append(("叙事·轻度", len(_lite), "系统"))

    # ② 世界观
    if script.get("world"):
        t = script["world"].strip()
        parts.append(("世界观", t))
        report.append(("世界观", len(t), "剧本"))

    # ③ 故事
    if script.get("story"):
        t = script["story"].strip()
        parts.append(("故事", t))
        report.append(("故事", len(t), "剧本"))

    # ④ 玩家角色（支持任意自定义字段）
    player = (session or {}).get("player") or {}
    role_choice = (session or {}).get("role_choice") or ""
    pbits = []

    # 身份选项（如果剧本定义了）
    role_choices = script.get("role_choices") or []
    if role_choice and role_choices:
        for rc in role_choices:
            if rc.get("key") == role_choice:
                pbits.append("身份选择：" + rc.get("label", role_choice))
                break

    # 字段：优先用剧本定义的 player_fields，退化为固定四个
    fields = script.get("player_fields") or []
    _seen_keys = set()
    if fields:
        for f in fields:
            k = f.get("key")
            if not k:
                continue
            v = player.get(k)
            if v in (None, "", []):
                continue
            pbits.append("%s：%s" % (f.get("label", k), v))
            _seen_keys.add(k)
    else:
        if player.get("name"):
            pbits.append("名字：" + player["name"])
            _seen_keys.add("name")
        if player.get("age"):
            pbits.append("年龄：" + str(player["age"]))
            _seen_keys.add("age")
        if player.get("identity"):
            pbits.append("身份：" + player["identity"])
            _seen_keys.add("identity")
        if player.get("extra"):
            pbits.append("其他设定：" + player["extra"])
            _seen_keys.add("extra")

    # 通用字段：剧本没定义也照样注入（所有剧本一致）
    _UNIVERSAL = [
        ("name", "姓名"), ("age", "年龄"), ("gender", "性别"),
        ("appearance", "外貌"), ("personality", "性格"), ("talent", "天赋"),
        ("extra", "其他设定"), ("identity", "身份"),
    ]
    for _k, _label in _UNIVERSAL:
        if _k in _seen_keys:
            continue
        _v = player.get(_k)
        if _v in (None, "", []):
            continue
        pbits.append("%s：%s" % (_label, _v))

    # 自定义身体字段（向导里新增的，不在 script.player_fields 里）
    _EXTRA = [
        ("height", "身高"), ("body_type", "体型"), ("bust", "胸围"), ("waist", "腰围"),
        ("hip", "臀围"), ("milk_volume", "乳量"), ("sensitivity", "敏感度"), ("fertility", "受孕体质"),
        ("hair_color", "发色"), ("skin_color", "肤色"), ("eye_color", "瞳色"),
        ("length", "阴茎长度"), ("shaft_diameter", "茎身直径"), ("glans_diameter", "龟头直径"),
        ("qizhi_main", "主气质"), ("qizhi_sub1", "副气质1"), ("qizhi_sub2", "副气质2"),
    ]
    _BT = {"loli": "萝莉", "girl": "少女", "onee": "御姐", "mature": "熟女", "plump": "丰满",
           "thin": "消瘦", "normal": "匀称", "athletic": "健硕", "fat": "肥胖"}
    _MK = {"poor": "贫乳", "normal": "普乳", "big": "巨乳", "huge": "爆乳", "super": "超乳"}
    _seen = set()
    for _k, _label in _EXTRA:
        _v = player.get(_k)
        if _v in (None, "", []):
            continue
        if _k == "body_type":
            _v = _BT.get(_v, _v)
        if _k == "milk_volume":
            _v = _MK.get(_v, _v)
        pbits.append("%s：%s" % (_label, _v))
        _seen.add(_k)

    _ch = player.get("charm")
    if isinstance(_ch, dict) and _ch.get("score"):
        _cline = _ch.get("combo") or ""
        pbits.append("魅力：%s/100（%s）%s" % (
            _ch.get("score"), _ch.get("band") or "", ("，组合：" + _cline) if _cline else ""))

    _gender = str(player.get("gender") or "")
    if "扶她" in _gender or "futa" in _gender.lower():
        pbits.append(
            "【扶她设定·硬性】玩家是扶她（双性）：同时拥有阴茎和女性器官。"
            "所有 NPC——不论男女——第一眼、第一反应都先把她当女人（女性称谓、目光先看胸腰臀），"
            "发现额外器官之后才重新定价，顺序不能反。"
            "性事描写的顺序固定为：先胸 → 再小穴 → 最后才轮到阴茎；"
            "女性身体是主戏，阴茎是附加，不许反过来，也不许用阴茎顶替女性描写。"
            "写胸必须有画面感（晃动、弹动、被撞得乱颤、乳肉从指缝溢出），不能一笔带过。"
        )

    if pbits:
        t = "\n".join(pbits)
        parts.append(("你的角色", t))
        report.append(("你的角色", len(t), "玩家填写"))

    # ⑤ 在场角色
    hist_text = _hist_text0
    active = (session or {}).get("active_npcs") or []

    # 判断本轮场景（床戏 or 剧情）——复用前面算好的结果，避免重复计算
    _vocab = _vocab0
    is_bed = _is_bed0
    scene = "bed" if is_bed else "normal"

    # 会话里的状态（好感 / 衣着）
    st = (session or {}).get("state") or {}

    # ── 判定引擎（运算层）：床戏轮 + 引擎 MOD 启用时才计算 ──
    judge_text = None
    judge_info = None
    if is_bed and is_judge_enabled(used_mods):
        _mod_data = get_judge_mod_data(used_mods)
        active_pairs = []
        for _cid in active:
            _card = characters.get(_cid)
            if not _card:
                continue
            _cs = (st.get("npcs") or {}).get(str(_cid)) or (st.get("npcs") or {}).get(_cid) or {}
            active_pairs.append((_card, _cs))
        judge_text, judge_info = judge.build_judge_inject(active_pairs, st, user_input, _mod_data)

    for cid in active:
        card = characters.get(cid)
        if not card:
            continue
        cs = (st.get("npcs") or {}).get(str(cid)) or (st.get("npcs") or {}).get(cid) or {}
        aff = cs.get("affection")
        if aff is None:
            aff = (card.get("initial_state") or {}).get("affection", 0)
        outfit = cs.get("outfit") or (card.get("initial_state") or {}).get("outfit", "")

        picks = pick_char_blocks(card, user_input, hist_text, scene=scene, affection=aff, outfit=outfit)
        if not picks:
            continue
        body = "\n".join("%s：%s" % (k, v) for k, v in picks)
        _role = ((session or {}).get("npc_roles") or {}).get(str(cid)) or "local"
        _nm = card.get("name", cid)
        if _role == "teammate":
            t = ("（她是和玩家一起穿越进来的轮回者队友，来自别的世界，知道主神、副本、任务这些概念。"
                 "严禁把她写成本世界的居民：不得给她这个副本里的身份、名分、亲属关系、地位或职务"
                 "（不是神代家的人、不是村长的人、不是这个村子的女主人/夫人/王妃），"
                 "也不得把世界书里任何本地角色的身份安到她头上。"
                 "她的原身份只作为背景，在本副本里她只有「玩家的队友」这一个身份。）\n%s" % body)
            parts.append(("轮回者队友·" + _nm, t))
            report.append(("轮回者队友·" + _nm, len(t), "角色库·%s" % scene))
        else:
            t = "【%s】\n%s" % (_nm, body)
            parts.append(("在场角色·" + _nm, t))
            report.append(("在场角色·" + _nm, len(t), "角色库·%s" % scene))

    # ⑥ 世界书
    wb_hits = split_worldbook(worldbooks, script, user_input, hist_text)
    for wb in wb_hits:
        t = (wb.get("content") or "").strip()
        parts.append(("场景资料·" + (wb.get("title") or ""), t))
        report.append(("场景资料·" + (wb.get("title") or ""), len(t), "世界书命中"))

    # ⑦ 补充规则
    if script.get("rules"):
        t = script["rules"].strip()
        parts.append(("补充规则", t))
        report.append(("补充规则", len(t), "剧本"))

    # ⑦½ 判定引擎（运算层算定的档位，放这里权重高、靠后）
    if judge_text:
        parts.append(("判定引擎", judge_text))
        report.append(("判定引擎", len(judge_text), "运算层"))

    # ⑧ 字数：只在 tail 里出现一次，这里只记录到报告
    wt = (session or {}).get("word_target")
    if wt:
        report.append(("字数目标", 0, "%s 字" % wt))

    # ⑨ 记忆（长期 + 短期）
    mem = (session or {}).get("memory") or {}
    ltm = mem.get("ltm") or []
    stm = mem.get("stm") or []
    if ltm:
        recent = ltm[-3:]
        body_m = "\n".join(
            "[%s] %s：%s" % (x.get("range", ""), x.get("scene", ""), x.get("event", ""))
            for x in recent
        )
        parts.append(("长期记忆（最近 %d 条）" % len(recent), body_m))
        report.append(("长期记忆", len(body_m), "%d/%d 条" % (len(recent), len(ltm))))
    if stm:
        body_s = "\n".join(
            "#%s %s：%s" % (x.get("round", "?"), x.get("scene", ""), x.get("event", ""))
            for x in stm
        )
        parts.append(("短期记忆（本轮之前）", body_s))
        report.append(("短期记忆", len(body_s), "%d 条" % len(stm)))

    # ── 拼 system ──
    head = "你现在在一个名为《%s》的互动剧情中扮演角色。" % script.get("name", "未命名剧本")

    if active:
        names = [characters.get(i, {}).get("name") for i in active if characters.get(i)]
        names = [n for n in names if n]
        if names:
            head += "在场角色：" + "、".join(names) + "。"
    player = (session or {}).get("player") or {}
    pname = player.get("name") or ""
    if not pname:
        # 从自定义字段里找名字
        for f in (script.get("player_fields") or []):
            if f.get("key") in ("name", "姓名"):
                pname = player.get(f["key"], "")
                break
    _g_p = str(player.get("gender") or "")
    _is_futa_p = ("扶她" in _g_p) or ("futa" in _g_p.lower())
    if pname:
        head += "和你对话的人叫「%s」%s。" % (pname, "（扶她·双性）" if _is_futa_p else "")

    body = "\n\n".join("【%s】\n%s" % (k, v) for k, v in parts)

    tail = "以第二人称「你」（玩家扮演的角色）的视角推进剧情，直接写正文，不解释、不评论、不跳出角色。所有动作和对话都要写清主语：谁在动、谁在说、谁在看，不要只用「他/她」指代造成混乱。"
    if pname:
        tail += "不要替「%s」行动或说话。" % pname

    # ── 字数硬要求（放最末尾，权重最高；只出现这一次）──
    wt = (session or {}).get("word_target")
    if wt:
        try:
            wt_i = int(wt)
        except Exception:
            wt_i = 0
    else:
        wt_i = 0

    # 剧本 rules 里的字数要求：有 word_target 时一律不拼（避免冲突）
    rules = (script.get("rules") or "")
    if wt_i <= 0 and rules and not any(k in rules for k in ("字", "长度", "篇幅")):
        tail += "每次回复 800–2000 字。"

    if wt_i > 0:
        tail += (
            "\n\n【字数硬要求】本次回复正文必须写满 %d 字。"
            "写到 %d 字之前不许收尾、不许总结、不许跳到下一场景。"
            "字数是硬指标，不足 %d 字视为未完成。" % (wt_i, wt_i, wt_i)
        )

    # ── 视角约束：玩家输入含「角色不知情」的隐藏信息时，禁止正文写「被发现/察觉」 ──
    HIDDEN_WORDS = ("不知道", "没察觉", "没注意", "未察觉", "不知情", "暗中", "偷偷",
                    "背地里", "不为人知", "秘密", "没发现", "没有发现", "没看到", "没看见",
                    "没听见", "没留意", "没注意到", "完全没", "毫无察觉")
    if any(w in (user_input or "") for w in HIDDEN_WORDS):
        tail += (
            "\n\n【视角约束 · 最高优先级，违反即失败】"
            "玩家输入里的「你不知道的是」「你没察觉」是「戏剧性讽刺」："
            "读者（玩家）知道这个秘密，但「你」扮演的角色本人毫不知情。"
            "正文必须严格以「你」这个角色的视角写："
            "1. 你本人不知道、没察觉的事，绝不能写成「你知道」「你察觉」「你看见」「你听到动静」；"
            "2. 更不能让「她」发现、看向、提及、或对那个隐藏人物说话；"
            "3. 隐藏的偷窥者只能作为「旁白」出现（如「门外的影子动了动」），"
            "   你和她的认知里都必须完全不知道有这么个人；"
            "4. 隐藏人物绝不能走进来、出现在你面前、或当着你做任何事——他必须始终待在暗处不被你发现。"
        )

    # 输出格式要求（选项）——固定 7 类，NTR 条件触发
    if (session or {}).get("enable_options", True):
        # 判断是否有 NTR 语境
        st = (session or {}).get("state") or {}
        extras = st.get("extras") or {}
        has_ntr_extra = any(
            (v.get("role") in ("黄毛", "苦主")) or (v.get("status") == "active")
            and ("NTR" in (v.get("relation") or ""))
            for v in extras.values()
        )
        script_tags = script.get("tags") or []
        has_ntr_tag = any("NTR" in str(t).upper() or "寝取" in str(t) for t in script_tags)
        has_ntr_kink = False
        for cid in active:
            c = characters.get(cid) or {}
            for k in (c.get("kinks") or []):
                code = k.get("code", "") if isinstance(k, dict) else ""
                if code in ("X66", "X67", "X68"):
                    has_ntr_kink = True
                    break
        # 检测「历史正文 + 玩家输入 + 剧本设定」里是否出现第二个男性/NTR 迹象
        _hay = (user_input or "") + "\n" + hist_text + "\n" \
               + (script.get("story") or "") + "\n" + (script.get("world") or "") \
               + "\n" + (script.get("opening") or "")
        has_ntr_hint = any(w in _hay for w in NTR_HINT_WORDS)
        show_ntr = has_ntr_extra or has_ntr_tag or has_ntr_kink or has_ntr_hint

        # NTR 场景：切换性事主体——其他男性是主体，玩家是苦主
        if show_ntr:
            tail += (
                "\n\n【NTR 场景 · 最高优先级，必须遵守】本轮是 NTR（寝取）剧情："
                "性事主体是「其他男性」（门口的黑人/黄毛/第三者），不是玩家「你」。"
                "玩家「你」是苦主（被绿的一方）——只能旁观、被迫接受、或痛苦地看着。"
                "正文写「其他男性」与女方发生关系：那个男性的鸡巴插入女方、抽插、让她破宫、让她淫叫，"
                "女方的所有反应、淫叫、高潮都针对那个男性。严禁写成「你」和女方做爱。"
            )

        # 射精要求：玩家输入明确要求射精时，注入射精引导（否则 AI 容易略过射精）
        _SHEJING_WORDS = ("射精", "中出", "内射", "精液", "射在", "射进", "射满", "灌满",
                          "注入", "浓精", "白浊", "射里面", "射进去")
        if any(w in (user_input or "") for w in _SHEJING_WORDS):
            tail += (
                "\n\n【射精 · 必须写】本轮玩家明确要求射精，正文必须写出射精场景："
                "谁射、射在哪（子宫/嘴里/脸上/身上）、精液量、射精时的反应（女方被灌满、男方低吼）。"
                "严禁跳过射精、严禁只写「高潮」不写射精、严禁用「结束了」带过。"
            )

        # 选项模板：剧本可自定义（如无限流的 A激进/B稳妥…），否则用默认 7 类
        _opt_tpl = script.get("option_template") or []
        _is_custom_opt = bool(_opt_tpl)
        if _is_custom_opt:
            opts_lines = list(_opt_tpl)
        else:
            opts_lines = [
                "选项1.剧情推进：（写出一个具体的剧情动作，如「把门拉开，让门口的人进来」）",
                "选项2.日常互动：（写出一个具体的日常动作）",
                "选项3.性爱剧情：（写出一个具体的性动作）",
                "选项4.极致欢愉：（写出一个具体的过火玩法）",
            ]
            if show_ntr:
                opts_lines.append("选项5.NTR恶堕剧情：（写「其他男性/黄毛/父亲」的动作——他是主体，"
                                  "如「父亲把她按在桌上从后面整根进入」，严禁写成「你/玩家」的动作）")
                opts_lines.append("选项6.时间跳跃：（写一个具体的时间点，如「第二天早上」）")
                opts_lines.append("选项7.自定义行动：（留空，由玩家填写）")
            else:
                opts_lines.append("选项5.时间跳跃：（写一个具体的时间点，如「第二天早上」）")
                opts_lines.append("选项6.自定义行动：（留空，由玩家填写）")

        _opt_rules = [
            "- 每个选项必须结合【当前剧情】写出具体的动作路线（谁、对谁、做什么、怎么做），"
            "括号里必须是具体动作，严禁写「继续往下」「推动剧情」「做点日常的事」这类空话",
        ]
        if _is_custom_opt:
            _opt_rules.append("- 严格按剧本给定的占位输出选项（A-G 的字母和【标签】都要保留），每条后面写一个具体动作")
        if show_ntr and not _is_custom_opt:
            _opt_rules.append("- 【NTR 主体】本场是 NTR 剧情，「选项5.NTR恶堕剧情」的动作主体必须是「其他男性/黄毛/父亲」，"
                              "写那个男性对女方做什么，严禁把玩家「你」写成动作主体")
        _opt_rules.append("- 最多 %d 条，每条不超过 40 字" % len(opts_lines))
        _opt_rules.append("- 不要重复上一轮给出的选项")
        _opt_rules.append("- 「自定义」永远是最后一条，冒号后留空" if _is_custom_opt
                          else "- 「自定义行动」永远是最后一条，冒号后留空")
        _opt_rules.append("- 选项区之后不要再写任何正文")

        _fmt_note = ("\n【格式 · 最优先】必须一个字母一条，严格照抄下面的字母和【标签】，"
                     "严禁用「选项1」「选项2」这类编号，严禁自创标签。\n\n"
                     if _is_custom_opt else "")
        tail += (
            "\n\n【最后一步 · 必做】正文写完后，必须另起一行输出选项区。\n"
            "即使字数没写够，也必须输出选项区——这是硬性要求。\n"
            + _fmt_note +
            "选项：\n" + "\n".join(opts_lines) + "\n\n"
            "规则：\n" + "\n".join(_opt_rules)
        )

    if _is_futa_p:
        if is_bed:
            tail += (
                "\n\n【玩家性别·硬性】玩家是扶她（双性），同时拥有阴茎和女性器官。"
                "本轮是床戏：可以暴露、可以被发现；被发现之后，NPC 的反应按「先是女人，其次才是扶她」写。"
                "所有 NPC（不论男女）都先把她当女人，再发现器官；"
                "性描写顺序：先胸（写晃动、弹动、乳肉挤压的画面）→ 再小穴（湿、开合、内壁）→ 最后才写阴茎。"
                "不得把玩家当成普通男性，不得用阴茎描写顶替女性描写。"
            )
        else:
            tail += (
                "\n\n【玩家性别·隐蔽】玩家是扶她（双性），但本轮不是床戏。"
                "她的阴茎不暴露、不被提及、不被任何人发现——衣着、姿态、洗澡、换衣、受伤都按普通女人写；"
                "所有 NPC（含女性）只当她是女人。"
                "本轮正文严禁出现任何「她有肉棒 / 双性 / 多一套器官」的暗示；只有进入床戏才会被发现。"
            )

    # ── 前情提要：body 之后（滚动摘要，替代被截断的早期剧情）──
    _card = (session or {}).get("state_card") or ""
    _recap = (session or {}).get("recap") or ""
    _anchor = ""
    if _recap:
        _anchor += "\n\n【前情提要】\n" + _recap
        report.append(("前情提要", len(_recap), "滚动摘要"))

    system = head + "\n\n" + body + _anchor + "\n\n" + tail

    # 自定义配置（前置词 / 提示词 / 后置词）：第一优先级，统一压在最末尾
    _cfg_pre = ((session or {}).get("sess_pre") or script.get("global_pre") or "").strip()
    _cfg_prompt = ((session or {}).get("sess_prompt") or script.get("global_prompt") or "").strip()
    _cfg_post = ((session or {}).get("sess_post") or script.get("global_post") or "").strip()
    if _cfg_pre or _cfg_prompt or _cfg_post:
        system += "\n\n【自定义配置 · 第一优先级（覆盖以上一切冲突）】"
        if _cfg_pre:
            system += "\n【前置词】\n" + _cfg_pre
        if _cfg_prompt:
            system += "\n【提示词】\n" + _cfg_prompt
        if _cfg_post:
            system += "\n【后置词】\n" + _cfg_post
        system += ("\n（以上三段优先级最高：与前面任何默认规则、剧本规则、MOD 冲突时，"
                   "一律以这三段为准。后置词里若要求「只写玩家输入涉及的内容」，"
                   "则不得新增玩家未要求的角色、事件、地点、时间推进或他人主动行为。）")

    # ── 状态卡：放在 system 绝对末尾（紧贴用户输入，权重最高）──
    if _card:
        system += (
            "\n\n【当前状态 · 本轮硬约束】\n" + _card +
            "\n硬性要求："
            "① 正文的时间不得早于上面时间、不得倒退；"
            "② 地点必须就是上面地点，除非正文明确写出移动过程；"
            "③ 在场人必须与上面一致，已离开的人不得凭空出现在身边；"
            "④ 随身物品不得凭空出现或消失；"
            "⑤ 若本轮确实发生了变化（时间推进、移动、有人来去），正文必须写出这个变化是怎么发生的。"
        )
        report.append(("当前状态", len(_card), "状态卡·末位"))

    # ── 拼 messages ──
    messages = [{"role": "system", "content": system}]

    # 开场白（若有）
    op_idx = (session or {}).get("opening_index", 0) or 0
    openings = script.get("openings") or []
    if openings and 0 <= op_idx < len(openings) and openings[op_idx].strip():
        messages.append({"role": "assistant", "content": openings[op_idx].strip()})
    elif script.get("opening"):
        messages.append({"role": "assistant", "content": script["opening"].strip()})

    # 历史：按「字数预算」截断（引擎 MOD 很大，必须给历史设上限防 context 溢出）
    # 性事轮（bed）大幅精简历史：只保留最近状态，避免 AI 复述上一轮的剧情铺垫
    if is_bed:
        HISTORY_BUDGET = 2500   # 性事轮只留最近 2500 字，防止「复述剧情」+「老剧情挤占篇幅」
    else:
        HISTORY_BUDGET = 15000
    _picked = []
    _total = 0
    for h in reversed(list(history or [])):
        _c = h.get("content") or ""
        if _total + len(_c) > HISTORY_BUDGET:
            break
        _picked.append(h)
        _total += len(_c)
    _picked.reverse()
    for h in _picked:
        role = h.get("role")
        if role in ("user", "assistant") and h.get("content"):
            messages.append({"role": role, "content": h["content"]})

    if user_input:
        # 自定义配置 · 前置词/后置词（会话覆盖全局）
        _pre = ((session or {}).get("sess_pre") or script.get("global_pre") or "").strip()
        _post = ((session or {}).get("sess_post") or script.get("global_post") or "").strip()
        _final_input = user_input
        if _pre:
            _final_input = _pre + "\n\n" + user_input
        if _post:
            _final_input = _final_input + "\n\n" + _post
        messages.append({"role": "user", "content": _final_input})

    report.append(("历史", _total, "%d 条（预算 %d 字）" % (len(_picked), HISTORY_BUDGET)))
    report.append(("── 合计", len(system), "system"))

    return messages, report
