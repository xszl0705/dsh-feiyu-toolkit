// dsh-pet-hub —— 浏览器半端：一张卡片装下「心情 / 朗读 / 桌宠」，并隐藏原来那两块浮层
;(function () {
  if (window.__dshPetHubLoaded) return
  window.__dshPetHubLoaded = true

  var CARD_ID = 'dsh-pet-hub-card'
  var HIDE_MARKERS = ['还没念过', '看完整记录', '待命（有新消息就念）', '朗读桥', '开心']
  var LAST_TTS = null
  var LAST_PET = null
  var LAST_MOOD = null

  function el(tag, style, text) {
    var node = document.createElement(tag)
    if (style) node.setAttribute('style', style)
    if (text != null) node.textContent = text
    return node
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ cache: 'no-store' }, opts || {})).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  function moodLabel(v) {
    if (v == null) return '未知'
    if (v >= 80) return '开心'
    if (v >= 60) return '平稳'
    if (v >= 40) return '一般'
    if (v >= 20) return '低落'
    return '很难过'
  }

  function ttsText(t) {
    if (!t) return '连不上插件'
    if (!t.everSeen) return '扩展未连接'
    if (t.playing) return '正在念'
    if (t.waiting > 0) return '排队 ' + t.waiting + ' 条'
    return t.auto ? '待命（有新消息就念）' : '待命（自动关着）'
  }

  function buildCard() {
    var old = document.getElementById(CARD_ID)
    if (old) old.remove()

    var card = el(
      'div',
      [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'width:286px',
        'z-index:2147483000',
        'background:rgba(18,26,40,.92)',
        'border:1px solid rgba(120,170,230,.35)',
        'border-radius:14px',
        'box-shadow:0 10px 30px rgba(0,0,0,.35)',
        'color:#e8f2ff',
        'font:12px/1.5 "Microsoft YaHei UI","Segoe UI",sans-serif',
        'padding:10px 12px 9px',
        'backdrop-filter:blur(8px)',
        'user-select:none',
      ].join(';'),
    )
    card.id = CARD_ID
    card.dataset.petHub = '1'

    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;')
    var dot = el('span', 'width:8px;height:8px;border-radius:50%;background:#59d98a;flex:0 0 auto;')
    dot.id = 'hub-dot'
    var title = el('div', 'flex:1;font-weight:600;font-size:12.5px;', '大肥鱼 · 中枢')
    var collapse = el(
      'button',
      'background:none;border:none;color:#8fb0d0;cursor:pointer;font-size:13px;padding:0 2px;',
      '—',
    )
    collapse.title = '收起 / 展开'
    head.appendChild(dot)
    head.appendChild(title)
    head.appendChild(collapse)

    var body = el('div', '')
    body.id = 'hub-body'

    // 桌宠
    var petRow = el('div', 'display:flex;align-items:center;gap:6px;margin:5px 0;')
    petRow.appendChild(el('span', 'color:#8fb0d0;width:30px;flex:0 0 auto;', '桌宠'))
    var petText = el('span', 'flex:1;', '—')
    petText.id = 'hub-pet-text'
    var formPet = el('button', '', '桌宠')
    var formWidget = el('button', '', '挂件')
    var power = el('button', '', '起')
    ;[formPet, formWidget, power].forEach(function (b) {
      b.setAttribute(
        'style',
        'cursor:pointer;border-radius:8px;border:1px solid rgba(120,170,230,.35);background:rgba(40,60,90,.7);color:#dbe9ff;font:11px/1 "Microsoft YaHei UI",sans-serif;padding:4px 7px;',
      )
    })
    petRow.appendChild(petText)
    petRow.appendChild(formPet)
    petRow.appendChild(formWidget)
    petRow.appendChild(power)

    // 心情
    var moodRow = el('div', 'display:flex;align-items:center;gap:6px;margin:5px 0;')
    moodRow.appendChild(el('span', 'color:#8fb0d0;width:30px;flex:0 0 auto;', '心情'))
    var moodText = el('span', 'flex:1;', '—')
    moodText.id = 'hub-mood-text'
    moodRow.appendChild(moodText)

    // 朗读
    var ttsRow = el('div', 'display:flex;align-items:center;gap:6px;margin:5px 0 2px;')
    ttsRow.appendChild(el('span', 'color:#8fb0d0;width:30px;flex:0 0 auto;', '朗读'))
    var ttsTextEl = el('span', 'flex:1;', '—')
    ttsTextEl.id = 'hub-tts-text'
    var autoBtn = el('button', '', '自动')
    var stopBtn = el('button', '', '停')
    ;[autoBtn, stopBtn].forEach(function (b) {
      b.setAttribute(
        'style',
        'cursor:pointer;border-radius:8px;border:1px solid rgba(120,170,230,.35);background:rgba(40,60,90,.7);color:#dbe9ff;font:11px/1 "Microsoft YaHei UI",sans-serif;padding:4px 7px;',
      )
    })
    ttsRow.appendChild(ttsTextEl)
    ttsRow.appendChild(autoBtn)
    ttsRow.appendChild(stopBtn)

    body.appendChild(petRow)
    body.appendChild(moodRow)
    body.appendChild(ttsRow)
    card.appendChild(head)
    card.appendChild(body)

    collapse.onclick = function () {
      body.style.display = body.style.display === 'none' ? '' : 'none'
      collapse.textContent = body.style.display === 'none' ? '+' : '—'
    }

    function petAction(bodyObj) {
      return api('/dsh-pet-hub/pet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyObj),
      })
    }

    formPet.onclick = function () {
      petAction({ action: 'form', form: 'pet' }).catch(function () {})
    }
    formWidget.onclick = function () {
      petAction({ action: 'form', form: 'widget' }).catch(function () {})
    }
    power.onclick = function () {
      var running = LAST_PET && LAST_PET.running
      petAction({ action: running ? 'stop' : 'start' }).catch(function () {})
    }
    autoBtn.onclick = function () {
      var auto = !(LAST_TTS && LAST_TTS.auto)
      api('/dsh-tts-bridge/auto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto: auto }),
      }).catch(function () {})
    }
    stopBtn.onclick = function () {
      api('/dsh-tts-bridge/stop', { method: 'POST' }).catch(function () {})
    }

    document.body.appendChild(card)
    return card
  }

  function refresh() {
    api('/dsh-pet-hub/status')
      .then(function (st) {
        LAST_PET = st.pet
        LAST_MOOD = st.mood
        var petText = document.getElementById('hub-pet-text')
        var power = document.querySelector('#hub-pet-text ~ button')
        if (petText) {
          var form = st.pet.form === 'widget' ? '挂件' : '桌宠'
          petText.textContent = (st.pet.running ? '运行中' : '未启动') + ' · ' + form
        }
        var dot = document.getElementById('hub-dot')
        if (dot) dot.style.background = st.pet.running ? '#59d98a' : '#8a94a6'
        var moodText = document.getElementById('hub-mood-text')
        if (moodText) {
          moodText.textContent = st.mood ? st.mood.value + ' · ' + moodLabel(st.mood.value) : '还没有心情数据'
        }
        if (power) power.textContent = st.pet.running ? '停' : '起'
      })
      .catch(function () {})

    api('/dsh-tts-bridge/state')
      .then(function (t) {
        LAST_TTS = t
        var node = document.getElementById('hub-tts-text')
        if (node) node.textContent = ttsText(t)
      })
      .catch(function () {
        var node = document.getElementById('hub-tts-text')
        if (node) node.textContent = '连不上插件'
      })
  }

  function hideForeign() {
    var nodes = document.querySelectorAll('div,section,aside')
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      if (node.dataset && (node.dataset.petHub === '1' || node.dataset.hubHidden === '1')) continue
      if (node.closest && node.closest('[data-pet-hub]')) continue
      var cs
      try {
        cs = getComputedStyle(node)
      } catch (e) {
        continue
      }
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      var text = (node.textContent || '').slice(0, 400)
      var hit = false
      for (var j = 0; j < HIDE_MARKERS.length; j += 1) {
        if (text.indexOf(HIDE_MARKERS[j]) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) continue
      node.style.display = 'none'
      if (node.dataset) node.dataset.hubHidden = '1'
    }
  }

  function apply() {
    if (document.getElementById(CARD_ID)) return
    buildCard()
    refresh()
    setInterval(refresh, 3000)
    setInterval(hideForeign, 1500)
    hideForeign()
    try {
      new MutationObserver(hideForeign).observe(document.body, { childList: true, subtree: true })
    } catch (e) {
      /* 观察失败就靠定时器 */
    }
  }

  var factory = function () {
    return { inject: [], apply: apply }
  }
  if (window.__ModuleLoader__ && window.__ModuleLoader__.load) {
    window.__ModuleLoader__.load({ id: 'dsh-pet-hub', factory: factory })
  } else {
    // 兜底：loader 还没就绪时等一会儿
    var tries = 0
    var timer = setInterval(function () {
      if (window.__ModuleLoader__ && window.__ModuleLoader__.load) {
        clearInterval(timer)
        window.__ModuleLoader__.load({ id: 'dsh-pet-hub', factory: factory })
      } else if (++tries > 50) {
        clearInterval(timer)
        apply()
      }
    }, 100)
  }
})()
