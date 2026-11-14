/* dsh-rp-mode · 卡库面板（注入版，纯 JS，无框架依赖）
 *
 * 由 host 在 index.html 里以 <script src="/dsh-rp-mode/panel.js"> 注入，
 * 不依赖 client 模块系统、不依赖 react 基座、不依赖 slots。
 * 数据仍走 /dsh-rp-mode/{meta,cards,cover}。
 */
(function () {
  'use strict';
  if (window.__RP_CARDS_PANEL__) return;
  window.__RP_CARDS_PANEL__ = true;

  var BASE = '/dsh-rp-mode';
  var L1_LABEL = { system: '系统', cast: '群像', scenario: '场景', character: '单角色' };
  var RATING_LABEL = { sfw: 'SFW', light: '轻度', nsfw: 'NSFW', hard: '重口' };
  var RATING_BG = {
    sfw: 'rgba(120,190,120,0.30)',
    light: 'rgba(210,180,90,0.30)',
    nsfw: 'rgba(220,120,120,0.32)',
    hard: 'rgba(200,80,80,0.42)'
  };

  // tags：多选细分标签（身体/性格/身份/玩法/场景 六组统一走 tag 参数的 AND 语义）
  // more：还有没加载的（后端 total > 已加载）
  var state = {
    meta: null, q: '', l1: '', l2: '', rating: '', tags: [],
    items: [], total: 0, active: null, loading: false, more: false,
    // 精简模式下详情抽屉是否展开（false = 只留一条 34px 的把手，把高度全给卡片墙）
    sideOpen: true
  };
  var PAGE = 48;
  var els = {};

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) node.setAttribute('style', style);
    if (text != null) node.textContent = text;
    return node;
  }

  function css(obj) {
    return Object.keys(obj)
      .map(function (k) {
        return k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }) + ':' + obj[k];
      })
      .join(';');
  }

  /* ---------------- 布局：宽屏 / 精简 ----------------
   * 手机端「显示不全」的根因不是宽度，是纵向被吃掉：七组筛选标签在窄屏会折成十几行，
   * 加头部与底部一共挤掉 60% 高度，网格只剩一条缝；右侧 320px 详情栏又把横向吃光。
   * 所以精简模式做四件事：筛选行改成单行横向滑动且整块限高、网格列宽缩到 104px、
   * 详情从右侧栏改成下方可收起的抽屉、卡片只留封面与名字。
   * 不做设备识别：左上角一个按钮手动切，选择记在 localStorage。
   */

  // 2026-11-09：精简布局已删除，只保留桌面宽屏版式（窄视口自动退化成竖排抽屉）。
  // compact 保留为常量 false：renderGrid / renderSide / CardItem 里几十处 compact 判断
  // 仍靠它选「宽屏呈现」（卡片带形态题材、属性标签、字数与简介）。
  var compact = false;

  var BORDER = '1px solid rgba(255,255,255,0.10)';

  /** 窄视口（手机竖屏）：宽屏版式退化成竖排抽屉，但不改版式本身。 */
  function isNarrow() {
    try {
      // matchMedia 优先：手机上页面被按桌面宽度渲染（或用户双指缩放过）时，
      // innerWidth 可能仍是 980 之类的大值，只有媒体查询反映真实可视宽度。
      if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches) return true;
      return Number(window.innerWidth) < 760;
    } catch (e) {
      return false;
    }
  }

  /** 唯一一套尺寸：桌面宽屏版式 + 窄视口退化。改布局只改这里。 */
  function dims() {
    var narrow = isNarrow();
    var drawerOpen = Boolean(state.active) && state.sideOpen !== false;
    return {
      mask: narrow
        ? {
            position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', zIndex: '10000',
            background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'stretch', justifyContent: 'center', padding: '0'
          }
        : {
            position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', zIndex: '10000',
            background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3vh 3vw'
          },
      panel: {
        width: narrow ? '100%' : 'min(1180px,94vw)', height: narrow ? '100%' : 'min(760px,90vh)',
        display: 'flex', flexDirection: 'column',
        borderRadius: narrow ? '0' : '14px', background: 'rgba(24,26,34,0.97)', color: '#e8eaf0',
        border: narrow ? 'none' : '1px solid rgba(255,255,255,0.14)',
        boxShadow: narrow ? 'none' : '0 20px 60px rgba(0,0,0,0.55)',
        overflow: 'hidden', fontSize: narrow ? '12px' : '13px', fontFamily: 'inherit'
      },
      head: narrow
        ? { display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 8px', borderBottom: BORDER, flexWrap: 'wrap' }
        : { display: 'flex', gap: '10px', alignItems: 'center', padding: '12px 14px', borderBottom: BORDER },
      input: narrow
        ? {
            flex: '1 1 100%', minWidth: '0', padding: '6px 8px', borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.07)',
            color: 'inherit', outline: 'none', fontSize: '12px'
          }
        : {
            flex: '1 1 260px', minWidth: '0', padding: '8px 10px', borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.07)',
            color: 'inherit', outline: 'none', fontSize: '13px'
          },
      // vh 相对浏览器视口而非面板：34vh 在 1550px 视口上就是 527px，手机上面板占满整屏，
      // 筛选区会吃掉四成以上 —— 窄屏收紧到 22vh。
      chips: {
        padding: narrow ? '6px 10px 0' : '8px 14px 0',
        maxHeight: narrow ? '22vh' : '34vh', overflowY: 'auto', minHeight: '0',
        flexShrink: '0', WebkitOverflowScrolling: 'touch'
      },
      body: { flex: '1', display: 'flex', flexDirection: narrow ? 'column' : 'row', minHeight: '0' },
      grid: {
        flex: '1', minHeight: '0', overflowY: 'auto', padding: narrow ? '6px' : '12px 14px', display: 'grid',
        gridTemplateColumns: narrow ? 'repeat(auto-fill, minmax(104px, 1fr))' : 'repeat(auto-fill, minmax(172px, 1fr))',
        gap: narrow ? '6px' : '12px', alignContent: 'start'
      },
      side: narrow
        ? {
            width: '100%', flexShrink: '0', borderLeft: 'none',
            borderTop: drawerOpen ? BORDER : 'none',
            // 没选卡就不占地方：那句「点一张卡看详情」原来白吃 34vh，等于把卡片墙挤掉半屏。
            height: state.active ? (state.sideOpen === false ? '38px' : '40vh') : '0px',
            padding: drawerOpen ? '10px 12px' : '0px',
            overflowY: drawerOpen ? 'auto' : 'hidden',
            display: 'flex', flexDirection: 'column', gap: '10px'
          }
        : {
            width: '320px', flexShrink: '0', borderLeft: BORDER, height: 'auto',
            padding: '14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px'
          },
      foot: {
        padding: narrow ? '6px 10px' : '8px 14px', borderTop: BORDER, display: 'flex',
        gap: narrow ? '8px' : '10px', opacity: '0.8', flexWrap: 'wrap',
        fontSize: narrow ? '11px' : '12px', maxHeight: narrow ? '14vh' : 'none', overflowY: 'auto'
      },
      cardMinHeight: narrow ? '0' : '230px',
      cardDetail: !narrow
    };
  }

  /** 切换后重设每个节点的内联样式，再按新模式重画（卡片内容也要跟着变）。 */
  function applyLayout() {
    if (!els.mask) return;
    var L = dims();
    if (els.mask) els.mask.setAttribute('style', css(L.mask));
    if (els.panel) els.panel.setAttribute('style', css(L.panel));
    if (els.head) els.head.setAttribute('style', css(L.head));
    if (els.input) els.input.setAttribute('style', css(L.input));
    if (els.chips) els.chips.setAttribute('style', css(L.chips));
    if (els.body) els.body.setAttribute('style', css(L.body));
    if (els.grid) els.grid.setAttribute('style', css(L.grid));
    if (els.side) els.side.setAttribute('style', css(L.side));
    if (els.foot) els.foot.setAttribute('style', css(L.foot));
    renderChips();
    renderGrid();
    renderSide(state.active);
  }

  /* ---------------- 悬浮按钮：位置与模式判定 ---------------- */

  // 手机端的发送按钮就在输入框右下角，悬浮按钮压在右下 24px 会正好盖住它。
  // 窄视口挪到右上（顶栏右侧下方，那一带通常是空的），宽屏保持右下 24px 不动。
  function launcherDims() {
    if (isNarrow()) {
      return {
        position: 'fixed', right: '8px', top: '84px', bottom: 'auto',
        // 手机上要够得着：高约 36px，不追迷你
        padding: '8px 12px', fontSize: '12px', lineHeight: '18px', borderRadius: '999px'
      };
    }
    return {
      position: 'fixed', right: '24px', top: 'auto', bottom: '24px',
      padding: '8px 14px', fontSize: '13px', lineHeight: '18px', borderRadius: '999px'
    };
  }

  function launcherStyle(mode) {
    var d = launcherDims();
    d.zIndex = '9999';
    d.background = 'rgba(30,40,70,0.86)';
    d.color = '#e8eefc';
    d.border = '1px solid rgba(140,180,255,0.55)';
    d.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
    d.cursor = 'pointer';
    d.userSelect = 'none';
    d.fontFamily = 'inherit';
    d.whiteSpace = 'nowrap';
    d.opacity = mode === 'other' ? '0.6' : '1';
    return css(d);
  }

  /**
   * 当前会话是不是扮演模式：三态 rp / other / unknown。
   *
   * 旧实现只把 innerText 前 4000 字里有没有「扮演模式」当判据，读不到就按「不是」
   * 处理 —— 新会话（blank，标题栏还没画出 preset）与手机端（同一段文字在更靠后的
   * 位置）都会落进这条分支，于是被误判成普通会话。现在：
   *   1. 客户端插件推来的 window.__RP_CARDS_PRESET__（会话快照里的真值）优先；
   *   2. 页面全文扫，不再截断 4000 字；
   *   3. 什么都没读到时是 unknown —— 按钮照常亮，只换 title，不灰化。
   */
  function detectMode() {
    var pushed = '';
    try {
      if (typeof window.__RP_CARDS_PRESET__ === 'string') pushed = window.__RP_CARDS_PRESET__;
    } catch (e) { pushed = ''; }
    if (pushed) return /roleplay|扮演/i.test(pushed) ? 'rp' : 'other';
    var text = '';
    try {
      text = String((document.body && (document.body.textContent || document.body.innerText)) || '');
    } catch (e) { text = ''; }
    if (/扮演模式|roleplay/i.test(text)) return 'rp';
    // 宿主内置模式的显示名；命中说明确实不在扮演模式
    if (/(标准模式|默认模式|精简模式|编程模式|通用模式)/.test(text)) return 'other';
    return 'unknown';
  }

  function applyLauncherStyle() {
    if (!els.btn) return;
    var mode = detectMode();
    els.btn.setAttribute('style', launcherStyle(mode));
    els.btn.title = mode === 'rp'
      ? '打开角色卡库（当前：扮演模式）'
      : mode === 'other'
        ? '当前不是扮演模式；选定卡后请切到扮演模式再用 rp_card'
        : '打开角色卡库（模式未识别，不影响选卡）';
  }

  // 自检出口：控制台里 __RP_DETECT_MODE__() 能直接看到判定结果（排查误判用）
  try {
    window.__RP_DETECT_MODE__ = detectMode;
  } catch (e) {
    // 非浏览器环境忽略
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    var btn = el('div', launcherStyle('unknown'), '🎴 卡库');
    btn.onclick = open;
    document.body.appendChild(btn);
    els.btn = btn;
    applyLauncherStyle();

    // 4 秒一次、页面不可见时跳过：判定只需要「大致对」，没必要每 1.5 秒给整页求一次 textContent
    setInterval(function () {
      try {
        if (document.hidden) return;
      } catch (e) {
        // 没有 visibilityState 就直接算
      }
      applyLauncherStyle();
    }, 4000);
    try {
      window.addEventListener('resize', applyLauncherStyle);
    } catch (e) {
      // 极简沙箱没有 addEventListener：位置只在挂载时算一次
    }
  }

  /* ---------------- 面板 ---------------- */

  function open() {
    if (els.mask) return;
    var L = dims();
    var mask = el('div', css(L.mask));
    var panel = el('div', css(L.panel));

    /* 头部：搜索 + 关闭（布局切换已删除，只剩这一套） */
    var head = el('div', css(L.head));
    head.appendChild(el('span', css({ fontSize: '15px', fontWeight: '600' }), '选卡'));
    var input = el('input');
    input.setAttribute('style', css(L.input));
    input.placeholder = '搜卡名 / 标签 / 设定里的词，例如「病娇 御姐」「丝袜」';
    input.oninput = function () { state.q = input.value; schedule(); };
    head.appendChild(input);
    var count = el('span', css({ opacity: '0.6' }), '');
    head.appendChild(count);
    var close = el('span', css({ cursor: 'pointer', padding: '4px 10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)' }), '关闭 Esc');
    close.onclick = shutdown;
    head.appendChild(close);
    panel.appendChild(head);

    /* 筛选行 */
    var chipRows = el('div', css(L.chips));
    panel.appendChild(chipRows);

    /* 主体：网格 + 详情（精简模式改成上下叠：上卡片墙、下详情抽屉） */
    var body = el('div', css(L.body));
    var grid = el('div', css(L.grid));
    var side = el('div', css(L.side));
    grid.onscroll = function () {
      // 滚到底自动续页（留 240px 提前量）；没更多 / 正在加载就不重复发请求
      if (!state.more || state.loading) return;
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 240) load(false);
    };
    body.appendChild(grid);
    body.appendChild(side);
    panel.appendChild(body);

    var foot = el('div', css(L.foot));
    panel.appendChild(foot);

    mask.appendChild(panel);
    mask.onclick = function (e) { if (e.target === mask) shutdown(); };
    document.body.appendChild(mask);
    els = {
      // ★btn 必须带上：applyLauncherStyle 靠它刷新判定，漏掉就等于面板开过一次后
      //   按钮的模式状态永久冻结（新会话切过去也不更新）。
      btn: els.btn,
      mask: mask, panel: panel, head: head, body: body,
      grid: grid, side: side, chips: chipRows, foot: foot, count: count, input: input
    };

    document.addEventListener('keydown', onKey);
    renderSide(null);
    fetchMeta();
    schedule();
  }

  function onKey(e) { if (e.key === 'Escape') shutdown(); }

  function shutdown() {
    document.removeEventListener('keydown', onKey);
    if (els.mask && els.mask.parentNode) els.mask.parentNode.removeChild(els.mask);
    els = { btn: els.btn };
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { load(true); }, 220);
  }

  /* ---------------- 数据 ---------------- */

  function fetchMeta() {
    fetch(BASE + '/meta')
      .then(function (r) { return r.json(); })
      .then(function (j) { state.meta = j; renderChips(); })
      .catch(function () { renderChips(); });
  }

  /**
   * 拉一页。reset=true 从头取（换条件）；reset=false 追加下一段（翻页）。
   * 后端 queryRows 早就支持 offset（webui.js:99/124），以前只传 limit=48 且从不传 offset，
   * 于是 11814 张卡永远只能看到前 48 张。
   */
  function load(reset) {
    if (state.loading) return;
    if (!reset && state.items.length >= state.total) return;
    state.loading = true;
    if (reset) {
      state.items = [];
      state.total = 0;
    }
    var p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.l1) p.set('l1', state.l1);
    if (state.l2) p.set('l2', state.l2);
    if (state.rating) p.set('rating', state.rating);
    if (state.tags.length) p.set('tag', state.tags.join(','));
    p.set('limit', String(PAGE));
    p.set('offset', String(reset ? 0 : state.items.length));
    fetch(BASE + '/cards?' + p.toString())
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var got = j.items || [];
        state.items = reset ? got : state.items.concat(got);
        state.total = j.total || 0;
        state.more = state.items.length < state.total;
        state.loading = false;
        renderGrid(j.error);
      })
      .catch(function () {
        if (reset) {
          state.items = [];
          state.total = 0;
        }
        state.more = false;
        state.loading = false;
        renderGrid('后端没响应');
      });
  }

  /* ---------------- 渲染 ---------------- */

  function chip(text, on, onclick) {
    var c = el('span', css({
      padding: '2px 9px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px', lineHeight: '18px',
      whiteSpace: 'nowrap', border: '1px solid ' + (on ? 'rgba(120,180,255,0.75)' : 'rgba(255,255,255,0.18)'),
      background: on ? 'rgba(120,180,255,0.24)' : 'transparent'
    }), text);
    c.onclick = onclick;
    return c;
  }

  // 每组默认只铺 18 个 chip，其余折叠成「…+N」，点开就全部铺开（traits 85 / kink 72 太多）
  var expandedGroups = {};

  function renderChips() {
    if (!els.chips) return;
    els.chips.innerHTML = '';
    var levels = (state.meta && state.meta.levels) || {};

    function strip() {
      // 窄屏每行不折行、横向滑动：七组标签在窄屏折行会吃掉大半屏高度
      var wrap = el('div', css(isNarrow()
        ? { display: 'flex', gap: '6px', flexWrap: 'nowrap', overflowX: 'auto', padding: '0 0 4px', alignItems: 'center' }
        : { display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '0 0 6px', alignItems: 'center' }));
      els.chips.appendChild(wrap);
      return wrap;
    }

    function row(label, items, cur, setter) {
      var wrap = strip();
      wrap.appendChild(el('span', css({ opacity: '0.55', fontSize: '12px', lineHeight: '18px', minWidth: '34px' }), label));
      wrap.appendChild(chip('全部', !cur, function () { setter(''); }));
      items.forEach(function (x) {
        wrap.appendChild(chip(x.label, cur === x.id, function () { setter(cur === x.id ? '' : x.id); }));
      });
    }

    /** 多选标签行：同一组内 AND，跨组也 AND（后端 tag 用 every 实现）。 */
    function tagRow(key, label, items) {
      if (!items || !items.length) return;
      var wrap = strip();
      wrap.appendChild(el('span', css({ opacity: '0.55', fontSize: '12px', lineHeight: '18px', minWidth: '34px' }), label));
      var opened = !!expandedGroups[key];
      var list = opened ? items : items.slice(0, 18);
      list.forEach(function (t) {
        var on = state.tags.indexOf(t) >= 0;
        wrap.appendChild(chip(t, on, function () {
          var i = state.tags.indexOf(t);
          if (i >= 0) state.tags.splice(i, 1);
          else state.tags.push(t);
          renderChips();
          schedule();
        }));
      });
      if (!opened && items.length > 18) {
        wrap.appendChild(chip('…+' + (items.length - 18), false, function () {
          expandedGroups[key] = true;
          renderChips();
        }));
      }
    }

    row('形态', (levels.l1 || []), state.l1, function (v) { state.l1 = v; renderChips(); schedule(); });
    row('分级', [
      { id: 'sfw', label: 'SFW' }, { id: 'light', label: '轻度' },
      { id: 'nsfw', label: 'NSFW' }, { id: 'hard', label: '重口' }
    ], state.rating, function (v) { state.rating = v; renderChips(); schedule(); });
    row('题材', (levels.l2 || []), state.l2, function (v) { state.l2 = v; renderChips(); schedule(); });

    // 六组细分标签（后端 queryRows 的 tag 参数一直支持，只是 meta 以前没吐）
    tagRow('body', '身体', levels.body || [])
    tagRow('persona', '性格', levels.persona || [])
    tagRow('role', '身份', levels.role || [])
    tagRow('traits', '属性', levels.traits || [])
    tagRow('relation', '关系', levels.relation || [])
    tagRow('kink', '玩法', levels.kink || [])
    tagRow('scene', '场景', levels.scene || [])

    if (state.tags.length) {
      var bar = strip();
      bar.appendChild(el('span', css({ fontSize: '12px', opacity: '0.85' }), '已选 ' + state.tags.length + ' 项：' + state.tags.join('、')));
      bar.appendChild(chip('清空', false, function () {
        state.tags = [];
        renderChips();
        schedule();
      }));
    }
  }

  function renderGrid(error) {
    if (!els.grid) return;
    els.grid.innerHTML = '';
    if (els.count) els.count.textContent = state.meta && state.meta.counts ? state.meta.counts.cards + ' 张卡' : '';
    if (els.foot) {
      els.foot.textContent = '';
      els.foot.appendChild(el('span', null, '命中 ' + state.total + ' 张，已显示 ' + state.items.length + ' 张'));
      if (state.more) {
        var moreBtn = el('span', css({
          cursor: 'pointer', padding: '2px 10px', borderRadius: '8px', fontSize: '12px',
          background: 'rgba(120,180,255,0.22)', border: '1px solid rgba(120,180,255,0.5)'
        }), state.loading ? '加载中…' : '加载更多（+' + Math.min(PAGE, state.total - state.items.length) + '）');
        moreBtn.onclick = function () { load(false); };
        els.foot.appendChild(moreBtn);
      }
      if (state.meta && state.meta.lock) {
        var lockCards = state.meta.lock.cards || [];
        var lockNames = lockCards.map(function (c) { return '《' + c.name + '》'; }).join('');
        var lockTip = el('span', css({ padding: '0 8px', borderRadius: '6px', background: 'rgba(120,180,255,0.22)' }),
          '本局卡组 ' + lockCards.length + ' 位：' + lockNames);
        els.foot.appendChild(lockTip);
      }
      els.foot.appendChild(el('span', css({ marginLeft: 'auto', opacity: '0.55' }), '选定后本会话锁定，换角色要新建会话'));
    }
    if (!state.items.length) {
      els.grid.appendChild(el('div', css({ opacity: '0.6', padding: '20px' }), state.loading ? '搜索中…' : (error || '没有匹配的卡，换个词试试')));
      return;
    }
    state.items.forEach(function (item) {
      var card = el('div', css({
        borderRadius: '10px', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        background: 'rgba(255,255,255,0.05)', cursor: 'pointer', minHeight: compact ? '0' : '230px',
        border: '1px solid ' + (state.active && state.active.id === item.id ? 'rgba(120,180,255,0.85)' : 'rgba(255,255,255,0.10)')
      }));
      var hasCover = !!(item.thumb || item.cover);
      if (hasCover) {
        var wrap = el('div', css({ position: 'relative', lineHeight: '0' }));
        var img = el('img');
        img.src = item.thumb || item.cover;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.setAttribute('style', css({ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', display: 'block', background: 'rgba(255,255,255,0.05)' }));
        wrap.appendChild(img);
        var nameOverlay = el('div', css({
          position: 'absolute', left: '0', right: '0', bottom: '0', padding: '26px 8px 7px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.88) 20%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0))',
          fontSize: '12.5px', fontWeight: '600', lineHeight: '16px', color: '#fff',
          textShadow: '0 1px 3px rgba(0,0,0,0.9)', display: '-webkit-box', WebkitLineClamp: '2',
          WebkitBoxOrient: 'vertical', overflow: 'hidden'
        }), item.name || '（无名）');
        nameOverlay.title = item.name || '';
        wrap.appendChild(nameOverlay);
        card.appendChild(wrap);
      } else {
        card.appendChild(el('div', css({ width: '100%', aspectRatio: '3 / 4', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: '0.3', fontSize: '22px' }), '无图'));
      }
      // 精简模式：卡片只留封面 + 名字叠加 + 分级徽章，其余信息进下方详情抽屉
      var info = el('div', css({
        padding: compact ? '3px 4px 4px' : '8px 9px 10px',
        display: 'flex', flexDirection: 'column', gap: compact ? '2px' : '4px'
      }));
      if (!hasCover) {
        info.appendChild(el('div', css({ fontSize: compact ? '11px' : '13px', fontWeight: '600', lineHeight: '15px', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' }), item.name || '（无名）'));
      }
      if (!compact) {
        info.appendChild(el('div', css({ fontSize: '11px', opacity: '0.72' }), [L1_LABEL[item.l1] || item.l1, (item.l2 || []).slice(0, 2)].join(' · ')));
        info.appendChild(el('div', css({ fontSize: '11px', opacity: '0.62' }), (item.traits || []).slice(0, 3).join(' ')));
      }
      var badges = el('div', css({ display: 'flex', gap: compact ? '4px' : '6px', fontSize: compact ? '10px' : '11px', opacity: '0.78', flexWrap: 'wrap' }));
      var rb = el('span', css({ padding: '0 6px', borderRadius: '5px', background: RATING_BG[item.rating] || 'rgba(255,255,255,0.1)' }), RATING_LABEL[item.rating] || item.rating || '-');
      badges.appendChild(rb);
      badges.appendChild(el('span', null, (item.words || 0) + '字'));
      if (item.book) badges.appendChild(el('span', null, '世界书' + item.book));
      info.appendChild(badges);
      if (item.preview && !compact) {
        info.appendChild(el('div', css({ fontSize: '11px', opacity: '0.5', lineHeight: '15px', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' }), item.preview));
      }
      card.appendChild(info);
      card.onclick = function () {
        state.active = item;
        renderGrid(error);
        renderSide(item);
      };
      els.grid.appendChild(card);
    });
  }

  function renderSide(item) {
    if (!els.side) return;
    els.side.innerHTML = '';
    els.side.setAttribute('style', css(dims().side));
    if (!item) {
      els.side.appendChild(el('div', css({ opacity: '0.6', fontSize: isNarrow() ? '12px' : '13px' }),
        isNarrow() ? '点一张卡看详情；详情在下方抽屉，点标题可收起' : '左边点一张卡看详情。顶部搜索框输入关键词，或点标签筛选。'));
      return;
    }
    if (isNarrow()) {
      // 抽屉把手：收起后只剩这一条，把高度全留给卡片墙
      var isOpen = state.sideOpen !== false;
      var handle = el('div', css({
        display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', flexShrink: '0',
        fontSize: '12px', lineHeight: '18px', padding: '2px 2px 4px', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis'
      }), (isOpen ? '▾ 详情 · ' : '▸ 详情 · ') + (item.name || '（无名）'));
      handle.onclick = function () {
        state.sideOpen = !isOpen;
        els.side.setAttribute('style', css(dims().side));
        renderSide(state.active);
      };
      els.side.appendChild(handle);
      if (!isOpen) return;
    }
    els.side.appendChild(el('div', css({ fontSize: '15px', fontWeight: '600', lineHeight: '20px' }), item.name));
    var actions = el('div', css({ display: 'flex', gap: '8px' }));
    var use = el('span', css({ padding: '7px 12px', borderRadius: '8px', cursor: 'pointer', border: '1px solid rgba(120,180,255,0.7)', background: 'rgba(120,180,255,0.26)' }), '填入输入框');
    var copy = el('span', css({ padding: '7px 12px', borderRadius: '8px', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.2)' }), '复制指令');
    var cmd = 'rp_card(action=pick, name="' + (item.name || '') + '")';
    use.onclick = function () {
      var ok = insertToComposer(cmd);
      copyText(cmd);
      var tip = els.foot && els.foot.children[0];
      if (tip) tip.textContent = ok ? '指令已填进输入框，回车即锁定' : '已复制指令，手动粘贴到输入框';
    };
    copy.onclick = function () {
      copyText(cmd);
      var tip = els.foot && els.foot.children[0];
      if (tip) tip.textContent = '指令已复制';
    };
    actions.appendChild(use);
    actions.appendChild(copy);
    els.side.appendChild(actions);

    var rows = [
      ['形态', L1_LABEL[item.l1] || item.l1],
      ['题材', (item.l2 || []).join(' / ') || '—'],
      ['身体', (item.body || []).join(' / ') || '—'],
      ['性格', (item.persona || []).join(' / ') || '—'],
      ['身份', (item.role || []).join(' / ') || '—'],
      ['场景', (item.scene || []).join(' / ') || '—'],
      ['标签', (item.traits || []).join(' / ') || '—'],
      ['关系', (item.relation || []).join(' / ') || '—'],
      ['玩法', (item.kink || []).join(' / ') || '—'],
      ['体量', (item.words || 0) + ' 字 · ' + (item.size_class || '') + (item.book ? ' · 世界书 ' + item.book + ' 条' : '')],
      ['分级', RATING_LABEL[item.rating] || item.rating || '—'],
      ['路径', item.rel]
    ];
    rows.forEach(function (r) {
      var line = el('div', css({ display: 'flex', gap: '8px', fontSize: '12px', lineHeight: '17px' }));
      line.appendChild(el('span', css({ opacity: '0.55', minWidth: '34px' }), r[0]));
      line.appendChild(el('span', css({ opacity: '0.92', wordBreak: 'break-all' }), String(r[1] || '—')));
      els.side.appendChild(line);
    });
    if (item.preview) {
      els.side.appendChild(el('div', css({ fontSize: '12px', lineHeight: '18px', opacity: '0.72', whiteSpace: 'pre-wrap' }), item.preview));
    }
  }

  /* ---------------- 写回输入框 ---------------- */

  function insertToComposer(text) {
    try {
      var host = document.querySelector('[data-composer-card]') || document;
      var elx = host.querySelector('textarea') || host.querySelector('[contenteditable="true"]');
      if (!elx) return false;
      elx.focus();
      if (elx.tagName === 'TEXTAREA') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(elx, text);
        elx.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(elx);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallthrough */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) {
      return false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
