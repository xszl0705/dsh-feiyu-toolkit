/* dsh-rp-mode · 卡库面板（浏览器半侧，手写 bundle，无构建）
 * 契约：window.__ModuleLoader__.load({ id, factory(require) })；factory 返回 { apply, inject }。
 * 只依赖基座里的 react。
 *
 * 位置：shell.overlay 浮层，右下角一个「卡库」按钮；点开是全屏选卡面板。
 * 数据：/dsh-rp-mode/meta（标签体系）、/dsh-rp-mode/cards（搜索）、/dsh-rp-mode/cover（封面图）。
 * 选定：把 rp_card(action=pick, name=…) 填进输入框 —— 锁定由工具层的会话锁执行，面板不直接改状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rp-mode',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/dsh-rp-mode'
    const PAGE = 36

    const L1_LABEL = { system: '系统', cast: '群像', scenario: '场景', character: '单角色' }
    const RATING_LABEL = { sfw: 'SFW', light: '轻度', nsfw: 'NSFW', hard: '重口' }
    const RATING_COLOR = {
      sfw: 'rgba(120,190,120,0.25)',
      light: 'rgba(210,180,90,0.25)',
      nsfw: 'rgba(220,120,120,0.28)',
      hard: 'rgba(200,80,80,0.38)',
    }

    /**
     * 悬浮按钮位置：手机端发送按钮在输入框右下角，压右下 24px 会挡住它 →
     * 窄视口挪到右上（顶栏右侧下方），宽屏仍走右下 24px。
     * 每次渲染重算，窗口 resize 由 Launcher 的 resize 监听触发重渲。
     */
    const launcherStyle = () => {
      let narrow = false
      try {
        narrow =
          (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches) ||
          Number(window.innerWidth) < 760
      } catch {
        narrow = false
      }
      return {
        position: 'fixed',
        right: narrow ? '8px' : '24px',
        top: narrow ? '84px' : 'auto',
        bottom: narrow ? 'auto' : '24px',
        zIndex: 30,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: narrow ? '8px 12px' : '6px 12px',
        borderRadius: '999px',
        fontSize: '12px',
        lineHeight: '16px',
        color: 'inherit',
        background: 'rgba(127,127,127,0.18)',
        border: '1px solid rgba(127,127,127,0.28)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.14)',
        cursor: 'pointer',
        userSelect: 'none',
      }
    }

    const css = {
      mask: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3vh 3vw',
      },
      panel: {
        width: 'min(1180px, 94vw)',
        height: 'min(760px, 90vh)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '14px',
        background: 'rgba(24,24,28,0.96)',
        color: '#e8e8ea',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        fontSize: '13px',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.09)',
        flexWrap: 'wrap',
      },
      input: {
        flex: '1 1 260px',
        minWidth: '180px',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(255,255,255,0.06)',
        color: 'inherit',
        outline: 'none',
        fontSize: '13px',
      },
      chipRow: {
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '8px 14px 0',
      },
      chip: (on) => ({
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid ' + (on ? 'rgba(120,180,255,0.7)' : 'rgba(255,255,255,0.16)'),
        background: on ? 'rgba(120,180,255,0.22)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      }),
      body: {
        flex: 1,
        display: 'flex',
        minHeight: 0,
      },
      grid: {
        flex: 1,
        overflowY: 'auto',
        padding: '12px 14px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))',
        gap: '12px',
        alignContent: 'start',
      },
      card: (on) => ({
        borderRadius: '10px',
        overflow: 'hidden',
        background: 'rgba(255,255,255,0.045)',
        border: '1px solid ' + (on ? 'rgba(120,180,255,0.8)' : 'rgba(255,255,255,0.1)'),
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        minHeight: '230px',
      }),
      cover: {
        width: '100%',
        aspectRatio: '3 / 4',
        objectFit: 'cover',
        background: 'rgba(255,255,255,0.05)',
        display: 'block',
      },
      coverPh: {
        width: '100%',
        aspectRatio: '3 / 4',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '22px',
        opacity: 0.28,
        background: 'rgba(255,255,255,0.05)',
      },
      cardBody: { padding: '8px 9px 10px', display: 'flex', flexDirection: 'column', gap: '4px' },
      name: {
        fontSize: '13px',
        fontWeight: 600,
        lineHeight: '17px',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      tagLine: { fontSize: '11px', opacity: 0.72, lineHeight: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      preview: {
        fontSize: '11px',
        opacity: 0.58,
        lineHeight: '15px',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      side: {
        width: '320px',
        borderLeft: '1px solid rgba(255,255,255,0.09)',
        padding: '14px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        flexShrink: 0,
      },
      btn: (primary) => ({
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid ' + (primary ? 'rgba(120,180,255,0.7)' : 'rgba(255,255,255,0.18)'),
        background: primary ? 'rgba(120,180,255,0.26)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      }),
      foot: {
        padding: '8px 14px',
        borderTop: '1px solid rgba(255,255,255,0.09)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        fontSize: '12px',
        opacity: 0.8,
      },
      /** 左上角的「宽屏 / 精简」切换按钮（精简模式的覆盖版在 layoutOf 里）。 */
      toggle: {
        flexShrink: 0,
        cursor: 'pointer',
        padding: '4px 9px',
        borderRadius: '8px',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        border: '1px solid rgba(255,255,255,0.24)',
        background: 'rgba(120,180,255,0.16)',
      },
      kv: { display: 'flex', gap: '6px', fontSize: '11px', opacity: 0.75, flexWrap: 'wrap' },
      badge: (bg) => ({
        padding: '0 6px',
        borderRadius: '5px',
        background: bg,
        fontSize: '11px',
        lineHeight: '17px',
      }),
    }

    /* ---------------- 布局：宽屏 / 精简 ----------------
     * 手机端「显示不全」的根因是纵向被吃掉：三排筛选在窄屏折成十几行，
     * 右侧 320px 详情栏又把横向吃光。精简模式于是：筛选行横滑、网格列宽 104px、
     * 详情改为下方抽屉、卡片只留封面与名字。
     * 不做设备识别：左上角一个按钮手动切，选择记在 localStorage（与注入版 panel.js 共用同一个键）。
     */

    const LAYOUT_KEY = 'dsh-rp-mode.layout'

    function readCompact() {
      try {
        const saved = window.localStorage.getItem(LAYOUT_KEY)
        if (saved === 'compact') return true
        if (saved === 'wide') return false
      } catch {
        // 无 storage：走初值推断
      }
      // 没手动切过：窄视口默认精简（手机竖屏进宽屏会让筛选区顶穿面板、网格看不见）。
      // 点过切换按钮后一律以 localStorage 为准，不跟随视口自动变。
      try {
        return window.innerWidth < 760
      } catch {
        return false
      }
    }

    function writeCompact(compact) {
      try {
        window.localStorage.setItem(LAYOUT_KEY, compact ? 'compact' : 'wide')
      } catch {
        // 隐私模式 / 无 storage 时忽略，仅影响"下次还记得"
      }
    }

    /** 宽屏就用 base 那套；精简只覆盖跟窄屏有关的键，其余沿用。 */
    function layoutOf(compact) {
      if (!compact) return css
      return {
        ...css,
        mask: { ...css.mask, padding: '0', alignItems: 'stretch' },
        panel: { ...css.panel, width: '100%', height: '100%', borderRadius: '0', fontSize: '12px' },
        head: { ...css.head, padding: '6px 8px', gap: '6px' },
        input: { ...css.input, flex: '1 1 100%', minWidth: '0', fontSize: '12px', padding: '6px 8px' },
        chipRow: { ...css.chipRow, flexWrap: 'nowrap', overflowX: 'auto', padding: '4px 8px 0' },
        body: { ...css.body, flexDirection: 'column' },
        grid: {
          ...css.grid,
          padding: '6px',
          gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
          gap: '6px',
        },
        card: (on) => ({ ...css.card(on), minHeight: '0' }),
        side: {
          ...css.side,
          width: '100%',
          height: '34vh',
          flexShrink: 0,
          borderLeft: 'none',
          borderTop: '1px solid rgba(255,255,255,0.09)',
          padding: '6px 8px',
          gap: '6px',
        },
        foot: { ...css.foot, padding: '6px 8px', fontSize: '11px', flexWrap: 'wrap' },
        toggle: {
          flexShrink: 0,
          cursor: 'pointer',
          padding: '5px 8px',
          borderRadius: '8px',
          fontSize: '12px',
          lineHeight: '16px',
          whiteSpace: 'nowrap',
          border: '1px solid rgba(120,180,255,0.55)',
          background: 'rgba(120,180,255,0.22)',
        },
      }
    }

    /** 把 pick 指令送进输入框（找不到输入框就只复制）。 */
    function insertToComposer(text) {
      try {
        const host = document.querySelector('[data-composer-card]') || document
        const el = host.querySelector('textarea') || host.querySelector('[contenteditable="true"]')
        if (!el) return false
        el.focus()
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(el, text)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          const sel = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(el)
          sel.removeAllRanges()
          sel.addRange(range)
          document.execCommand('insertText', false, text)
        }
        return true
      } catch {
        return false
      }
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // 落回下面的 execCommand
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        return true
      } catch {
        return false
      }
    }

    function CardItem({ item, active, onPick, compact }) {
      const C = layoutOf(compact)
      return h(
        'div',
        { style: C.card(active), onClick: () => onPick(item), title: item.name },
        item.cover
          ? h('img', { src: item.thumb || item.cover, style: C.cover, loading: 'lazy', decoding: 'async', alt: '' })
          : h('div', { style: C.coverPh }, '无图'),
        h(
          'div',
          { style: compact ? { ...C.cardBody, padding: '4px 5px 5px', gap: '2px' } : C.cardBody },
          h(
            'div',
            { style: compact ? { ...C.name, fontSize: '11px', lineHeight: '14px', WebkitLineClamp: 2 } : C.name },
            item.name || '（无名）',
          ),
          compact
            ? null
            : h('div', { style: C.tagLine }, [L1_LABEL[item.l1] || item.l1, ...(item.l2 || []).slice(0, 2)].join(' · ')),
          compact
            ? null
            : h('div', { style: C.tagLine }, [...(item.traits || []).slice(0, 3), ...(item.kink || []).slice(0, 1)].join(' ')),
          h(
            'div',
            { style: compact ? { ...C.kv, fontSize: '10px', gap: '4px' } : C.kv },
            h('span', { style: C.badge(RATING_COLOR[item.rating] || 'rgba(255,255,255,0.1)') }, RATING_LABEL[item.rating] || item.rating || '-'),
            compact ? null : h('span', null, (item.words || 0) + '字'),
            !compact && item.book ? h('span', null, '世界书' + item.book) : null,
          ),
          !compact && item.preview ? h('div', { style: C.preview }, item.preview) : null,
        ),
      )
    }

    function Detail({ item, onUse, onCopy, copied, compact }) {
      const C = layoutOf(compact)
      if (!item) {
        return h(
          'div',
          { style: { ...C.side, opacity: 0.6 } },
          compact ? '点一张卡看详情；详情在下方抽屉。' : '左边点一张卡看详情。左上搜索框输入关键词，或点下面的标签筛选。',
        )
      }
      const rows = [
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
        ['路径', item.rel],
      ]
      return h(
        'div',
        { style: C.side },
        item.cover ? h('img', { src: item.cover, style: { width: '100%', borderRadius: '8px', display: 'block' }, loading: 'lazy', decoding: 'async', alt: '' }) : null,
        h('div', { style: { fontSize: '15px', fontWeight: 600, lineHeight: '20px' } }, item.name),
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h('button', { style: css.btn(true), onClick: () => onUse(item) }, '填入输入框'),
          h('button', { style: css.btn(false), onClick: () => onCopy(item) }, copied ? '已复制' : '复制指令'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
          rows.map(([k, v]) =>
            h(
              'div',
              { key: k, style: { fontSize: '12px', lineHeight: '17px', display: 'flex', gap: '8px' } },
              h('span', { style: { opacity: 0.55, minWidth: '34px' } }, k),
              h('span', { style: { opacity: 0.9, wordBreak: 'break-all' } }, String(v || '—')),
            ),
          ),
        ),
        item.preview ? h('div', { style: { fontSize: '12px', lineHeight: '18px', opacity: 0.72, whiteSpace: 'pre-wrap' } }, item.preview) : null,
      )
    }

    function Panel({ onClose, sessionId }) {
      // 精简布局已删除（2026-11-09），只剩桌面宽屏版式；compact 恒假。
      const compact = false
      const L = layoutOf(compact)
      const [meta, setMeta] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [l1, setL1] = React.useState('')
      const [l2, setL2] = React.useState('')
      const [rating, setRating] = React.useState('')
      const [data, setData] = React.useState({ total: 0, items: [] })
      const [loading, setLoading] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [toast, setToast] = React.useState('')
      const timer = React.useRef(null)

      React.useEffect(() => {
        fetch(ROUTE + '/meta' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''))
          .then((r) => r.json())
          .then((j) => setMeta(j))
          .catch(() => setMeta({ ok: false }))
      }, [sessionId])

      const load = React.useCallback(() => {
        setLoading(true)
        const params = new URLSearchParams()
        if (q.trim()) params.set('q', q.trim())
        if (l1) params.set('l1', l1)
        if (l2) params.set('l2', l2)
        if (rating) params.set('rating', rating)
        params.set('limit', String(PAGE))
        fetch(ROUTE + '/cards?' + params.toString())
          .then((r) => r.json())
          .then((j) => setData({ total: j.total || 0, items: j.items || [], error: j.error }))
          .catch(() => setData({ total: 0, items: [], error: '后端没响应' }))
          .finally(() => setLoading(false))
      }, [q, l1, l2, rating])

      React.useEffect(() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(load, 220)
        return () => timer.current && clearTimeout(timer.current)
      }, [load])

      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const useCard = (item) => {
        const cmd = 'rp_card(action=pick, name="' + (item.name || '') + '")'
        const ok = insertToComposer(cmd)
        copyText(cmd)
        setToast(ok ? '指令已填进输入框，按回车就锁定这张卡' : '已复制指令（没找到输入框，手动粘贴）')
        setTimeout(() => setToast(''), 3200)
      }
      const copyCard = (item) => {
        copyText('rp_card(action=pick, name="' + (item.name || '') + '")')
        setToast('指令已复制')
        setTimeout(() => setToast(''), 2000)
      }

      const l1s = (meta && meta.levels && meta.levels.l1) || Object.keys(L1_LABEL).map((id) => ({ id, label: L1_LABEL[id] }))
      const l2s = (meta && meta.levels && meta.levels.l2) || []
      const counts = (meta && meta.counts) || {}

      return h(
        'div',
        { style: L.mask, onClick: (e) => e.target === e.currentTarget && onClose() },
        h(
          'div',
          { style: L.panel },
          h(
            'div',
            { style: L.head },
            h('span', { style: { fontSize: '15px', fontWeight: 600 } }, '选卡'),
            h('input', {
              style: L.input,
              placeholder: compact ? '搜卡名 / 标签' : '搜卡名 / 标签 / 设定里的词，例如「病娇 御姐」「丝袜」「吸血鬼」',
              value: q,
              autoFocus: true,
              onChange: (e) => setQ(e.target.value),
            }),
            h('span', { style: { opacity: 0.55, fontSize: '12px' } }, counts.cards ? counts.cards + ' 张卡' : ''),
            h('button', { style: L.btn(false), onClick: onClose }, '关闭 Esc'),
          ),
          h(
            'div',
            { style: L.chipRow },
            h('span', { style: { opacity: 0.5, fontSize: '12px', lineHeight: '18px' } }, '形态'),
            h('span', { style: L.chip(!l1), onClick: () => setL1('') }, '全部'),
            ...l1s.map((x) => h('span', { key: x.id, style: L.chip(l1 === x.id), onClick: () => setL1(l1 === x.id ? '' : x.id) }, x.label)),
          ),
          h(
            'div',
            { style: L.chipRow },
            h('span', { style: { opacity: 0.5, fontSize: '12px', lineHeight: '18px' } }, '分级'),
            h('span', { style: L.chip(!rating), onClick: () => setRating('') }, '全部'),
            ...['sfw', 'light', 'nsfw', 'hard'].map((r) =>
              h('span', { key: r, style: L.chip(rating === r), onClick: () => setRating(rating === r ? '' : r) }, RATING_LABEL[r]),
            ),
          ),
          h(
            'div',
            { style: L.chipRow },
            h('span', { style: { opacity: 0.5, fontSize: '12px', lineHeight: '18px' } }, '题材'),
            h('span', { style: L.chip(!l2), onClick: () => setL2('') }, '全部'),
            ...l2s.map((x) => h('span', { key: x.id, style: L.chip(l2 === x.id), onClick: () => setL2(l2 === x.id ? '' : x.id) }, x.label)),
          ),
          h(
            'div',
            { style: L.body },
            h(
              'div',
              { style: L.grid },
              data.items.length
                ? data.items.map((item) =>
                    h(CardItem, { key: item.id, item, active: active && active.id === item.id, onPick: setActive, compact }),
                  )
                : h(
                    'div',
                    { style: { opacity: 0.6, padding: compact ? '12px' : '20px' } },
                    loading ? '搜索中…' : data.error || '没有匹配的卡，换个词试试',
                  ),
            ),
            h(Detail, { item: active, onUse: useCard, onCopy: copyCard, copied: false, compact }),
          ),
          h(
            'div',
            { style: L.foot },
            h('span', null, '命中 ' + data.total + ' 张，显示 ' + data.items.length + ' 张'),
            toast ? h('span', { style: { color: 'rgba(150,210,150,0.95)' } }, toast) : null,
            compact
              ? null
              : h('span', { style: { marginLeft: 'auto', opacity: 0.55 } }, '选定后本会话锁定，换角色要新建会话'),
          ),
        ),
      )
    }

    /**
     * 读当前会话用的 agent preset。判据取自宿主：session.projectionValues.agentPreset
     * （见 dsh-client-ui-agent-preset/lib/client.js 的 presetOf）。
     * 读不到就返回空串 —— 此时按「不确定」处理，按钮照常显示，宁可多显示也不要白做。
     */
    function presetOfSession(ctx) {
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return ''
        const snap = sessions.list.getSnapshot()
        if (!snap || !snap.byId) return ''
        const id = String(snap.current || '')
        // 只信 current：新会话刚建时 byId 里可能还没有它，退回「最后一个会话」
        // 会读到上一个会话的 preset —— 这是新会话被误判成普通/扮演会话的根因。
        const row = id && snap.byId[id] ? snap.byId[id] : null
        if (!row) return ''
        const direct = row.projectionValues && row.projectionValues.agentPreset
        if (typeof direct === 'string' && direct) return direct
        const alt = row.agentPreset || row.preset
        return typeof alt === 'string' ? alt : ''
      } catch {
        return ''
      }
    }

    /** 当前会话 id（与 preset 判定同一个快照）。 */
    function sessionIdOf(ctx) {
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return ''
        const snap = sessions.list.getSnapshot()
        if (!snap || !snap.byId) return ''
        const id = String(snap.current || '')
        // 与 presetOfSession 同理：拿不到 current 就别拿别人的会话去查锁
        return id && snap.byId[id] ? id : ''
      } catch {
        return ''
      }
    }

    function Launcher(props) {
      const [open, setOpen] = React.useState(false)
      const [preset, setPreset] = React.useState('')
      const [ready, setReady] = React.useState(false)
      const [, bump] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (!alive) return
          const value = props.readPreset()
          setPreset(value)
          // 注入版 panel.js 读不到会话快照，把真值推给它（它优先用这个值判模式）
          try {
            if (value) window.__RP_CARDS_PRESET__ = value
          } catch {
            // 非浏览器环境没有 window，忽略
          }
          setReady(true)
        }
        const onResize = () => bump((n) => n + 1)
        tick()
        const timer = setInterval(tick, 1500)
        try {
          window.addEventListener('resize', onResize)
        } catch {
          // 无 addEventListener：位置只在渲染时算一次
        }
        return () => {
          alive = false
          clearInterval(timer)
          try {
            window.removeEventListener('resize', onResize)
          } catch {
            // 同上
          }
        }
      }, [])

      // 注入版 panel.js 已经在跑就不重复渲染（两条通道只留一个按钮）
      if (typeof window !== 'undefined' && window.__RP_CARDS_PANEL__) return null
      // 没判断出来之前不渲染，避免普通会话闪一下按钮
      if (!ready) return null
      // preset 的实际取值可能是 roleplay / preset-roleplay / 扮演模式，统一按包含关系判
      const isRoleplay = (p) => !p || /roleplay|扮演/i.test(String(p))
      // 诊断期：先一律显示，按钮文字带上读到的 preset 值；确认加载正常后再恢复门控
      // 读不到 preset（新会话 / 快照未就绪）时不当成「别的模式」，也不打角标
      const badge = !preset || isRoleplay(preset) ? '' : '·' + String(preset).slice(0, 8)

      return h(
        'div',
        { style: { display: 'contents' } },
        h('div', { style: launcherStyle(), onClick: () => setOpen(true), title: '打开角色卡库（含标签与简介）·当前模式 ' + (preset || '未识别') }, '🎴 卡库' + badge),
        open ? h(Panel, { onClose: () => setOpen(false), sessionId: props.readSession() }) : null,
      )
    }

    return {
      apply(ctx) {
        const readPreset = () => presetOfSession(ctx)
        const readSession = () => sessionIdOf(ctx)
        return ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'rp-cards', order: 65 }, () => h(Launcher, { readPreset, readSession })),
        )
      },
      inject: ['slots'],
    }
  },
})
