/* ═══════════ FyRunner 前端 v0.2 ═══════════ */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const main = $('#main');
  const nav = $('#nav');
  const toastEl = $('#toast');

  const state = {
    view: 'scripts',
    cache: { scripts: [], characters: [], worldbook: [], mods: [], sessions: [] },
    editing: null,
    prep: null,          // 准备界面状态
    chat: { scriptId: null, sessionId: null, msgs: [], busy: false, cast: [] },
    settings: null,
  };

  /* ─────── 工具 ─────── */
  async function api(path, opt = {}) {
    const r = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opt,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j.data;
  }

  function toast(msg, kind = '') {
    toastEl.textContent = msg;
    toastEl.className = 'toast on ' + kind;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.className = 'toast'), 2200);
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ─────── 路由 ─────── */
  function setView(v) {
    state.view = v;
    $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    render();
  }

  nav.addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  /* ═══════════ 剧本 ═══════════ */
  async function renderScripts() {
    const [list, chars] = await Promise.all([api('/scripts'), api('/characters')]);
    state.cache.scripts = list;
    state.cache.characters = chars;

    main.innerHTML = `
      <h1>剧本</h1>
      <div class="sub">点一个剧本 → 选开场 → 填你的角色 → 开始演绎。</div>
      <div class="row" style="margin-bottom:16px">
        <button class="btn" id="newScript">＋ 新建剧本</button>
        <span class="grow"></span>
        <span class="sub" style="margin:0">共 ${list.length} 个</span>
      </div>
      <div id="scriptList"></div>
    `;
    $('#newScript').onclick = () => openScriptEditor(null);

    const box = $('#scriptList');
    if (!list.length) {
      box.innerHTML = `<div class="empty">还没有剧本。<br>点「＋ 新建剧本」开始。</div>`;
      return;
    }
    box.innerHTML = `<div class="cards">${list.map(s => {
      const pool = (s.character_pool || []).length;
      return `
      <div class="card" data-id="${s.id}">
        <div class="acts">
          <button class="btn ghost sm" data-act="edit">编辑</button>
          <button class="btn danger" data-act="del">删</button>
        </div>
        <h3>${esc(s.name || '未命名')}</h3>
        <p>${esc((s.world || '').slice(0, 70) || '（未填世界观）')}</p>
        <div class="meta">${pool} 个角色 · ${(s.openings || []).length} 个开场 · ${fmtTime(s.updated_at)}</div>
      </div>`;
    }).join('')}</div>`;

    box.addEventListener('click', async e => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.dataset.act;
      if (act === 'edit') return openScriptEditor(id);
      if (act === 'del') {
        if (!confirm('删除这个剧本？')) return;
        await api('/scripts/' + id, { method: 'DELETE' });
        toast('已删除', 'ok');
        return renderScripts();
      }
      openPrep(id);
    });
  }

  /* ─────── 剧本编辑器 ─────── */
  async function openScriptEditor(id) {
    const [s, chars, wbs] = await Promise.all([
      id ? api('/scripts/' + id) : Promise.resolve({
        name: '', world: '', story: '', intro_md: '', openings: [''],
        character_pool: [], worldbook_mode: 'all', worldbook_exclude: [], rules: '',
        role_choices: [], player_fields: [
          { key: 'name', label: '您的姓名', type: 'text', placeholder: '例如：周砚', required: true },
          { key: 'age', label: '您的年龄', type: 'number', placeholder: '27' },
          { key: 'identity', label: '您的身份', type: 'text', placeholder: '例如：分析师' },
          { key: 'extra', label: '其他设定', type: 'textarea', placeholder: '和她的关系…' },
        ],
      }),
      api('/characters'),
      api('/worldbook'),
    ]);
    const openings = (s.openings && s.openings.length) ? [...s.openings] : [''];
    const pool = new Set(s.character_pool || []);
    const excl = new Set(s.worldbook_exclude || []);
    const roles = JSON.parse(JSON.stringify(s.role_choices || []));
    const fields = JSON.parse(JSON.stringify(s.player_fields || []));

    main.innerHTML = `
      <h1>${id ? '编辑剧本' : '新建剧本'}</h1>
      <div class="sub">「世界观/故事」是给 AI 看的；「引导页正文」是给你看的。</div>

      <label class="fld"><span>剧本名 *</span><input id="f_name" value="${esc(s.name)}" placeholder="例：47 层"></label>

      <label class="fld"><span>引导页正文（显示在准备界面顶部，支持 # 标题 / **粗体** / - 列表）</span>
        <textarea id="f_intro" style="min-height:150px" placeholder="## 联邦特供：精品商品选购面板&#10;&#10;### 产品简介：服务中心&#10;&#10;这里是新秩序联邦设立的…">${esc(s.intro_md)}</textarea>
      </label>

      <label class="fld"><span>世界观（发给 AI，300 字内）</span><textarea id="f_world" style="min-height:100px">${esc(s.world)}</textarea></label>
      <label class="fld"><span>故事骨架（发给 AI，300 字内）</span><textarea id="f_story" style="min-height:80px">${esc(s.story)}</textarea></label>
      <label class="fld"><span>补充规则（可选）</span><textarea id="f_rules" style="min-height:60px" placeholder="例：每次回复 800–1500 字。">${esc(s.rules)}</textarea></label>

      <label class="fld"><span>身份选项（可选，玩家第一步先选「我是谁」）</span></label>
      <div id="roleList" style="margin-bottom:8px"></div>
      <button class="btn ghost sm" id="addRole" style="margin-bottom:20px">＋ 加一个身份选项</button>

      <label class="fld"><span>开局要填的字段（玩家档案表单）</span></label>
      <div id="fieldList" style="margin-bottom:8px"></div>
      <button class="btn ghost sm" id="addField" style="margin-bottom:20px">＋ 加一个字段</button>

      <label class="fld"><span>开场白（可写多个）</span></label>
      <div id="openList" style="margin-bottom:10px"></div>
      <button class="btn ghost sm" id="addOpen" style="margin-bottom:20px">＋ 再加一个开场</button>

      <label class="fld"><span>本剧可用角色</span></label>
      <div class="checklist" id="poolList" style="margin-bottom:20px"></div>

      <label class="fld"><span>本剧世界书</span></label>
      <div class="row" style="margin-bottom:12px">
        <label class="sw"><input type="radio" name="wbmode" value="all" ${s.worldbook_mode !== 'whitelist' ? 'checked' : ''}><span class="dot"></span>全部启用</label>
        <label class="sw"><input type="radio" name="wbmode" value="whitelist" ${s.worldbook_mode === 'whitelist' ? 'checked' : ''}><span class="dot"></span>只用手动排除的</label>
      </div>
      <div class="checklist" id="wbList" style="margin-bottom:22px"></div>

      <div class="row">
        <button class="btn" id="save">保存</button>
        <button class="btn ghost" id="cancel">取消</button>
      </div>
    `;

    /* 身份选项 */
    function drawRoles() {
      const box = $('#roleList');
      if (!roles.length) { box.innerHTML = `<div style="color:#5f6675;font-size:12px;padding:6px 0">（不设身份选项，直接填档案）</div>`; return; }
      box.innerHTML = roles.map((r, i) => `
        <div class="frow">
          <input data-rk="${i}" value="${esc(r.key || '')}" placeholder="key（英文）" style="flex:0 0 130px">
          <input data-rl="${i}" value="${esc(r.label || '')}" placeholder="显示名，如：我要扮演买家" style="flex:1">
          <button class="del" data-rd="${i}">×</button>
        </div>`).join('');
      $$('#roleList input[data-rk]').forEach(t => t.oninput = () => (roles[+t.dataset.rk].key = t.value));
      $$('#roleList input[data-rl]').forEach(t => t.oninput = () => (roles[+t.dataset.rl].label = t.value));
      $$('#roleList button[data-rd]').forEach(b => b.onclick = () => { roles.splice(+b.dataset.rd, 1); drawRoles(); });
    }
    drawRoles();
    $('#addRole').onclick = () => {
      roles.push({ key: 'role' + (roles.length + 1), label: '' });
      drawRoles();
    };

    /* 玩家字段 */
    function drawFields() {
      const box = $('#fieldList');
      if (!fields.length) { box.innerHTML = `<div style="color:#5f6675;font-size:12px;padding:6px 0">（一个字段都没设，玩家不用填任何东西）</div>`; return; }
      box.innerHTML = fields.map((f, i) => `
        <div class="frow">
          <input data-fk="${i}" value="${esc(f.key || '')}" placeholder="key" style="flex:0 0 110px">
          <input data-fl="${i}" value="${esc(f.label || '')}" placeholder="标签，如：您的姓名" style="flex:0 0 170px">
          <select data-ft="${i}" style="flex:0 0 110px">
            <option value="text" ${f.type === 'text' ? 'selected' : ''}>单行</option>
            <option value="textarea" ${f.type === 'textarea' ? 'selected' : ''}>多行</option>
            <option value="number" ${f.type === 'number' ? 'selected' : ''}>数字</option>
            <option value="select" ${f.type === 'select' ? 'selected' : ''}>下拉</option>
          </select>
          <input data-fp="${i}" value="${esc(f.placeholder || '')}" placeholder="提示文字" style="flex:1">
          <button class="del" data-fd="${i}">×</button>
        </div>`).join('');
      $$('#fieldList input[data-fk]').forEach(t => t.oninput = () => (fields[+t.dataset.fk].key = t.value));
      $$('#fieldList input[data-fl]').forEach(t => t.oninput = () => (fields[+t.dataset.fl].label = t.value));
      $$('#fieldList input[data-fp]').forEach(t => t.oninput = () => (fields[+t.dataset.fp].placeholder = t.value));
      $$('#fieldList select[data-ft]').forEach(sel => {
        sel.onchange = () => {
          const i = +sel.dataset.ft;
          fields[i].type = sel.value;
          if (sel.value === 'select' && !fields[i].options) {
            const s2 = prompt('下拉选项，逗号分隔', '选项1,选项2');
            fields[i].options = (s2 || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
          }
        };
      });
      $$('#fieldList button[data-fd]').forEach(b => b.onclick = () => { fields.splice(+b.dataset.fd, 1); drawFields(); });
    }
    drawFields();
    $('#addField').onclick = () => {
      fields.push({ key: 'field' + (fields.length + 1), label: '', type: 'text', placeholder: '' });
      drawFields();
    };

    /* 开场白 */
    function drawOpenings() {
      const box = $('#openList');
      box.innerHTML = openings.map((o, i) => `
        <div class="row" style="margin-bottom:8px;align-items:flex-start">
          <span style="flex:0 0 22px;color:#5f6675;font-size:12px;padding-top:10px">${i + 1}</span>
          <textarea data-i="${i}" style="min-height:56px">${esc(o)}</textarea>
          <button class="btn danger" data-del="${i}" style="flex:0 0 auto">删</button>
        </div>`).join('');
      $$('#openList textarea').forEach(t => t.oninput = () => (openings[+t.dataset.i] = t.value));
      $$('#openList button[data-del]').forEach(b => {
        b.onclick = () => {
          if (openings.length <= 1) return toast('至少留一个', 'err');
          openings.splice(+b.dataset.del, 1);
          drawOpenings();
        };
      });
    }
    drawOpenings();
    $('#addOpen').onclick = () => { openings.push(''); drawOpenings(); };

    /* 角色池 */
    const poolBox = $('#poolList');
    if (!chars.length) {
      poolBox.innerHTML = `<div style="padding:16px;color:#5f6675;font-size:12.5px">角色库还是空的。</div>`;
    } else {
      poolBox.innerHTML = chars.map(c => `
        <label>
          <input type="checkbox" value="${c.id}" ${pool.has(c.id) ? 'checked' : ''}>
          <span class="nm">${esc(c.name || '未命名')}</span>
          <span class="tg">${esc((c.aliases || []).join(' / '))}</span>
        </label>`).join('');
    }

    /* 世界书 */
    const wbBox = $('#wbList');
    if (!wbs.length) {
      wbBox.innerHTML = `<div style="padding:16px;color:#5f6675;font-size:12.5px">世界书还是空的。</div>`;
    } else {
      wbBox.innerHTML = wbs.map(w => `
        <label>
          <input type="checkbox" value="${w.id}" ${excl.has(w.id) ? 'checked' : ''}>
          <span class="nm">${esc(w.title || '未命名')}</span>
          <span class="tg">${esc((w.keys || []).join('、'))}</span>
        </label>`).join('');
    }

    $('#cancel').onclick = () => setView('scripts');
    $('#save').onclick = async () => {
      const mode = ($('input[name="wbmode"]:checked') || {}).value || 'all';
      const data = {
        name: $('#f_name').value.trim(),
        intro_md: $('#f_intro').value,
        world: $('#f_world').value,
        story: $('#f_story').value,
        rules: $('#f_rules').value,
        openings: openings.map(x => x.trim()).filter(Boolean),
        role_choices: roles.filter(r => r.label),
        player_fields: fields.filter(f => f.key && f.label),
        character_pool: $$('#poolList input:checked').map(x => x.value),
        worldbook_mode: mode,
        worldbook_exclude: $$('#wbList input:checked').map(x => x.value),
      };
      if (!data.name) return toast('剧本名不能空', 'err');
      try {
        if (id) await api('/scripts/' + id, { method: 'PUT', body: data });
        else await api('/scripts', { method: 'POST', body: data });
        toast('已保存', 'ok');
        setView('scripts');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ─────── 极简 markdown 渲染 ─────── */
  function md(t) {
    if (!t) return '';
    let s = esc(t);
    s = s.replace(/^### (.+)$/gm, '<h4 style="font-size:13px;font-weight:600;color:#b8c4ff;margin:12px 0 6px">$1</h4>');
    s = s.replace(/^## (.+)$/gm, '<h3 style="font-size:15px;font-weight:600;color:#c7d0ff;margin:14px 0 7px">$1</h3>');
    s = s.replace(/^# (.+)$/gm, '<h2 style="font-size:17px;font-weight:700;color:#dde3ff;margin:14px 0 8px">$1</h2>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<b style="color:#e2e6f2">$1</b>');
    s = s.replace(/^- (.+)$/gm, '<div style="padding-left:14px;position:relative"><span style="position:absolute;left:2px;color:#5f6675">·</span>$1</div>');
    s = s.replace(/\n\n/g, '<div style="height:9px"></div>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  /* ─────── 准备界面（5 步向导）─────── */
  async function openPrep(id) {
    const [s, chars, cats, wbs] = await Promise.all([api('/scripts/' + id), api('/characters'), api('/categories'), api('/worldbook')]);
    const pool = new Set(s.character_pool || []);
    const catOn = {};
    (cats || []).forEach(c => { catOn[c.name] = c.enabled !== false; });

    // 可用角色：分类开启的
    let avail = chars.filter(c => catOn[c._category || ''] !== false);
    // 池子不为空 → 优先池子里的，但「从角色库添加」能加其他的
    const inPool = avail.filter(c => pool.has(c.id));
    const openings = (s.openings || []).filter(Boolean);
    const roles = s.role_choices || [];
    const fields = s.player_fields || [];

    state.prep = {
      step: 1,
      script: s,
      allChars: avail,
      cats: cats || [],
      pool,
      catOn,
      picked: (inPool.length ? inPool : avail).slice(0, 2).map(c => c.id),
      openCat: null,          // 当前展开的分类
      opening: openings.length ? 0 : -1,
      rolesById: {},
      worldbooks: wbs || [],
      wbIds: (wbs || []).filter(w => w.enabled !== false).map(w => w.id),
      customOpening: '',
      role: roles.length ? roles[0].key : '',
      values: {},
    };

    drawPrep();
  }

  function drawPrep() {
    const P = state.prep;
    const s = P.script;
    const openings = (s.openings || []).filter(Boolean);
    const roles = s.role_choices || [];
    const fields = s.player_fields || [];

    const stepNames = ['剧情', '玩家', '角色', '开场', '确认'];
    const stepsHtml = stepNames.map((n, i) => {
      const idx = i + 1;
      const cls = idx === P.step ? 'on' : (idx < P.step ? 'done' : '');
      return `<span class="s ${cls}" data-step="${idx}">${idx} ${n}</span>` +
        (idx < 5 ? '<span class="arw">›</span>' : '');
    }).join('');

    let body = '';

    /* ── 第一步：剧情介绍 ── */
    if (P.step === 1) {
      body = `
        <div class="panel">
          <div class="ptitle">${esc(s.name)}</div>
          <div class="psub">— 先看看这是个什么故事 —</div>

          ${s.intro_md ? `<div class="pblock">${md(s.intro_md)}</div>` : ''}

          ${s.world ? `<div class="pblock"><h3>世界观</h3><p style="white-space:pre-wrap">${esc(s.world)}</p></div>` : ''}
          ${s.story ? `<div class="pblock"><h3>故事</h3><p style="white-space:pre-wrap">${esc(s.story)}</p></div>` : ''}

          ${openings.length ? `
          <div class="pblock">
            <h3>可选的预设开场（后面第 4 步才选）</h3>
            ${openings.map((o, i) => `
              <p style="padding:9px 12px;background:rgba(255,255,255,.02);border-radius:8px;margin-bottom:7px;color:#9099ab;font-size:12.5px">
                ${esc(o)}
              </p>`).join('')}
          </div>` : ''}
        </div>`;
    }

    /* ── 第二步：玩家信息 ── */
    if (P.step === 2) {
      const roleHtml = roles.length ? `
        <div class="pblock">
          <h3>你的身份</h3>
          <div class="row" style="justify-content:center;gap:26px">
            ${roles.map((r, i) => `
              <label class="sw" style="font-size:13px">
                <input type="radio" name="role" value="${esc(r.key)}" ${P.role === r.key ? 'checked' : ''}>
                <span class="dot"></span>${esc(r.label)}
              </label>`).join('')}
          </div>
        </div>` : '';

      const g = String(P.values.gender || ((fields.find(f => f.key === 'gender') || {}).options || ['男'])[0] || '男');
      const isFemale = g === '女';
      const isMale = g === '男';
      const isBoth = g.indexOf('扶她') >= 0 || g === '其他';

      const selFld = (key, label, opts) => `<label class="fld"><span>${label}</span><select data-fk="${key}">${opts.map(o => `<option value="${esc(o[0])}" ${String(P.values[key] || '') === o[0] ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
      const numFld = (key, label, ph, min, max) => `<label class="fld"><span>${label}</span><input data-fk="${key}" type="number" min="${min}" max="${max}" placeholder="${ph}" value="${esc(P.values[key] || '')}"></label>`;
      const txtFld = (key, label, ph) => `<label class="fld"><span>${label}</span><input data-fk="${key}" placeholder="${ph}" value="${esc(P.values[key] || '')}"></label>`;

      const F_BODY = [['loli', '萝莉（娇小）'], ['girl', '少女（纤细）'], ['onee', '御姐（高挑）'], ['mature', '熟女（丰腴）'], ['plump', '丰满（肉感）']];
      const M_BODY = [['thin', '消瘦'], ['normal', '匀称'], ['athletic', '健硕'], ['fat', '肥胖']];
      const bodyOpts = isFemale ? F_BODY : (isMale ? M_BODY : F_BODY.concat(M_BODY));
      const TEMPER_F = [
        ['清纯','少女',5,'清纯系'],['温柔','少女',4,'清纯系'],['天真','萝莉',2,'清纯系'],['圣洁','少女',3,'清纯系'],['忠贞','少女',3,'清纯系'],['大和抚子','熟女',5,'清纯系'],
        ['元气','少女',4,'元气系'],['娇俏','少女',3,'元气系'],['甜妹','少女',4,'元气系'],['小恶魔','少女',4,'元气系'],['辣妹','少女',2,'元气系'],['傲娇','少女',3,'元气系'],
        ['冷艳','御姐',6,'御姐系'],['英气','御姐',3,'御姐系'],['知性','御姐',4,'御姐系'],['威严','御姐',2,'御姐系'],['姐姐','御姐',4,'御姐系'],['女教师','御姐',4,'御姐系'],['女医','御姐',4,'御姐系'],['军装','御姐',4,'御姐系'],['旗袍','御姐',3,'御姐系'],
        ['妖艳','御姐',7,'妖艳系'],['妩媚','御姐',6,'妖艳系'],['钓系','御姐',5,'妖艳系'],['涩气','御姐',5,'妖艳系'],['恶女','御姐',4,'妖艳系'],['疯批','御姐',2,'妖艳系'],
        ['母性','熟女',5,'熟女系'],['端庄','熟女',4,'熟女系'],['成熟','熟女',4,'熟女系'],['人妻','熟女',6,'熟女系'],['未亡人','熟女',4,'熟女系'],['圣母女','熟女',6,'熟女系'],['古典','熟女',4,'熟女系'],['落魄','熟女',1,'熟女系'],['母性溢出','熟女',6,'熟女系'],
        ['病弱','少女',2,'特殊系'],['病娇','少女',2,'特殊系'],['病态','少女',2,'特殊系'],['慵懒','御姐',3,'特殊系'],['毒舌','御姐',2,'特殊系'],['神秘','御姐',3,'特殊系'],['野性','御姐',2,'特殊系'],['软糯','萝莉',2,'特殊系'],['稚气','萝莉',1,'特殊系'],['巫女','少女',3,'特殊系'],['冷淡','御姐',3,'特殊系'],['女仆','少女',3,'特殊系'],['骑士姬','御姐',4,'特殊系'],['公主','少女',4,'特殊系'],
      ];
      const TEMPER_M = [
        ['硬朗','男',5,'硬朗系'],['军装','男',4,'硬朗系'],['黑道','男',2,'硬朗系'],['江湖气','男',2,'硬朗系'],['骑士','男',4,'硬朗系'],
        ['儒雅','男',4,'儒雅系'],['书卷','男',3,'儒雅系'],['教授','男',4,'儒雅系'],['医生','男',3,'儒雅系'],['律师','男',3,'儒雅系'],['管家','男',4,'儒雅系'],['儒将','男',4,'儒雅系'],
        ['阳光','男',4,'少年系'],['少年感','男',4,'少年系'],['学长','男',4,'少年系'],['热血','男',2,'少年系'],
        ['沉稳','男',5,'成熟系'],['老练','男',4,'成熟系'],['大叔','男',3,'成熟系'],['父亲','男',4,'成熟系'],
        ['冷峻','男',3,'特殊系'],['霸道','男',3,'特殊系'],['忠犬','男',3,'特殊系'],['痞气','男',2,'特殊系'],['阴柔','男',1,'特殊系'],['邪魅','男',2,'特殊系'],['禁欲','男',4,'特殊系'],['贵气','男',4,'特殊系'],['慵懒','男',1,'特殊系'],['钓系','男',3,'特殊系'],['忠厚','男',3,'特殊系'],['疯批','男',2,'特殊系'],['阴郁','男',1,'特殊系'],['落魄','男',1,'特殊系'],['温柔','男',3,'特殊系'],['毒舌','男',1,'特殊系'],
      ];
      const COMBO_F = [
        { bt: ['loli'], temps: ['母性','端庄','成熟','母性溢出'], name: '萝莉妈妈', pts: 10 },
        { bt: ['loli'], temps: ['妖艳','涩气','妩媚'], name: '幼态媚', pts: 8 },
        { bt: ['girl'], temps: ['母性','母性溢出'], name: '天真母亲', pts: 9 },
        { bt: ['girl'], temps: ['冷艳','威严'], name: '冷面少女', pts: 7 },
        { bt: ['onee'], temps: ['清纯','天真','圣洁'], name: '反差纯', pts: 8 },
        { bt: ['onee'], temps: ['母性','母性溢出'], name: '姐姐妈妈', pts: 8 },
        { bt: ['mature'], temps: ['清纯','圣洁','忠贞'], name: '圣洁人妻', pts: 9 },
        { bt: ['mature'], temps: ['妖艳','妩媚'], name: '熟艳', pts: 8 },
        { bt: ['plump'], temps: ['端庄','大和抚子'], name: '丰润端庄', pts: 6 },
      ];
      const COMBO_M = [
        { bt: ['athletic'], temps: ['温柔','忠犬'], name: '反差忠犬', pts: 8 },
        { bt: ['athletic'], temps: ['禁欲'], name: '禁欲猛男', pts: 7 },
        { bt: ['thin'], temps: ['硬朗'], name: '清瘦硬骨', pts: 6 },
        { bt: ['fat'], temps: ['贵气'], name: '富态', pts: 5 },
      ];
      const temperPts = (list, names, bt, combos) => {
        const w = [1, 0.6, 0.3];
        let s = 0;
        names.forEach((n, i) => {
          const row = list.find(x => x[0] === n);
          if (row) s += row[2] * w[i];
        });
        let best = null;
        for (const c of combos) {
          if (c.bt.includes(bt) && names.some(n => c.temps.includes(n)) && (!best || c.pts > best.pts)) best = c;
        }
        return { pts: s + (best ? best.pts : 0), combo: best ? best.name + ' +' + best.pts : '' };
      };
      const temperSelect = (key, label) => {
        const list = isMale ? TEMPER_M : (isFemale ? TEMPER_F : TEMPER_F.concat(TEMPER_M));
        const groups = {};
        for (const row of list) (groups[row[3]] = groups[row[3]] || []).push(row);
        const cur = String(P.values[key] || '');
        let opts = `<option value="">（不选）</option>`;
        for (const gname of Object.keys(groups)) {
          opts += `<optgroup label="${esc(gname)}">` + groups[gname].map(r =>
            `<option value="${esc(r[0])}" ${cur === r[0] ? 'selected' : ''}>${esc(r[0])}（+${r[2]}）</option>`).join('') + `</optgroup>`;
        }
        return `<label class="fld"><span>${label}</span><select data-fk="${key}">${opts}</select></label>`;
      };
      const bodyVals = bodyOpts.map(o => o[0]);
      if (!bodyVals.includes(P.values.body_type)) P.values.body_type = bodyVals[0];

      const SENS = [
        ['0', '0 无感：怎么弄都不湿，只觉得麻烦，甚至会走神'],
        ['1', '1 迟钝：要很久才有感觉，湿得很慢'],
        ['2', '2 慢热：前戏到位才会湿，急了反而干'],
        ['3', '3 普通：正常反应，摸一会儿就软'],
        ['4', '4 敏感：一碰就抖，很快湿，忍不住夹腿'],
        ['5', '5 极敏感：碰一下就去，湿得止不住，叫得压不住'],
      ];
      const FERT = [
        ['0', '0 不孕：几乎不可能怀上'],
        ['1', '1 极难孕：中奖率极低'],
        ['2', '2 难孕：要很多次才可能'],
        ['3', '3 普通：正常概率'],
        ['4', '4 易孕：一次就可能中'],
        ['5', '5 极易孕：一次就中，挡都挡不住'],
      ];
      const MILK = [
        ['poor', '贫乳（跟橘子差不多，一只手就攥住）'],
        ['normal', '普乳（跟苹果差不多，一捧刚好）'],
        ['big', '巨乳（跟橄榄球差不多，一捧半）'],
        ['huge', '爆乳（跟篮球差不多，两只手才捧得住）'],
        ['super', '超乳（跟瑜伽球差不多，两条胳膊都圈不住）'],
      ];

      let bodyFields = '';
      if (!isFemale) {
        bodyFields += `<div style="margin:14px 0 6px;color:#8b93a7;font-size:12px">男性部分</div>`;
        bodyFields += numFld('length', '长度（cm，勃起）', '例：18', 5, 40);
        bodyFields += numFld('shaft_diameter', '茎身直径（cm）', '例：4', 2, 8);
        bodyFields += numFld('glans_diameter', '龟头直径（cm）', '例：4.5', 2, 9);
        bodyFields += `<div class="hint" id="derivedCirc" style="margin:-2px 0 8px">周长自动算：—</div>`;
      }
      if (!isMale) {
        bodyFields += `<div style="margin:14px 0 6px;color:#8b93a7;font-size:12px">女性部分</div>`;
        bodyFields += selFld('sensitivity', '敏感度', SENS);
        bodyFields += selFld('fertility', '受孕体质', FERT);
        bodyFields += numFld('bust', '胸围（cm）', '例：88', 60, 140);
        bodyFields += `<div class="hint" id="derivedCup" style="margin:-2px 0 8px">罩杯自动算：—</div>`;
        bodyFields += selFld('milk_volume', '乳量', MILK);
      }
      bodyFields += `<div style="margin:14px 0 6px;color:#8b93a7;font-size:12px">自动推算</div>`;
      bodyFields += `<div class="hint" id="derivedWH" style="padding:8px 10px;background:#191d27;border:1px solid #262c3a;border-radius:8px">腰围 / 臀围：选完体型、身高、胸围后自动生成</div>`;
      bodyFields += `<div style="margin:18px 0 6px;color:#8b93a7;font-size:12px">魅力评估（不计入跑团，只供参考）</div>`;
      bodyFields += `<div id="charmBox" style="padding:10px 12px;background:#191d27;border:1px solid #262c3a;border-radius:8px;font-size:12.5px;color:#b9bfcc">填完上面的内容，这里会自动出分。</div>`;

      let effFields = fields.slice();
      if (!effFields.some(f => f.key === 'name'))
        effFields.unshift({ label: '姓名', key: 'name', type: 'text', required: true });
      if (!effFields.some(f => f.key === 'gender'))
        effFields.unshift({ label: '性别', key: 'gender', type: 'select', options: ['男', '女', '扶她（futa）', '其他'] });

      const appBlock = `            <div style="margin:18px 0 6px;color:#8b93a7;font-size:12px">外观细节</div>
            ${txtFld('hair_color', '发色', '例：黑长直 / 银白 / 金棕')}
            ${txtFld('skin_color', '肤色', '例：白皙 / 小麦色 / 蜜色')}
            ${txtFld('eye_color', '瞳色', '例：深红 / 琥珀 / 灰蓝')}
            ${numFld('height', '身高（cm）', '例：168', 120, 220)}
            ${selFld('body_type', '体型', bodyOpts)}
            <div style="margin:10px 0 4px;color:#8b93a7;font-size:12px">气质（最多三个，第一个定主调）</div>
            ${temperSelect('qizhi_main', '主气质')}
            ${temperSelect('qizhi_sub1', '副气质 1')}
            ${temperSelect('qizhi_sub2', '副气质 2')}

            <details style="margin:8px 0 0;border:1px solid #262c3a;border-radius:8px;padding:8px 10px;background:#191d27">
              <summary style="cursor:pointer;color:#8b93a7;font-size:12px">不知道怎么填？点开看「体型参考表」</summary>
              <table style="width:100%;margin-top:8px;font-size:11.5px;color:#b9bfcc;border-collapse:collapse">
                <tr style="color:#8b93a7"><th align="left">体型</th><th>建议身高</th><th>建议胸围</th><th>常见罩杯</th><th>腰/臀</th></tr>
                <tr><td>萝莉</td><td>145–152</td><td>70–76</td><td>AA–A</td><td>54 / 76</td></tr>
                <tr><td>少女</td><td>152–160</td><td>78–84</td><td>A–C</td><td>56 / 84</td></tr>
                <tr><td>御姐</td><td>162–170</td><td>86–92</td><td>C–E</td><td>60 / 90</td></tr>
                <tr><td>熟女</td><td>160–168</td><td>94–100</td><td>E–G</td><td>66 / 96</td></tr>
                <tr><td>丰满</td><td>158–166</td><td>100–108</td><td>G–I</td><td>70 / 100</td></tr>
                <tr><td>男·消瘦</td><td>170–178</td><td>84–88</td><td>—</td><td>70 / 86</td></tr>
                <tr><td>男·匀称</td><td>172–180</td><td>88–94</td><td>—</td><td>76 / 92</td></tr>
                <tr><td>男·健硕</td><td>175–185</td><td>100–106</td><td>—</td><td>80 / 96</td></tr>
                <tr><td>男·肥胖</td><td>168–178</td><td>105–112</td><td>—</td><td>96 / 104</td></tr>
              </table>
              <div class="hint" style="margin-top:6px">照着填就行；填完会自动算罩杯和腰臀。</div>
            </details>`;

      const hasApp = effFields.some(f => f.key === 'appearance');
      const fieldHtml = effFields.length ? `
        <div class="pblock">
          <h3>你的档案</h3>
          <div style="padding:0 6px">
            ${effFields.map((f, idx) => {
              const v = P.values[f.key] || '';
              const ph = esc(f.placeholder || '');
              const req = f.required ? ' *' : '';
              if (f.type === 'textarea')
                return `<label class="fld"><span>${esc(f.label)}${req}</span><textarea data-fk="${esc(f.key)}" style="min-height:70px" placeholder="${ph}">${esc(v)}</textarea></label>`;
              if (f.type === 'select')
                return `<label class="fld"><span>${esc(f.label)}${req}</span><select data-fk="${esc(f.key)}">${(f.options || []).map(o => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
              if (f.type === 'number')
                return `<label class="fld"><span>${esc(f.label)}${req}</span><input data-fk="${esc(f.key)}" type="number" placeholder="${ph}" value="${esc(v)}"></label>`;
              return `<label class="fld"><span>${esc(f.label)}${req}</span><input data-fk="${esc(f.key)}" placeholder="${ph}" value="${esc(v)}"></label>` + ((f.key === 'appearance' || (!hasApp && idx === effFields.length - 1)) ? appBlock : '');
            }).join('')}



            <div style="margin:16px 0 6px;color:#8b93a7;font-size:12px">身体数据（引擎判定用）</div>
            ${bodyFields}
          </div>
        </div>` : `<div class="empty">这个剧本没设玩家字段</div>`;

      body = `<div class="panel">
        <div class="ptitle">你是谁</div>
        <div class="psub">— 这一局你扮演的角色 —</div>
        ${roleHtml}${fieldHtml}
      </div>`;

      const RATIO = {
        loli:   { b: 72,  w: 54, hh: 76,  h: 148, under: 0.80 },
        girl:   { b: 80,  w: 56, hh: 84,  h: 156, under: 0.78 },
        onee:   { b: 88,  w: 60, hh: 90,  h: 166, under: 0.76 },
        mature: { b: 96,  w: 66, hh: 96,  h: 164, under: 0.74 },
        plump:  { b: 100, w: 70, hh: 100, h: 162, under: 0.72 },
        thin:   { b: 84,  w: 70, hh: 86,  h: 174, under: 0.86 },
        normal: { b: 92,  w: 76, hh: 92,  h: 176, under: 0.88 },
        athletic:{ b: 102, w: 80, hh: 96,  h: 180, under: 0.90 },
        fat:    { b: 108, w: 96, hh: 104, h: 172, under: 0.92 },
      };
      const CUPS = [[7.5, 'AA'], [10, 'A'], [12.5, 'B'], [15, 'C'], [17.5, 'D'], [20, 'E'], [22.5, 'F'], [25, 'G'], [27.5, 'H'], [99, 'I+']];

      const clamp = (n) => Math.max(1, Math.min(100, Math.round(n)));
      const cupOf = (bust, bt) => {
        const b = Number(bust) || 0; if (!b) return '';
        const under = { loli: .80, girl: .78, onee: .76, mature: .74, plump: .72, thin: .86, normal: .88, athletic: .90, fat: .92 }[bt] || .78;
        const d = b - Math.round(b * under);
        for (const [lim, n] of CUPS) if (d <= lim) return n;
        return 'I+';
      };
      const MALE_GAZE = {
        top: ['这身材，现实里遇到我直接原地结婚。', '腰臀比离谱，谁顶得住。', '脸和身材都在线，没得挑。', '这种的，拍照都不用修。'],
        high: ['这腰这腿，走在街上回头率百分百。', '脸一般，但身材是真的会生。', '姐姐踩我。', '不用看脸，看身材就够了。'],
        mid: ['挺好看的，耐看型。', '胸不错，腰再细点就完美了。', '邻家姐姐的感觉，舒服。'],
        low: ['清秀，普通好看。', '胜在干净，别的就别要求了。', '路人水平，不过挺真实。'],
        bottom: ['脸一般，身材也一般。', '扔人堆里找不着。', '还行吧，关了灯都一样。'],
      };
      const FEMALE_GAZE = {
        top: ['这肩膀这身高，我可以。', '脸帅身材好，说话再好听点就完美了。', '这种的，带出去有面子。', '身高加分，脸也顺眼，挑不出毛病。'],
        high: ['身板可以，肩膀宽。', '看着挺结实的，靠得住。', '脸不错，就是不知道性格怎么样。'],
        mid: ['还行，干净利落。', '不算帅，但看着舒服。', '普通男生，踏实那种。'],
        low: ['一般般，没什么记忆点。', '脸普通，身材也普通。'],
        bottom: ['路人，扔人堆里找不着。', '没什么亮点。', '下一个。'],
      };
      const bandOf = (s) => s >= 96 ? '传说' : s >= 89 ? '祸水' : s >= 76 ? '尤物' : s >= 61 ? '美人' : s >= 41 ? '标致' : s >= 21 ? '清秀' : '路人';
      const poolOf = (s) => s >= 89 ? 'top' : s >= 76 ? 'high' : s >= 61 ? 'mid' : s >= 41 ? 'low' : 'bottom';
      const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
      const hash = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return h; };

      const HARM = (v, femaleSide) => {
        const h = Number(v.height) || 0;
        if (!h) return 0;
        let s = 0;
        if (femaleSide) {
          const bust = Number(v.bust) || 0, waist = Number(v.waist) || 0, hip = Number(v.hip) || 0;
          if (waist && hip) {
            const whr = waist / hip;
            s += whr <= 0.70 ? 10 : whr <= 0.74 ? 8 : whr <= 0.78 ? 6 : whr <= 0.84 ? 3 : 1;
          }
          if (bust) { const bhr = bust / h; s += bhr >= 0.58 ? 8 : bhr >= 0.53 ? 7 : bhr >= 0.48 ? 5 : bhr >= 0.42 ? 3 : 1; }
          if (hip) { const hhr = hip / h; s += hhr >= 0.58 ? 7 : hhr >= 0.53 ? 6 : hhr >= 0.48 ? 4 : hhr >= 0.42 ? 2 : 1; }
        } else {
          s += h >= 190 ? 7 : h >= 180 ? 8 : h >= 172 ? 7 : h >= 165 ? 5 : 3;
          const L = Number(v.length) || 0, G = Number(v.shaft_diameter) || 0;
          if (L && G) { const r = G / L; s += (r >= 0.22 && r <= 0.30) ? 10 : (r >= 0.18 && r <= 0.35) ? 6 : 3; }
        }
        return s;
      };
      const CUP_PTS = { AA: 0, A: 2, B: 4, C: 6, D: 8, E: 8, F: 6, G: 5, H: 4, 'I+': 3 };
      const MILK_PTS = { poor: 1, normal: 2, big: 3, huge: 4, super: 4 };
      const LEN_PTS = (L) => L >= 18 && L <= 22 ? 8 : L >= 15 ? 6 : L >= 12 ? 4 : 2;
      const GIR_PTS = (G) => G >= 4.5 && G <= 5.5 ? 8 : G >= 3.5 ? 6 : 3;

      function scoreFemale(v) {
        let s = 40;
        s += HARM(v, true);
        s += Math.min(3, (Number(v.sensitivity) || 0) * 0.6);
        s += Math.min(2, (Number(v.fertility) || 0) * 0.4);
        s += CUP_PTS[cupOf(v.bust, v.body_type)] || 0;
        let d = 0; ['hair_color', 'skin_color', 'eye_color'].forEach(k => { if (v[k]) d += 2; });
        s += d;
        const names = [v.qizhi_main, v.qizhi_sub1, v.qizhi_sub2].filter(Boolean);
        s += temperPts(TEMPER_F, names, v.body_type, COMBO_F).pts;
        s += MILK_PTS[v.milk_volume] || 0;
        return clamp(s);
      }

      function scoreMale(v) {
        let s = 35;
        s += HARM(v, false);
        s += ({ athletic: 8, normal: 6, thin: 4, fat: 1 })[v.body_type] || 0;
        s += LEN_PTS(Number(v.length) || 0);
        s += GIR_PTS(Number(v.shaft_diameter) || 0);
        let d = 0; ['hair_color', 'skin_color', 'eye_color'].forEach(k => { if (v[k]) d += 2; });
        s += d;
        const names = [v.qizhi_main, v.qizhi_sub1, v.qizhi_sub2].filter(Boolean);
        s += temperPts(TEMPER_M, names, v.body_type, COMBO_M).pts;
        return clamp(s);
      }

      function scoreFuta(v) {
        let s = 30;
        s += HARM(v, true);
        s += HARM(v, false);
        s += CUP_PTS[cupOf(v.bust, v.body_type)] || 0;
        s += LEN_PTS(Number(v.length) || 0);
        s += GIR_PTS(Number(v.shaft_diameter) || 0);
        let d = 0; ['hair_color', 'skin_color', 'eye_color'].forEach(k => { if (v[k]) d += 2; });
        s += d;
        const names = [v.qizhi_main, v.qizhi_sub1, v.qizhi_sub2].filter(Boolean);
        const all = TEMPER_F.concat(TEMPER_M);
        const basePts = temperPts(all, names, v.body_type, []).pts;
        const fBase = temperPts(TEMPER_F, names, v.body_type, []).pts;
        const mBase = temperPts(TEMPER_M, names, v.body_type, []).pts;
        const fAll = temperPts(TEMPER_F, names, v.body_type, COMBO_F).pts;
        const mAll = temperPts(TEMPER_M, names, v.body_type, COMBO_M).pts;
        const combo = Math.max(fAll - fBase, mAll - mBase, 0);
        s += basePts + combo;
        s += MILK_PTS[v.milk_volume] || 0;
        return clamp(s);
      }

      function updateCharm() {
        const box = $('#charmBox');
        if (!box) return;
        const v = P.values;
        const seed = hash((v.name || '') + '|' + (v.gender || ''));
        let total, comments = [];
        if (g === '男') {
          total = scoreMale(v);
          const band = bandOf(total), pool = poolOf(total);
          comments.push({ who: '女网友', text: pick(FEMALE_GAZE[pool], seed) });
        } else if (isFemale) {
          total = scoreFemale(v);
          const band = bandOf(total), pool = poolOf(total);
          comments.push({ who: '男网友', text: pick(MALE_GAZE[pool], seed) });
        } else {
          total = scoreFuta(v);
          const band0 = bandOf(total), pool0 = poolOf(total);
          comments.push({ who: '男网友', text: pick(MALE_GAZE[pool0], seed) });
          comments.push({ who: '女网友', text: pick(FEMALE_GAZE[pool0], seed + 7) });
        }
        const band = bandOf(total);
        const names = [v.qizhi_main, v.qizhi_sub1, v.qizhi_sub2].filter(Boolean);
        let comboLine = '';
        if (g === '男') comboLine = temperPts(TEMPER_M, names, v.body_type, COMBO_M).combo;
        else if (isFemale) comboLine = temperPts(TEMPER_F, names, v.body_type, COMBO_F).combo;
        else comboLine = [temperPts(TEMPER_F, names, v.body_type, COMBO_F).combo,
                          temperPts(TEMPER_M, names, v.body_type, COMBO_M).combo].filter(Boolean).join(' ／ ');
        const pct = total;
        const barColor = total >= 89 ? '#f472b6' : total >= 76 ? '#c084fc' : total >= 61 ? '#60a5fa' : total >= 41 ? '#34d399' : '#94a3b8';
        box.innerHTML = `
          <div style="display:flex;align-items:baseline;gap:8px">
            <b style="font-size:22px;color:#e2e6f2">${total}</b>
            <span style="color:#8b93a7">/ 100</span>
            <span style="color:${barColor};font-weight:600">${band}</span>
          </div>
          <div style="height:6px;background:#1d212c;border-radius:4px;overflow:hidden;margin:6px 0 8px">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:4px"></div>
          </div>
          ${comboLine ? `<div style="margin-top:2px;color:#c084fc">组合：${comboLine}</div>` : ''}
          ${comments.map(c => `<div style="margin-top:4px"><span style="color:#6b7280">【${c.who}】</span>「${c.text}」</div>`).join('')}
          <div class="hint" style="margin-top:6px">不计入跑团数值，只作参考。</div>`;
        P.values.charm = {
          score: total, band: band, combo: comboLine,
          comments: comments.map(c => c.who + '：' + c.text)
        };
      }

      function derive() {
        const bt = P.values.body_type || (isFemale ? 'girl' : 'normal');
        const base = RATIO[bt] || RATIO.girl;
        const h = Number(P.values.height) || base.h;
        const bust = Number(P.values.bust) || base.b;
        const kH = 1 + (h - base.h) / 500;
        const kW = 0.92 + (bust / base.b) * 0.08;
        const waist = Math.round(base.w * kH * kW);
        const hip = Math.round(base.hh * kH * (0.98 + (bust / base.b) * 0.02));
        P.values.waist = String(waist);
        P.values.hip = String(hip);
        const waistDesc = (w) => {
          if (w <= 56) return '两只手一圈就掐住了，细得离谱';
          if (w <= 63) return '双手一抱还有空，盈盈一握';
          if (w <= 70) return '一抱刚好，手感正好';
          if (w <= 78) return '一抱有点满，肉感出来了';
          return '抱不过来了，得两只手使劲';
        };
        const hipDesc = (h2) => {
          if (h2 <= 84) return '两只手一环就圈住，屁股不大';
          if (h2 <= 92) return '比肩膀宽一点，一抱正好';
          if (h2 <= 100) return '一抱刚好抱满，手感扎实';
          if (h2 <= 108) return '一抱抱不住，得使劲';
          return '两只手都合不拢，走路都晃';
        };
        const el = $('#derivedWH');
        if (el) el.textContent = '腰围 ' + waist + '（' + waistDesc(waist) + '） ／ 臀围 ' + hip + '（' + hipDesc(hip) + '）';

        const under = Math.round(bust * base.under);
        const diff = bust - under;
        let cup = 'AA';
        for (const [lim, name] of CUPS) { if (diff <= lim) { cup = name; break; } }
        const c = $('#derivedCup');
        if (c) c.textContent = '下胸围约 ' + under + 'cm，罩杯约 ' + cup + '（' + bust + '−' + under + '=' + diff + '）';

        const sd = Number(P.values.shaft_diameter) || 0;
        const cc = $('#derivedCirc');
        if (cc) cc.textContent = sd ? ('周长约 ' + (Math.PI * sd).toFixed(1) + 'cm') : '周长自动算：—';

        updateCharm();
      }

      setTimeout(() => {
        const gs = document.querySelector('select[data-fk="gender"]');
        if (gs) gs.addEventListener('change', () => { P.values.gender = gs.value; drawPrep(); });
        ['height', 'body_type', 'bust', 'shaft_diameter'].forEach(k => {
          const el = document.querySelector('[data-fk="' + k + '"]');
          if (el) el.addEventListener('input', derive);
          if (el) el.addEventListener('change', derive);
        });
        const bts = document.querySelector('[data-fk="body_type"]');
        if (bts) bts.addEventListener('change', () => {
          P.values.body_type = bts.value;
          const b = RATIO[bts.value]; if (!b) return;
          const hEl = document.querySelector('[data-fk="height"]');
          const bEl = document.querySelector('[data-fk="bust"]');
          if (hEl && !hEl.value) { hEl.value = String(b.h); P.values.height = String(b.h); }
          if (bEl && !bEl.value && !isMale) { bEl.value = String(b.b); P.values.bust = String(b.b); }
          derive();
        });
        ['qizhi_main', 'qizhi_sub1', 'qizhi_sub2'].forEach(k => {
          const el = document.querySelector('[data-fk="' + k + '"]');
          if (el) el.addEventListener('change', () => { P.values[k] = el.value; derive(); });
        });
        const milkSel = document.querySelector('[data-fk="milk_volume"]');
        if (milkSel) milkSel.addEventListener('change', () => {
          const base = RATIO[P.values.body_type || 'girl'] || RATIO.girl;
          const factor = { poor: 0.85, normal: 1.0, big: 1.12, huge: 1.28, super: 1.45 }[milkSel.value] || 1;
          const bEl = document.querySelector('[data-fk="bust"]');
          if (bEl) { bEl.value = String(Math.round(base.b * factor)); P.values.bust = bEl.value; }
          derive();
        });
        derive();
      }, 0);
    }

    /* ── 第三步：登场角色（按分类）── */
    if (P.step === 3) {
      const groups = {};
      for (const c of P.allChars) {
        const k = c._category || '';
        (groups[k] = groups[k] || []).push(c);
      }
      const catNames = Object.keys(groups).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));

      if (!catNames.length) {
        body = `<div class="panel"><div class="ptitle">登场角色</div>
          <div class="empty">角色库还没有可用角色。<br>先去「角色库」建几个，或检查分类开关。</div></div>`;
      } else {
        const cur = P.openCat;
        let catCards = catNames.map(cn => {
          const arr = groups[cn];
          const onCnt = arr.filter(c => P.picked.includes(c.id)).length;
          return `
            <div class="pcard ${cur === cn ? 'on' : ''}" data-cat="${esc(cn)}" style="position:relative">
              <div class="pn">${esc(cn || '未分类')}</div>
              <div class="pa">${arr.length} 个角色${onCnt ? ` · 已选 ${onCnt}` : ''}</div>
              <div class="pd">${arr.slice(0, 4).map(c => esc(c.name)).join('、')}${arr.length > 4 ? ' …' : ''}</div>
            </div>`;
        }).join('');

        let charCards = '';
        if (cur !== null && groups[cur]) {
          charCards = `
            <div style="margin-top:18px">
              <div class="row" style="margin-bottom:10px">
                <b style="font-size:13px;color:#b8c4ff">${esc(cur || '未分类')}</b>
                <span class="sub" style="margin:0">点角色切换选中</span>
                <span class="grow"></span>
                <button class="btn ghost sm" data-act="all">全选本类</button>
                <button class="btn ghost sm" data-act="none">清空本类</button>
              </div>
              <div class="pcards">
                ${groups[cur].map(c => `
                  <div class="pcard ${P.picked.includes(c.id) ? 'on' : ''}" data-cid="${c.id}">
                    <div class="pn">${esc(c.name)}</div>
                    <div class="pa">${esc((c.aliases || []).join(' / ') || '无别名')}</div>
                    <div class="pd">${esc(((c.blocks || {}).core || {}).text || '（未填核心档案）')}</div>
                  </div>`).join('')}
              </div>
            </div>`;
        }

      const roleRows = P.picked.map(cid => {
        const c = P.allChars.find(x => x.id === cid);
        if (!c) return '';
        const cur = (P.rolesById || {})[cid] || 'local';
        return `<label class="fld"><span>${esc(c.name)}</span>
          <select data-npcrole="${esc(cid)}">
            <option value="local" ${cur === 'local' ? 'selected' : ''}>本地角色（这个世界的居民）</option>
            <option value="teammate" ${cur === 'teammate' ? 'selected' : ''}>轮回者队友（和玩家一起来的）</option>
          </select></label>`;
      }).join('');
      body = `<div class="panel">
        <div class="ptitle">登场角色</div>
        <div class="psub">— 先选作品分类，再点角色（可多选）—</div>
        <div class="pcards">${catCards}</div>
        ${charCards}
        ${roleRows ? `<div class="pblock"><h3>身份定位</h3>${roleRows}</div>` : ''}
      </div>`;
      }
    }

    /* ── 第四步：开场白 ── */
    if (P.step === 4) {
      const custom = P.customOpening || '';
      body = `<div class="panel">
        <div class="ptitle">开场白</div>
        <div class="psub">— 戏从哪里开始 —</div>

        ${openings.length ? `
        <div class="pblock">
          <h3>预设开场</h3>
          ${openings.map((o, i) => `
            <label class="sw" style="display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border:1px solid ${P.opening === i ? 'var(--acc)' : '#262c3a'};border-radius:9px;margin-bottom:8px;cursor:pointer;background:${P.opening === i ? '#1b2233' : '#191d27'}">
              <input type="radio" name="op" value="${i}" ${P.opening === i ? 'checked' : ''} style="margin-top:3px">
              <span style="font-size:12.5px;line-height:1.7;color:#b9bfcc">${esc(o)}</span>
            </label>`).join('')}
        </div>` : ''}

        <div class="pblock">
          <h3>或者自己写一个</h3>
          <textarea id="customOp" style="min-height:100px" placeholder="写第一段，AI 会接着往下演…">${esc(custom)}</textarea>
          <div class="hint" style="margin-top:6px">填了这里就用你写的，不用上面的预设</div>
        </div>

        <div class="pblock">
          <h3>世界书（可多选，兼容已有世界书）</h3>
          <div style="padding:0 6px">
            <div class="row" style="margin-bottom:8px"><button class="btn ghost sm" id="wbAll">全选</button><button class="btn ghost sm" id="wbNone">全不选</button><span class="grow"></span><span class="hint" id="wbCnt"></span></div>
            ${(P.worldbooks || []).length ? (P.worldbooks || []).map(w => `
              <label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #262c3a;border-radius:8px;margin-bottom:6px;background:#191d27;cursor:pointer">
                <input type="checkbox" data-wb="${esc(w.id)}" ${P.wbIds.includes(w.id) ? 'checked' : ''}>
                <span style="font-size:12.5px;color:#b9bfcc">${esc(w.title || w.id)}</span>
              </label>`).join('') : '<div class="hint">世界书库是空的，先去「世界书」建一本。</div>'}
            <div class="hint" style="margin-top:6px">勾选的才会在本局注入；不勾就不生效。</div>
          </div>
        </div>
      </div>`;
    }

    /* ── 第五步：确认 ── */
    if (P.step === 5) {
      const pickedChars = P.allChars.filter(c => P.picked.includes(c.id));
      const finalOp = (P.customOpening || '').trim() || (openings[P.opening] || '');
      const roleLabel = roles.length
        ? (roles.find(r => r.key === P.role) || {}).label || P.role
        : '';

      const vrows = fields.map(f => {
        const v = P.values[f.key];
        if (!v) return '';
        return `<tr><td style="padding:4px 12px 4px 0;color:var(--muted);font-size:12.5px">${esc(f.label)}</td><td style="padding:4px 0;font-size:13px">${esc(v)}</td></tr>`;
      }).join('');

      body = `<div class="panel">
        <div class="ptitle">确认</div>
        <div class="psub">— 看一眼，没问题就开演 —</div>

        <div class="pblock">
          <h3>剧本</h3>
          <p style="text-align:center;font-size:15px;font-weight:600">${esc(s.name)}</p>
        </div>

        <div class="pblock">
          <h3>你的角色</h3>
          ${roleLabel ? `<p style="text-align:center;color:#b8c4ff">${esc(roleLabel)}</p>` : ''}
          <table style="margin:0 auto">${vrows || '<tr><td style="color:var(--muted);font-size:12.5px">（没有填写任何字段）</td></tr>'}</table>
        </div>

        <div class="pblock">
          <h3>登场角色（${pickedChars.length}）</h3>
          <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap">
            ${pickedChars.map(c => `<span class="chip"><b>${esc(c.name)}</b></span>`).join('') || '<span style="color:var(--muted);font-size:12.5px">（没有选择角色）</span>'}
          </div>
        </div>

        <div class="pblock">
          <h3>开场白${(P.customOpening || '').trim() ? '（你写的）' : '（预设）'}</h3>
          <p style="color:#b9bfcc;line-height:1.85">${esc(finalOp) || '（空，AI 自己起）'}</p>
        </div>
      </div>`;
    }

    /* ── 底部导航 ── */
    const navBtns = [];
    if (P.step > 1) navBtns.push(`<button class="btn ghost" data-nav="prev">← 上一步</button>`);
    navBtns.push(`<button class="btn ghost" data-nav="back">← 退出</button>`);
    if (P.step < 5) navBtns.push(`<button class="btn" data-nav="next">下一步 →</button>`);
    else navBtns.push(`<button class="btn" data-nav="start">开始演绎 →</button>`);

    main.innerHTML = `
      <div class="steps" id="stepBar" style="cursor:default">
        ${stepsHtml}
      </div>
      ${body}
      <div class="row" style="margin-top:4px">
        ${navBtns.join('')}
        <span class="grow"></span>
        <span class="sub" id="chk" style="margin:0"></span>
      </div>
    `;

    /* ══ 绑事件 ══ */

    // 步骤条可点（只能往前或已完成的）
    $$('#stepBar .s').forEach(el => {
      el.style.cursor = 'pointer';
      el.onclick = () => {
        const n = +el.dataset.step;
        if (n <= P.step) { saveFields(); P.step = n; drawPrep(); }
      };
    });

    // 第二步：字段缓存
    function saveFields() {
      $$('[data-fk]').forEach(el => { P.values[el.dataset.fk] = el.value; });
    }
    $$('[data-fk]').forEach(el => el.addEventListener('input', () => { P.values[el.dataset.fk] = el.value; }));
    $$('input[name="role"]').forEach(r => r.onchange = () => (P.role = r.value));

    // 第三步：分类 / 角色
    $$('#main .pcard[data-cat]').forEach(card => {
      card.onclick = () => {
        const cn = card.dataset.cat;
        P.openCat = (P.openCat === cn) ? null : cn;
        drawPrep();
      };
    });
    $$('[data-npcrole]').forEach(sel => sel.onchange = () => { P.rolesById[sel.dataset.npcrole] = sel.value; });
    $$('#main .pcard[data-cid]').forEach(card => {
      card.onclick = () => {
        const cid = card.dataset.cid;
        const i = P.picked.indexOf(cid);
        if (i >= 0) P.picked.splice(i, 1); else P.picked.push(cid);
        drawPrep();
      };
    });
    $$('#main button[data-act="all"]').forEach(b => {
      b.onclick = () => {
        const arr = P.allChars.filter(c => (c._category || '') === P.openCat);
        for (const c of arr) if (!P.picked.includes(c.id)) P.picked.push(c.id);
        drawPrep();
      };
    });
    $$('#main button[data-act="none"]').forEach(b => {
      b.onclick = () => {
        const ids = P.allChars.filter(c => (c._category || '') === P.openCat).map(c => c.id);
        P.picked = P.picked.filter(x => !ids.includes(x));
        drawPrep();
      };
    });

    // 第四步：开场白
    $$('input[name="op"]').forEach(r => r.onchange = () => (P.opening = +r.value));
    const co = $('#customOp');
    if (co) co.addEventListener('input', () => (P.customOpening = co.value));
    const syncWb = () => {
      P.wbIds = $$('[data-wb]').filter(x => x.checked).map(x => x.dataset.wb);
      const cnt = $('#wbCnt'); if (cnt) cnt.textContent = '已选 ' + P.wbIds.length + ' 本';
    };
    $$('[data-wb]').forEach(cb => cb.onchange = syncWb);
    const wbAll = $('#wbAll'), wbNone = $('#wbNone');
    if (wbAll) wbAll.onclick = () => { $$('[data-wb]').forEach(x => x.checked = true); syncWb(); };
    if (wbNone) wbNone.onclick = () => { $$('[data-wb]').forEach(x => x.checked = false); syncWb(); };
    syncWb();

    // 计数
    function updateChk() {
      const el = $('#chk');
      if (!el) return;
      if (P.step === 3) el.textContent = `已选 ${P.picked.length} 个登场角色`;
      else if (P.step === 2) el.textContent = `已填 ${Object.values(P.values).filter(Boolean).length} 项`;
      else el.textContent = '';
    }
    updateChk();

    // 导航
    $$('[data-nav]').forEach(b => {
      b.onclick = async () => {
        const act = b.dataset.nav;
        if (act === 'back') { if (confirm('退出配置？')) setView('scripts'); return; }
        if (act === 'prev') { saveFields(); P.step = Math.max(1, P.step - 1); drawPrep(); return; }
        if (act === 'next') {
          saveFields();
          // 校验
          if (P.step === 2) {
            const reqFields = (s.player_fields || []).filter(f => f.required);
            for (const f of reqFields) {
              if (!P.values[f.key]) return toast('「' + f.label + '」必填', 'err');
            }
          }
          P.step = Math.min(5, P.step + 1);
          drawPrep();
          return;
        }
        if (act === 'start') {
          await doStart();
        }
      };
    });

    async function doStart() {
      const finalOp = (P.customOpening || '').trim() || (openings[P.opening] || '');
      const player = Object.assign({}, P.values);
      const pname = player.name || player['姓名'] || '';
      const title = (pname || '新玩家') + ' · ' + s.name;

      try {
        const sess = await api('/sessions', {
          method: 'POST',
          body: {
            script_id: s.id,
            script_name: s.name,
            title,
            player,
            role_choice: P.role,
            active_npcs: P.picked,
            opening_index: P.opening,
            worldbook_ids: P.wbIds || [],
            npc_roles: P.rolesById || {},
            custom_opening: (P.customOpening || '').trim(),
            history: [],
          },
        });
        state.chat = {
          scriptId: s.id,
          sessionId: sess.id,
          msgs: [],
          busy: false,
          cast: P.picked,
          customOpening: (P.customOpening || '').trim(),
        };
        if (finalOp) state.chat.msgs.push({ role: 'assistant', content: finalOp });
        setView('chat');
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  /* ═══════════ 角色库 ═══════════ */
  const BLOCKS = [
    { k: 'core', label: '核心档案', hint: '外貌+性格+说话方式，精简到 200 字内。永远注入。' },
    { k: 'speech', label: '说话样本', hint: '口头禅、例句、语气。会注入精简版。' },
    { k: 'appearance', label: '外貌详述', hint: '提到外貌/穿着时才注入。' },
    { k: 'history', label: '过往经历', hint: '提到往事时才注入。' },
    { k: 'relations', label: '人际关系', hint: '提到其他人时才注入。' },
    { k: 'kinks', label: '癖好与敏感点', hint: '按需注入。' },
    { k: 'secrets', label: '秘密', hint: 'AI 知道但不能说。' },
  ];

  async function renderCharacters() {
    const [list, cats] = await Promise.all([api('/characters'), api('/categories')]);
    state.cache.characters = list;
    state.cache.cats = cats;

    main.innerHTML = `
      <h1>角色库</h1>
      <div class="sub">独立角色档案。按作品分类，分类可整组开关。</div>

      <div class="row" style="margin-bottom:14px">
        <button class="btn" id="newChar">＋ 新建角色</button>
        <button class="btn ghost" id="impChar">↑ 导入</button>
        <button class="btn ghost" id="expChar">↓ 导出</button>
        <input type="file" id="fileIn" accept=".json" style="display:none">
        <span class="grow"></span>
        <span class="sub" style="margin:0">共 ${list.length} 个角色</span>
      </div>

      <div style="background:#161922;border:1px solid var(--line);border-radius:10px;padding:5px 0;margin-bottom:16px" id="catBar"></div>

      <div class="row" style="margin-bottom:12px">
        <input id="q" placeholder="搜名字或别名…" style="flex:0 0 260px">
        <span class="grow"></span>
      </div>
      <div id="charList"></div>
    `;

    /* 分类条 */
    function drawCats() {
      const bar = $('#catBar');
      if (!cats.length) {
        bar.innerHTML = `<div style="padding:12px 15px;color:#5f6675;font-size:12.5px">还没有分类。导入带 category 的 JSON，或新建角色时填分类。</div>`;
        return;
      }
      bar.innerHTML = cats.map(c => `
        <div class="mrow" style="padding:9px 15px">
          <label class="sw" style="flex:0 0 auto">
            <input type="checkbox" data-cat="${esc(c.name)}" ${c.enabled ? 'checked' : ''}>
            <span class="dot"></span>
          </label>
          <div class="nm">
            <b>${esc(c.name || '（未分类）')}</b>
            <p>${c.count} 个角色 · ${c.enabled ? '启用中' : '已关闭'}</p>
          </div>
        </div>`).join('');
      $$('#catBar input[data-cat]').forEach(cb => {
        cb.onchange = async () => {
          await api('/categories', { method: 'POST', body: { name: cb.dataset.cat, value: cb.checked } });
          toast((cb.dataset.cat || '未分类') + (cb.checked ? ' 已启用' : ' 已关闭'), 'ok');
          renderCharacters();
        };
      });
    }
    drawCats();

    /* 角色列表 */
    const box = $('#charList');
    function draw(filter = '') {
      const f = filter.trim().toLowerCase();
      const arr = f
        ? list.filter(c => (c.name || '').toLowerCase().includes(f) || (c.aliases || []).some(a => a.toLowerCase().includes(f)))
        : list;
      if (!arr.length) {
        box.innerHTML = `<div class="empty">${f ? '没搜到' : '角色库还是空的。<br>点「＋ 新建角色」或「↑ 导入」。'}</div>`;
        return;
      }
      // 按分类分组
      const groups = {};
      for (const c of arr) {
        const k = c._category || '';
        (groups[k] = groups[k] || []).push(c);
      }
      box.innerHTML = Object.keys(groups).sort().map(cat => `
        <div style="margin-bottom:20px">
          <div class="row" style="margin-bottom:9px">
            <b style="font-size:13px;color:#b8c4ff">${esc(cat || '（未分类）')}</b>
            <span class="sub" style="margin:0">${groups[cat].length} 个</span>
          </div>
          <div class="cards">${groups[cat].map(c => {
            const total = Object.values(c.blocks || {}).reduce((s, b) => s + ((b && b.text) || '').length, 0);
            return `
            <div class="card" data-id="${c.id}">
              <div class="acts">
                <button class="btn ghost sm" data-act="edit">编辑</button>
                <button class="btn danger" data-act="del">删</button>
              </div>
              <h3>${esc(c.name || '未命名')}</h3>
              <p>${esc(((c.blocks || {}).core || {}).text || '（核心档案未填）')}</p>
              <div class="meta">${total} 字</div>
            </div>`;
          }).join('')}</div>
        </div>`).join('');
    }
    draw();
    $('#q').oninput = e => draw(e.target.value);

    /* 按钮 */
    $('#newChar').onclick = () => openCharEditor(null);

    $('#expChar').onclick = async () => {
      try {
        const r = await api('/export?kind=characters');
        const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'characters_' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('已导出 ' + r.count + ' 个角色', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };

    $('#impChar').onclick = () => $('#fileIn').click();
    $('#fileIn').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const txt = await f.text();
        const j = JSON.parse(txt);
        const items = j.characters || j.items || (Array.isArray(j) ? j : []);
        if (!items.length) return toast('文件里没有角色数据', 'err');
        const r = await api('/import/characters', { method: 'POST', body: { characters: items } });
        toast(`导入完成：新增 ${r.created.length}，更新 ${r.updated.length}，失败 ${r.failed.length}`, 'ok');
        renderCharacters();
      } catch (e) { toast('导入失败：' + e.message, 'err'); }
    };

    box.addEventListener('click', async e => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id, act = e.target.dataset.act;
      if (act === 'edit') return openCharEditor(id);
      if (act === 'del') {
        if (!confirm('删除这个角色？')) return;
        await api('/characters/' + id, { method: 'DELETE' });
        toast('已删除', 'ok');
        return renderCharacters();
      }
      openCharEditor(id);
    });
  }

  async function openCharEditor(id) {
    const [c, cats] = await Promise.all([
      id ? api('/characters/' + id) : Promise.resolve({
        name: '', aliases: [], _category: '',
        profile: {}, blocks: {}, matrix: {}, body_data: {},
        kinks: [], positions: [], outfits: [], initial_state: {},
      }),
      api('/categories'),
    ]);
    const prof = c.profile || {};
    const blocks = c.blocks || {};
    const matrix = c.matrix || {};
    const bd = c.body_data || {};
    const init = c.initial_state || {};
    const curCat = c._category || '';

    // 身体特征 4 部位（核心 3 + 嘴可选）——与后端 pick_char_blocks 一致
    const PART_ORDER = ['pussy', 'breast', 'ass', 'mouth'];
    const PART_NAMES = { pussy: '小穴', breast: '胸', ass: '臀', mouth: '嘴' };
    const MATRIX_KEYS = [
      ['to_user_low', '对玩家（尚不亲近）'],
      ['to_user_mid', '对玩家（已亲近）'],
      ['to_user_peak', '对玩家（深爱）'],
      ['to_outsider', '对外人'],
      ['to_confidant', '对心腹'],
      ['on_bed', '床上'],
    ];

    const kinksTxt = (c.kinks || []).map(k => typeof k === 'object'
      ? (`${k.code || ''} ${k.name || ''}${k.note ? '（' + k.note + '）' : ''}`).trim() : String(k)).join('\n');
    const posTxt = (c.positions || []).map(k => typeof k === 'object'
      ? (`${k.code || ''} ${k.name || ''}${k.note ? '（' + k.note + '）' : ''}`).trim() : String(k)).join('\n');
    const outfitsTxt = (c.outfits || []).map(o =>
      `${o.name || ''}|${o.desc || ''}|${o.key || ''}${o.default ? '|default' : ''}`).join('\n');

    main.innerHTML = `
      <h1>${id ? '编辑角色' : '新建角色'}</h1>
      <div class="sub">分块存；这里看到的就是保存后的内容——清空＝删除该字段（编辑器没展示的字段不受影响）。</div>

      <div class="row" style="margin-bottom:14px">
        <input id="c_name" value="${esc(c.name)}" placeholder="角色名 *" style="flex:0 0 190px">
        <input id="c_alias" value="${esc((c.aliases || []).join(','))}" placeholder="别名，逗号分隔" style="flex:1">
      </div>

      <label class="fld"><span>作品分类（决定存在哪个文件夹）</span>
        <div class="row">
          <input id="c_cat" value="${esc(curCat)}" placeholder="例：碧蓝航线（留空＝未分类）" style="flex:1">
          <select id="c_catPick" style="flex:0 0 180px">
            <option value="">— 选已有分类 —</option>
            ${cats.filter(x => x.name).map(x => `<option value="${esc(x.name)}">${esc(x.name)}（${x.count}）</option>`).join('')}
          </select>
        </div>
      </label>

      <details open style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">① 基本信息（profile）</summary>
        <div style="margin-top:10px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
          <label class="fld"><span>性别</span><input data-p="gender" value="${esc(prof.gender || '')}"></label>
          <label class="fld"><span>年龄</span><input data-p="age" value="${esc(prof.age || '')}"></label>
          <label class="fld"><span>身高</span><input data-p="height" value="${esc(prof.height || '')}" placeholder="180cm"></label>
          <label class="fld"><span>体重</span><input data-p="weight" value="${esc(prof.weight || '')}" placeholder="74kg"></label>
          <label class="fld"><span>体型</span><input data-p="body_type" value="${esc(prof.body_type || '')}" placeholder="丰满熟女"></label>
          <label class="fld"><span>气质</span><input data-p="qizhi" value="${esc(prof.qizhi || '')}" placeholder="御姐/熟女/少女/萝莉"></label>
          <label class="fld"><span>三围</span><input data-p="measurements" value="${esc(prof.measurements || '')}"></label>
          <label class="fld"><span>press</span><input data-p="press" type="number" value="${prof.press != null ? prof.press : ''}" placeholder="20"></label>
          <label class="fld"><span>原型</span><input data-p="archetype" value="${esc(prof.archetype || '')}" placeholder="mother/dom/imp..."></label>
        </div>
        <label class="fld"><span>外貌</span><textarea data-p="appearance" style="min-height:60px">${esc(prof.appearance || '')}</textarea></label>
        <label class="fld"><span>性格</span><textarea data-p="personality" style="min-height:50px">${esc(prof.personality || '')}</textarea></label>
        <label class="fld"><span>身份</span><textarea data-p="identity" style="min-height:40px">${esc(prof.identity || '')}</textarea></label>
        <label class="fld"><span>背景</span><textarea data-p="background" style="min-height:50px">${esc(prof.background || '')}</textarea></label>
      </details>

      <details open style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">② 核心档案（永远注入 / 关键词触发）</summary>
        <div style="margin-top:10px">
          ${BLOCKS.map(b => `
            <label class="fld"><span>${b.label} <em style="color:#5f6675;font-style:normal">— ${b.hint}</em></span>
              <textarea data-block="${b.k}" style="min-height:${b.k === 'core' ? 80 : 68}px">${esc((blocks[b.k] || {}).text || '')}</textarea>
            </label>`).join('')}
        </div>
      </details>

      <details style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">③ 人格矩阵（6 档）</summary>
        <div style="margin-top:10px">
          ${MATRIX_KEYS.map(([k, label]) => `
            <label class="fld"><span>${label}</span>
              <textarea data-m="${k}" style="min-height:50px">${esc(matrix[k] || '')}</textarea>
            </label>`).join('')}
        </div>
      </details>

      <details style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">④ 身体特征（4 部位：小穴/胸/臀 + 嘴，床戏轮注入）</summary>
        <div style="margin-top:10px">
          ${PART_ORDER.map(k => {
            const v = bd[k] || {};
            return `<div style="margin-bottom:8px;padding:8px;background:var(--bg3);border-radius:6px">
              <div style="font-weight:600;color:#7c9cff;font-size:12px;margin-bottom:4px">${PART_NAMES[k]}</div>
              <input data-bd="${k}.name" value="${esc(v.name || '')}" placeholder="名器名（可选）" style="width:100%;margin-bottom:4px">
              <textarea data-bd="${k}.text" style="min-height:44px" placeholder="具体特征：胸多大、敏感不敏感…">${esc(v.text || '')}</textarea>
            </div>`;
          }).join('')}
        </div>
      </details>

      <details style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">⑤ 性癖 / 体位（每行一条：编号 名字（备注））</summary>
        <div style="margin-top:10px">
          <label class="fld"><span>性癖</span><textarea data-list="kinks" style="min-height:70px">${esc(kinksTxt)}</textarea></label>
          <label class="fld"><span>体位</span><textarea data-list="positions" style="min-height:70px">${esc(posTxt)}</textarea></label>
        </div>
      </details>

      <details style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">⑥ 衣着（每行：名字|描述|机关|default）</summary>
        <div style="margin-top:10px">
          <label class="fld"><span>衣着列表</span><textarea data-list="outfits" style="min-height:90px" placeholder="黑铁军装|立领双排金扣...|袜口与衩口|default">${esc(outfitsTxt)}</textarea></label>
        </div>
      </details>

      <details style="margin:12px 0;padding:12px;background:var(--bg2);border:1px solid var(--line);border-radius:9px">
        <summary style="cursor:pointer;color:#7c9cff;font-weight:600">⑦ 初始状态（建会话时的起点）</summary>
        <div style="margin-top:10px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
          <label class="fld"><span>♥心</span><input data-i="heart" type="number" value="${init.heart != null ? init.heart : 0}"></label>
          <label class="fld"><span>♠体</span><input data-i="body" type="number" value="${init.body != null ? init.body : 0}"></label>
          <label class="fld"><span>心注解</span><input data-i="heart_note" value="${esc(init.heart_note || '')}"></label>
          <label class="fld"><span>体注解</span><input data-i="body_note" value="${esc(init.body_note || '')}"></label>
          <label class="fld"><span>初始衣着</span><input data-i="outfit" value="${esc(init.outfit || '')}"></label>
          <label class="fld"><span>初始位置</span><input data-i="location" value="${esc(init.location || '')}"></label>
          <label class="fld"><span>初始心情</span><input data-i="mood" value="${esc(init.mood || '')}"></label>
          <label class="fld"><span>内心独白</span><input data-i="inner_voice" value="${esc(init.inner_voice || '')}"></label>
          <label class="fld"><span>状态</span>
            <div class="row" style="gap:10px;font-size:12px;align-items:center">
              <label style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-i="womb_broken" ${init.womb_broken ? 'checked' : ''}> 破宫</label>
              <label style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-i="married" ${init.married ? 'checked' : ''}> 已婚</label>
              <label style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-i="pregnant" ${init.pregnant ? 'checked' : ''}> 孕子</label>
            </div>
          </label>
        </div>
      </details>

      <div class="row" style="margin-top:20px">
        <button class="btn" id="save">保存</button>
        <button class="btn ghost" id="cancel">取消</button>
        <span class="grow"></span>
        <span class="sub" id="cnt" style="margin:0">0 字</span>
      </div>
    `;

    $('#c_catPick').onchange = e => { if (e.target.value) $('#c_cat').value = e.target.value; };

    const cnt = $('#cnt');
    const upd = () => {
      let n = 0;
      main.querySelectorAll('textarea, input').forEach(t => (n += (t.value || '').length));
      cnt.textContent = n + ' 字';
    };
    main.querySelectorAll('textarea, input').forEach(t => t.addEventListener('input', upd));
    upd();

    $('#cancel').onclick = () => setView('characters');
    $('#save').onclick = async () => {
      // 保存原则：编辑器里看到的就是存进去的——清空 = 删除该字段；
      // 编辑器没有展示的字段（如 press_reason、未展示的身体部位）原样保留。
      // ① profile
      const newProf = Object.assign({}, prof);
      $$('[data-p]').forEach(el => {
        const k = el.dataset.p;
        const v = el.value.trim();
        if (v === '') { delete newProf[k]; return; }
        newProf[k] = (k === 'press') ? Number(v) : v;
      });
      // ② blocks —— 清空 = 删除该块
      const nb = Object.assign({}, blocks);
      $$('textarea[data-block]').forEach(t => {
        const k = t.dataset.block;
        const v = t.value.trim();
        if (v) nb[k] = Object.assign({}, nb[k] || {}, { text: v });
        else delete nb[k];
      });
      // ③ matrix —— 清空 = 删除该档
      const newMatrix = {};
      $$('textarea[data-m]').forEach(t => {
        const v = t.value.trim();
        if (v) newMatrix[t.dataset.m] = v;
      });
      // ④ body_data —— 清空 = 删除该字段；部位全空则整个删掉
      const newBd = {};
      Object.keys(bd || {}).forEach(k => {
        newBd[k] = (bd[k] && typeof bd[k] === 'object') ? Object.assign({}, bd[k]) : bd[k];
      });
      $$('[data-bd]').forEach(el => {
        const [part, field] = el.dataset.bd.split('.');
        newBd[part] = newBd[part] || {};
        const v = el.value.trim();
        if (v) newBd[part][field] = v;
        else delete newBd[part][field];
      });
      PART_ORDER.forEach(k => { if (newBd[k] && !Object.keys(newBd[k]).length) delete newBd[k]; });
      // ⑤ 性癖 / 体位（每行：编号 名字（备注））—— 清空 = 清空列表
      function parseKinks(txt) {
        return (txt || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
          const m = line.match(/^([A-Za-z0-9]+)\s+(.+?)(?:[（(](.+)[）)])?$/);
          if (m) return { code: m[1], name: m[2].trim(), note: m[3] || '' };
          return { name: line };
        });
      }
      const kinks = parseKinks($('textarea[data-list="kinks"]').value);
      const positions = parseKinks($('textarea[data-list="positions"]').value);
      // ⑥ 衣着（每行：名字|描述|机关|default）—— 清空 = 清空列表
      const outfits = ($('textarea[data-list="outfits"]').value || '').split('\n')
        .map(s => s.trim()).filter(Boolean).map(line => {
          const parts = line.split('|').map(s => s.trim());
          const o = { name: parts[0] || '', desc: parts[1] || '', key: parts[2] || '' };
          if (/default|默认/i.test(parts[3] || '')) o.default = true;
          return o;
        });
      // ⑦ initial_state —— 清空 = 删除该字段
      const newInit = Object.assign({}, init);
      $$('[data-i]').forEach(el => {
        const k = el.dataset.i;
        if (el.type === 'checkbox') { newInit[k] = el.checked; return; }
        const v = el.value.trim();
        if (v === '') { delete newInit[k]; return; }
        newInit[k] = (k === 'heart' || k === 'body') ? Number(v) : v;
      });
      const data = {
        name: $('#c_name').value.trim(),
        aliases: $('#c_alias').value.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean),
        _category: $('#c_cat').value.trim(),
        profile: newProf,
        blocks: nb,
        matrix: newMatrix,
        body_data: newBd,
        initial_state: newInit,
        kinks, positions, outfits,
      };
      if (!data.name) return toast('名字不能空', 'err');
      try {
        if (id) await api('/characters/' + id, { method: 'PUT', body: data });
        else await api('/characters', { method: 'POST', body: data });
        toast('已保存', 'ok');
        setView('characters');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ═══════════ 世界书 ═══════════ */
  async function renderWorldbook() {
    const list = await api('/worldbook');
    state.cache.worldbook = list;
    main.innerHTML = `
      <h1>世界书</h1>
      <div class="sub">剧本的支线资料。命中关键词才注入，不命中不花钱。</div>
      <div class="row" style="margin-bottom:16px">
        <button class="btn" id="newWb">＋ 新建条目</button>
        <button class="btn ghost sm" id="enAll">全部启用</button>
        <button class="btn ghost sm" id="disAll">全部停用</button>
        <span class="grow"></span>
        <span class="sub" style="margin:0">共 ${list.length} 条</span>
      </div>
      <div class="cards" id="wbList"></div>
    `;
    $('#newWb').onclick = () => openWbEditor(null);
    $('#enAll').onclick = () => bulkToggle('worldbook', list, true);
    $('#disAll').onclick = () => bulkToggle('worldbook', list, false);

    const box = $('#wbList');
    function draw() {
      if (!list.length) {
        box.innerHTML = `<div class="empty">还没有世界书条目。</div>`;
        return;
      }
      box.innerHTML = list.map(w => `
        <div class="card" data-id="${w.id}">
          <div class="acts">
            <button class="btn ghost sm" data-act="edit">编辑</button>
            <button class="btn danger" data-act="del">删</button>
          </div>
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <h3 style="margin:0">${esc(w.title || '未命名')}</h3>
            <label class="sw" style="flex:0 0 auto">
              <input type="checkbox" data-tog="${w.id}" ${w.enabled !== false ? 'checked' : ''}>
              <span class="dot"></span>
            </label>
          </div>
          <p><b style="color:#9db4ff">${esc((w.keys || []).join('、') || '（无关键词）')}</b></p>
          <p style="margin-top:6px">${esc((w.content || '').slice(0, 46))}</p>
        </div>`).join('');
      $$('#wbList input[data-tog]').forEach(cb => {
        cb.onchange = async () => {
          const wid = cb.dataset.tog;
          await api('/worldbook/' + wid, { method: 'PUT', body: { enabled: cb.checked } });
          const it = list.find(x => x.id === wid);
          if (it) it.enabled = cb.checked;
          toast(cb.checked ? '已启用' : '已停用', 'ok');
        };
      });
    }
    draw();

    box.addEventListener('click', async e => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id, act = e.target.dataset.act;
      if (act === 'edit') return openWbEditor(id);
      if (act === 'del') {
        if (!confirm('删除这条？')) return;
        await api('/worldbook/' + id, { method: 'DELETE' });
        toast('已删除', 'ok');
        return renderWorldbook();
      }
    });
  }

  async function bulkToggle(kind, list, on) {
    for (const it of list) {
      await api(`/${kind}/${it.id}`, { method: 'PUT', body: { enabled: on } });
    }
    toast(on ? '全部启用' : '全部停用', 'ok');
    setView(state.view);
  }

  async function openWbEditor(id) {
    const w = id ? await api('/worldbook/' + id) : { title: '', keys: [], content: '', enabled: true };
    main.innerHTML = `
      <h1>${id ? '编辑条目' : '新建条目'}</h1>
      <label class="fld"><span>标题</span><input id="w_t" value="${esc(w.title)}" placeholder="例：47 层办公室"></label>
      <label class="fld"><span>关键词（逗号分隔，不要用「你」「我」这种万能词）</span><input id="w_k" value="${esc((w.keys || []).join(','))}" placeholder="办公室,47层,她的桌子"></label>
      <label class="fld"><span>内容（命中时插入）</span><textarea id="w_c" style="min-height:200px">${esc(w.content)}</textarea></label>
      <label class="fld"><span>状态</span>
        <label class="sw"><input type="checkbox" id="w_en" ${w.enabled !== false ? 'checked' : ''}><span class="dot"></span>启用</label>
      </label>
      <div class="row">
        <button class="btn" id="save">保存</button>
        <button class="btn ghost" id="cancel">取消</button>
      </div>
    `;
    $('#cancel').onclick = () => setView('worldbook');
    $('#save').onclick = async () => {
      const data = {
        title: $('#w_t').value.trim(),
        keys: $('#w_k').value.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean),
        content: $('#w_c').value,
        enabled: $('#w_en').checked,
      };
      if (!data.title) return toast('标题不能空', 'err');
      try {
        if (id) await api('/worldbook/' + id, { method: 'PUT', body: data });
        else await api('/worldbook', { method: 'POST', body: data });
        toast('已保存', 'ok');
        setView('worldbook');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ═══════════ MOD ═══════════ */
  async function renderMods() {
    const list = await api('/mods');
    state.cache.mods = list;
    main.innerHTML = `
      <h1>MOD</h1>
      <div class="sub">一段可插拔的提示词。勾上就进 prompt，顺序决定优先级（上面的更硬）。</div>
      <div class="row" style="margin-bottom:16px">
        <button class="btn" id="newMod">＋ 新建 MOD</button>
        <button class="btn ghost sm" id="enAll">全部启用</button>
        <button class="btn ghost sm" id="disAll">全部停用</button>
        <span class="grow"></span>
        <span class="sub" style="margin:0">共 ${list.length} 个</span>
      </div>
      <div class="cards" id="modList"></div>
    `;
    $('#newMod').onclick = () => openModEditor(null);
    $('#enAll').onclick = () => bulkToggle('mods', list, true);
    $('#disAll').onclick = () => bulkToggle('mods', list, false);

    const box = $('#modList');
    if (!list.length) {
      box.innerHTML = `<div class="empty">还没有 MOD。</div>`;
    } else {
      box.innerHTML = list.map(m => `
        <div class="card" data-id="${m.id}">
          <div class="acts">
            <button class="btn ghost sm" data-act="edit">编辑</button>
            <button class="btn danger" data-act="del">删</button>
          </div>
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <h3 style="margin:0">${esc(m.name || '未命名')}</h3>
            <label class="sw" style="flex:0 0 auto">
              <input type="checkbox" data-tog="${m.id}" ${m.enabled ? 'checked' : ''}>
              <span class="dot"></span>
            </label>
          </div>
          <p>${esc((m.content || '').slice(0, 56) || '（空）')}</p>
          <div class="meta">${esc(m.group || '未分组')} · ${m.scope === 'script' ? '专用' : (m.scope === 'all' ? '全剧本' : '公用')} · ${(m.content || '').length} 字</div>
        </div>`).join('');
      $$('#modList input[data-tog]').forEach(cb => {
        cb.onchange = async () => {
          const mid = cb.dataset.tog;
          await api('/mods/' + mid, { method: 'PUT', body: { enabled: cb.checked } });
          const it = list.find(x => x.id === mid);
          if (it) it.enabled = cb.checked;
          toast(cb.checked ? '已启用' : '已停用', 'ok');
        };
      });
    }

    box.addEventListener('click', async e => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id, act = e.target.dataset.act;
      if (act === 'edit') return openModEditor(id);
      if (act === 'del') {
        if (!confirm('删除这个 MOD？')) return;
        await api('/mods/' + id, { method: 'DELETE' });
        toast('已删除', 'ok');
        return renderMods();
      }
    });
  }

  async function openModEditor(id) {
    const m = id ? await api('/mods/' + id) : { name: '', group: '通用', content: '', enabled: true };
    main.innerHTML = `
      <h1>${id ? '编辑 MOD' : '新建 MOD'}</h1>
      <div class="row" style="margin-bottom:14px">
        <input id="m_n" value="${esc(m.name)}" placeholder="名称 *" style="flex:1">
        <input id="m_g" value="${esc(m.group || '通用')}" placeholder="分组" style="flex:0 0 160px">
      </div>
      <label class="fld"><span>内容（提示词正文）</span><textarea id="m_c" style="min-height:340px">${esc(m.content)}</textarea></label>
      <label class="fld"><span>状态</span>
        <label class="sw"><input type="checkbox" id="m_en" ${m.enabled ? 'checked' : ''}><span class="dot"></span>启用</label>
      </label>
      <div class="row">
        <button class="btn" id="save">保存</button>
        <button class="btn ghost" id="cancel">取消</button>
        <span class="grow"></span>
        <span class="sub" id="cnt" style="margin:0">0 字</span>
      </div>
    `;
    const cnt = $('#cnt'), ta = $('#m_c');
    const upd = () => (cnt.textContent = ta.value.length + ' 字');
    ta.addEventListener('input', upd); upd();
    $('#cancel').onclick = () => setView('mods');
    $('#save').onclick = async () => {
      const data = {
        name: $('#m_n').value.trim(),
        group: $('#m_g').value.trim() || '通用',
        content: $('#m_c').value,
        enabled: $('#m_en').checked,
      };
      if (!data.name) return toast('名称不能空', 'err');
      try {
        if (id) await api('/mods/' + id, { method: 'PUT', body: data });
        else await api('/mods', { method: 'POST', body: data });
        toast('已保存', 'ok');
        setView('mods');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ═══════════ 设置 ═══════════ */
  async function renderSettings() {
    const cfg = await api('/settings');
    state.settings = cfg;
    const isOllama = (cfg.provider || 'ollama') === 'ollama';
    main.innerHTML = `
      <h1>设置</h1>
      <div class="sub">选一个模型来源。Ollama 本地不花钱，DeepSeek API 质量最好。</div>
      <div class="tabs">
        <button data-p="ollama" class="${isOllama ? 'on' : ''}">本地 Ollama</button>
        <button data-p="api" class="${!isOllama ? 'on' : ''}">API（OpenAI 兼容）</button>
      </div>
      <div id="pane"></div>
      <div class="row" style="margin-top:18px">
        <button class="btn" id="save">保存</button>
        <button class="btn ghost" id="test">测试连接</button>
      </div>
      <div class="hint" id="effModel" style="margin-top:6px">服务端当前生效：${esc(cfg.provider === 'ollama' ? cfg.ollama_model : cfg.api_model)}（保存后以这里为准）</div>
      <div class="hint" id="testOut"></div>
    `;
    const pane = $('#pane');
    let provider = cfg.provider || 'ollama';

    function drawPane() {
      if (provider === 'ollama') {
        pane.innerHTML = `
          <label class="fld"><span>Ollama 地址</span><input id="c_url" value="${esc(cfg.ollama_url)}"></label>
          <label class="fld"><span>模型名</span><input id="c_model" value="${esc(cfg.ollama_model)}"></label>`;
      } else {
        const KNOWN = ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-reasoner'];
        const isKnown = KNOWN.includes(cfg.api_model);
        pane.innerHTML = `
          <label class="fld"><span>API 地址</span><input id="c_apurl" value="${esc(cfg.api_url)}"></label>
          <label class="fld"><span>API Key</span><input id="c_key" type="password" value="${esc(cfg.api_key)}"></label>
          <label class="fld"><span>模型</span>
            <select id="c_apmodel">
              <option value="deepseek-chat" ${cfg.api_model === 'deepseek-chat' ? 'selected' : ''}>deepseek-chat（通用对话，快，推荐）</option>
              <option value="deepseek-flash" ${cfg.api_model === 'deepseek-flash' ? 'selected' : ''}>deepseek-flash（最快，轻度思考）</option>
              <option value="deepseek-v4-pro" ${cfg.api_model === 'deepseek-v4-pro' ? 'selected' : ''}>deepseek-v4-pro（强推理，慢约10倍、贵5-10倍）</option>
              <option value="__custom__" ${!isKnown ? 'selected' : ''}>自定义…</option>
            </select>
            <input id="c_apmodel_custom" placeholder="自定义模型名" value="${esc(cfg.api_model)}" style="margin-top:6px;${!isKnown ? '' : 'display:none'}">
          </label>
          <div class="hint">实测：chat 约 2 秒/百字；flash 约 1.5 秒；v4-pro 约 25 秒/百字（思考极长）。跑团实时生成建议 chat 或 flash，v4-pro 适合不赶时间、追求细节时。</div>`;
        $('#c_apmodel').onchange = () => {
          const isCustom = $('#c_apmodel').value === '__custom__';
          $('#c_apmodel_custom').style.display = isCustom ? '' : 'none';
        };
      }
    }
    drawPane();

    $$('.tabs button').forEach(b => {
      b.onclick = () => {
        provider = b.dataset.p === 'ollama' ? 'ollama' : 'api';
        $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
        drawPane();
      };
    });

    $('#save').onclick = async () => {
      const body = { provider, temperature: 0.85, max_tokens: 8192 };
      if (provider === 'ollama') {
        body.ollama_url = $('#c_url').value.trim();
        body.ollama_model = $('#c_model').value.trim();
      } else {
        body.api_url = $('#c_apurl').value.trim();
        body.api_key = $('#c_key').value;
        const sel = $('#c_apmodel').value;
        body.api_model = (sel === '__custom__') ? $('#c_apmodel_custom').value.trim() : sel;
      }
      try {
        await api('/settings', { method: 'POST', body });
        const fresh = await api('/settings');
        const cur = fresh.provider === 'ollama' ? fresh.ollama_model : fresh.api_model;
        const el = $('#effModel');
        if (el) el.textContent = '服务端当前生效：' + cur + '（已写入 config.json）';
        toast('已保存 · 当前生效模型：' + cur, 'ok');
      }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#test').onclick = async () => {
      $('#testOut').textContent = '测试中…';
      try {
        const r = await api('/test', { method: 'POST', body: {} });
        $('#testOut').textContent = '✓ 通了：' + r.reply;
      } catch (e) { $('#testOut').textContent = '✗ ' + e.message; }
    };
  }

  /* ═══════════ 聊天（三栏 + 正文 + 选项 + 右侧面板）═══════════ */
  const WORD_PRESETS = [800, 1500, 2000, 3000, 5000, 8000, 10000];

  async function renderChat() {
    if (!state.chat.scriptId) {
      const [list, sessions] = await Promise.all([
        api('/scripts'),
        api('/sessions'),
      ]);
      if (!list.length) {
        main.innerHTML = `<h1>聊天</h1><div class="empty">还没有剧本。<br>先去「剧本」建一个。</div>`;
        return;
      }
      // 按剧本分组，每个剧本一个可折叠块
      const sessGroups = {};
      for (const se of (sessions || [])) {
        const key = se.script_id || '_none';
        if (!sessGroups[key]) sessGroups[key] = { name: se.script_name || '未知剧本', list: [] };
        sessGroups[key].list.push(se);
      }
      const groupKeys = Object.keys(sessGroups);
      const sessList = groupKeys.length ? `
        <h2 style="margin-top:28px;font-size:15px">继续上次的会话</h2>
        <div class="sub" style="margin-bottom:12px">按剧本分组，点开剧本看它的会话。</div>
        ${groupKeys.map(k => {
          const g = sessGroups[k];
          return `
            <details class="sessgroup" style="margin-bottom:12px;border:1px solid #262c3a;border-radius:10px;background:#1a1e28;overflow:hidden">
              <summary style="cursor:pointer;padding:12px 15px;font-size:13.5px;color:#b8c4ff;user-select:none">${esc(g.name)} <span style="color:#5f6675;font-size:11.5px;margin-left:6px">（${g.list.length} 个会话）</span></summary>
              <div style="padding:2px 12px 12px">
                ${g.list.map(se => `
                  <div class="card" data-sid="${esc(se.id)}" data-script="${esc(se.script_id || '')}" style="margin-bottom:8px">
                    <h3>${esc(se.title || '未命名会话')}</h3>
                    <p>${(se.history || []).length} 条消息</p>
                  </div>`).join('')}
              </div>
            </details>`;
        }).join('')}
      ` : '';
      main.innerHTML = `
        <h1>选一个剧本开始</h1>
        <div class="sub">点一个 → 五步配置 → 演绎。</div>
        <div class="cards">${list.map(s => `
          <div class="card" data-id="${s.id}">
            <h3>${esc(s.name)}</h3>
            <p>${esc((s.world || '').slice(0, 60) || '（未填世界观）')}</p>
          </div>`).join('')}</div>
        ${sessList}`;
      main.addEventListener('click', e => {
        const c = e.target.closest('.card');
        if (!c) return;
        if (c.dataset.sid) {
          // 继续已有会话
          state.chat.scriptId = c.dataset.script;
          state.chat.sessionId = c.dataset.sid;
          state.chat.msgs = [];
          state.chat.cfgSheet = null;
          renderChat();
        } else {
          openPrep(c.dataset.id);
        }
      });
      return;
    }

    const [script, chars, sess0, settings] = await Promise.all([
      api('/scripts/' + state.chat.scriptId),
      api('/characters'),
      state.chat.sessionId ? api('/sessions/' + state.chat.sessionId).catch(() => null) : Promise.resolve(null),
      api('/settings').catch(() => null),
    ]);
    state.settings = settings || state.settings || { provider: 'api' };
    let sess = sess0;   // 可变：每轮发送后会被最新会话数据替换
    // 登场角色：优先用会话里的 active_npcs
    const castIds = (sess && sess.active_npcs && sess.active_npcs.length)
      ? sess.active_npcs
      : (state.chat.cast || []);
    state.chat.cast = castIds;
    const castAll = chars.filter(c => castIds.includes(c.id));
    const S = state.chat;

    // 从 history 恢复聊天记录（含档位徽章 tier/tag）
    if ((!S.msgs || S.msgs.length === 0) && sess && sess.history && sess.history.length) {
      S.msgs = sess.history
        .filter(h => h.role === 'user' || h.role === 'assistant')
        .map(h => ({
          role: h.role,
          content: h.content || '',
          tier: h.tier || '',
          tag: h.tag || '',
          wordTarget: sess.word_target || 0,
        }));
    }

    // 初始化 UI 状态
    if (S.wordTarget === undefined) S.wordTarget = (sess && sess.word_target) || 2000;
    if (S.sideOpen === undefined) S.sideOpen = {};
    if (S.sideCollapsed === undefined) S.sideCollapsed = false;
    const player = (sess && sess.player) || S.player || {};
    const memory = (sess && sess.memory) || S.memory || { config: { stm_limit: 6 }, stm: [], ltm: [] };

    main.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <h1 style="margin:0;font-size:18px">${esc(script.name)}</h1>
        <span class="grow"></span>
        <button class="btn ghost sm" id="btnModel" title="点击切换本地模型 / DeepSeek API">
          🤖 ${(settings && settings.provider === 'ollama') ? '本地 Ollama' : 'DeepSeek'}
        </button>
        <button class="btn ghost sm" id="btnCfg">⚙ 自定义配置</button>
        <button class="btn ghost sm" id="${S.sideCollapsed ? 'sideShow' : 'sideHide'}">
          ${S.sideCollapsed ? '⟩ 展开面板' : '⟨ 收起面板'}
        </button>
        <button class="btn ghost sm" id="back">← 换剧本</button>
      </div>

      <div id="chatLayout">
        <div id="chatMain">
          <div id="chatMsgs"></div>
          <div class="toolbar" id="toolbar">
            <button id="btnMod">Mod</button>
            <button id="btnAddCast">＋ 加角色</button>
            <button id="btnMem">记忆</button>
            <button id="btnFixPersona" title="AI 人设跑偏时，让下一轮重新校准">🩹 修正人设</button>
            <button id="btnFixMem" title="记忆混乱时，清空短期记忆">🧹 记忆修复</button>
            <div class="dd" id="ddWord">
              <button id="btnWord">字数 ${S.wordTarget} ▾</button>
              <div class="ddm">
                ${WORD_PRESETS.map(n => `<div class="it ${n === S.wordTarget ? 'on' : ''}" data-w="${n}">${n}</div>`).join('')}
                <div class="sep"></div>
                <div class="cus">
                  <input id="cusWord" placeholder="自定义" type="number" value="${WORD_PRESETS.includes(S.wordTarget) ? '' : S.wordTarget}">
                </div>
              </div>
            </div>
            <button id="btnTop">到顶</button>
            <span class="sp"></span>
            <button id="btnPrompt">看 prompt</button>
            <span class="sp"></span><span id="modelNow" class="hint" style="margin:0"></span>
          </div>
          <div class="composer">
            <textarea id="inp" placeholder="写你要做的事，或点上面的选项…（Ctrl+Enter 发送）"></textarea>
            <button class="btn" id="send">发送</button>
          </div>
        </div>

        <div id="chatSide" class="${S.sideCollapsed ? 'collapsed' : ''}">
          <div class="fold" data-k="player">
            <div class="fh"><span class="arw2">▶</span>玩家信息<span class="badge" id="bgPlayer">0</span></div>
            <div class="fb" id="fbPlayer"></div>
          </div>
          <div class="fold" data-k="cast">
            <div class="fh"><span class="arw2">▶</span>登场角色<span class="badge" id="bgCast">0</span></div>
            <div class="fb" id="fbCast"></div>
          </div>
          <div class="fold" data-k="extras">
            <div class="fh"><span class="arw2">▶</span>周边角色<span class="badge" id="bgExtras">0</span></div>
            <div class="fb" id="fbExtras"></div>
          </div>
          <div class="fold" data-k="mem">
            <div class="fh"><span class="arw2">▶</span>记忆库<span class="badge" id="bgMem">0/6</span></div>
            <div class="fb" id="fbMem"></div>
          </div>
        </div>
      </div>
    `;

    /* ── 右侧三个折叠块 ── */
    const folds = $$('#chatSide .fold');
    folds.forEach(f => {
      const k = f.dataset.k;
      if (S.sideOpen[k]) f.classList.add('open');
      f.querySelector('.fh').onclick = () => {
        S.sideOpen[k] = !f.classList.contains('open');
        f.classList.toggle('open');
      };
    });

    /* 玩家信息 */
    function drawPlayer() {
      const box = $('#fbPlayer');
      const st = (sess && sess.state && sess.state.player) || {};
      const rows = [];

      const DEFAULT_LABELS = [
        ['name', '姓名'], ['gender', '性别'], ['age', '年龄'],
        ['identity', '身份'], ['appearance', '外貌'], ['personality', '性格'],
        ['outfit', '服装'], ['money', '货币'], ['items', '物品'],
        ['power', '特殊能力'], ['combat', '战斗力'], ['assets', '势力财产'],
        ['location', '位置'], ['mood', '状态'],
      ];
      // 剧本自定义面板字段优先（script.panel_fields），否则用默认 14 项
      const customPanel = (script.panel_fields && script.panel_fields.length) ? script.panel_fields : null;
      const fields = customPanel || DEFAULT_LABELS.map(([k, l]) => ({ key: k, label: l }));
      for (const f of fields) {
        let v = st[f.key];
        if (Array.isArray(v)) v = v.join('、');
        if (v) rows.push(`<div class="kvrow"><b>${esc(f.label)}</b><span>${esc(v)}</span></div>`);
      }

      // 补充：外观与身体（建号时填的 / 自动推算的）
      {
        const p2 = (sess && sess.player) || player || {};
        const cupOf = (bust, bt) => {
          const R = { loli: .80, girl: .78, onee: .76, mature: .74, plump: .72, thin: .86, normal: .88, athletic: .90, fat: .92 };
          const b = Number(bust) || 0; if (!b) return '';
          const under = Math.round(b * (R[bt] || .78));
          const d = b - under;
          const C = [[7.5,'AA'],[10,'A'],[12.5,'B'],[15,'C'],[17.5,'D'],[20,'E'],[22.5,'F'],[25,'G'],[27.5,'H'],[99,'I+']];
          for (const [lim, n] of C) if (d <= lim) return n;
          return '';
        };
        const extra = [
          ['hair_color', '发色'], ['skin_color', '肤色'], ['eye_color', '瞳色'],
          ['height', '身高'], ['body_type', '体型'], ['bust', '胸围'],
          ['waist', '腰围'], ['hip', '臀围'], ['milk_volume', '乳量'],
          ['sensitivity', '敏感度'], ['fertility', '受孕体质'],
          ['length', '长度'], ['shaft_diameter', '茎身直径'], ['glans_diameter', '龟头直径'],
          ['qizhi_main', '主气质'], ['qizhi_sub1', '副气质1'], ['qizhi_sub2', '副气质2'],
        ];
        const MAP = {
          body_type: { loli: '萝莉', girl: '少女', onee: '御姐', mature: '熟女', plump: '丰满', thin: '消瘦', normal: '匀称', athletic: '健硕', fat: '肥胖' },
          milk_volume: { poor: '贫乳', normal: '普乳', big: '巨乳', huge: '爆乳', super: '超乳' },
        };
        for (const [k, l] of extra) {
          let v = p2[k];
          if (MAP[k] && MAP[k][v]) v = MAP[k][v];
          if (v !== undefined && v !== '' && v !== null) rows.push(`<div class="kvrow"><b>${l}</b><span>${esc(v)}</span></div>`);
        }
        if (p2.bust && !p2.cup) {
          const cup = cupOf(p2.bust, p2.body_type);
          if (cup) rows.push(`<div class="kvrow"><b>罩杯</b><span>${cup}</span></div>`);
        }
      }

      // 兜底：用建号填的表单
      if (!rows.length) {
        const roleLabel = (() => {
          const rc = (script.role_choices || []).find(r => r.key === (sess && sess.role_choice));
          return rc ? rc.label : '';
        })();
        if (roleLabel) rows.push(`<div class="kvrow"><b>身份</b><span>${esc(roleLabel)}</span></div>`);
        const p = (sess && sess.player) || player || {};
        for (const f of (script.player_fields || [])) {
          if (p[f.key]) rows.push(`<div class="kvrow"><b>${esc(f.label)}</b><span>${esc(p[f.key])}</span></div>`);
        }
      }

      box.innerHTML = rows.join('') || `<div style="color:#5f6675">（没有填写）</div>`;
      $('#bgPlayer').textContent = rows.length;
    }
    drawPlayer();

    /* 登场角色（完整卡） */
    function drawCastFace() {
      const box = $('#fbCast');
      const npcs = (sess && sess.state && sess.state.npcs) || {};

      function heartBand(v) {
        const n = Number(v) || 0;
        if (n <= -60) return '敌意';
        if (n <= -30) return '厌恶';
        if (n < 0) return '反感';
        if (n === 0) return '陌生人';
        if (n <= 20) return '认识';
        if (n <= 40) return '熟悉';
        if (n <= 60) return '在意';
        if (n <= 80) return '亲密';
        if (n <= 100) return '不可取代';
        if (n <= 150) return '命定';
        return '共生';
      }
      function bodyBand(v) {
        const n = Number(v) || 0;
        if (n <= 20) return '不契合';
        if (n <= 40) return '勉强';
        if (n <= 60) return '合适';
        if (n <= 80) return '很好';
        if (n <= 100) return '极佳';
        if (n <= 140) return '破宫级';
        if (n <= 180) return '深度改造';
        return '彻底重塑';
      }
      function bar(v, max, color) {
        const n = Math.max(0, Math.min(max, Number(v) || 0));
        const pct = Math.round(100 * n / max);
        return `<div style="height:5px;background:#1d212c;border-radius:3px;overflow:hidden;margin:4px 0">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:3px"></div>
        </div>`;
      }

      if (!castAll.length) {
        box.innerHTML = `<div style="color:#5f6675;font-size:12px;padding:4px 0">（无）</div>
          <button class="btn ghost sm" id="sideAddCast" style="width:100%;margin-top:4px">＋ 从角色库…</button>`;
        $('#bgCast').textContent = 0;
        $('#sideAddCast').onclick = () => openAddCast(script, chars);
        return;
      }

      box.innerHTML = castAll.map(c => {
        const s = npcs[c.id] || npcs[String(c.id)] || {};
        const h = Number(s.heart || 0);
        const b = Number(s.body || 0);
        const hMax = s.pregnant ? 200 : (s.married ? 150 : 100);
        const bMax = (s.womb_broken || s.pregnant) ? 200 : 100;

        const kv = (k, v) => v ? `<div class="kvrow"><b>${k}</b><span>${esc(v)}</span></div>` : '';

        // 当前档位折叠（方案A：显示本轮判定档位 + 生理位置）
        const tier = s.last_tier || '';
        const tag = s.last_tag || '';
        const pos = s.last_position || '';
        const tierColor = tier === '身体释放' ? '#f87171' : (tier === '可以满足' ? '#4ade80' : '#9ca3af');
        const tierHtml = tier ? `
          <details style="margin-top:6px">
            <summary style="cursor:pointer;color:#7c9cff;font-size:11px">▸ 当前档位</summary>
            <div style="margin-top:4px;padding:6px 8px;background:#161a22;border:1px solid #262c3a;border-radius:6px">
              <div style="font-size:11.5px;color:${tierColor};font-weight:600">${esc(tier)}${tag ? ' · ' + esc(tag) : ''}</div>
              ${pos ? `<div style="font-size:10.5px;color:#8d93a3;margin-top:3px;line-height:1.5">${esc(pos)}</div>` : ''}
            </div>
          </details>` : '';

        // 身体特征
        let bdHtml = '';
        const bd = s.body_data || {};
        if (bd && Object.keys(bd).length) {
          const ORDER = [['pussy', '小穴'], ['breast', '胸'], ['ass', '臀'], ['mouth', '嘴']];
          const lines = ORDER.map(([k, label]) => {
            const v = bd[k];
            if (!v) return '';
            const nm = (typeof v === 'object') ? (v.name || '') : '';
            const txt = (typeof v === 'object') ? (v.text || '') : String(v);
            if (!txt) return '';
            return `<div style="padding:3px 0;border-bottom:1px solid #1e222b">
              <span style="color:#7c9cff;font-size:10.5px;font-weight:600">${label}${nm ? '（' + nm + '）' : ''}</span>
              <div style="color:#8d93a3;font-size:10.5px;line-height:1.55;margin-top:1px">${esc(txt)}</div>
            </div>`;
          }).filter(Boolean).join('');
          if (lines) {
            bdHtml = `<details style="margin-top:6px">
              <summary style="cursor:pointer;color:#7c9cff;font-size:11px;padding:3px 0">▸ 身体特征</summary>
              <div style="margin-top:4px">${lines}</div>
            </details>`;
          }
        }

        return `<div style="background:#1a1e28;border:1px solid #262c3a;border-radius:9px;padding:9px 11px;margin-bottom:8px">
          <div class="row" style="margin-bottom:6px">
            <b style="font-size:13px">${esc(c.name)}</b>
            <span class="grow"></span>
            <span style="font-size:11px;color:#f87171">♥${h}</span>
            <span style="font-size:11px;color:#fbbf24;margin-left:6px">♠${b}</span>
            <span class="xx" data-rm="${c.id}" style="margin-left:8px;cursor:pointer;color:#6b7280">×</span>
          </div>
          <div class="ct" style="font-size:10.5px;color:#5f6675;margin-bottom:5px">${esc(c._category || '未分类')}</div>
          ${(() => {
            const nf = (script.npc_panel_fields && script.npc_panel_fields.length) ? script.npc_panel_fields : null;
            if (nf) {
              return nf.map(f => {
                const v = s[f.key] || (c.profile || {})[f.key]
                  || (f.fallback ? (s[f.fallback] || (c.profile || {})[f.fallback]) : '');
                return kv(f.label, v);
              }).join('');
            }
            return kv('性别', s.gender) + kv('年龄', s.age) + kv('身高', s.height)
              + kv('体型', (c.profile || {}).body_type) + kv('气质', (c.profile || {}).qizhi)
              + kv('三围', s.measurements) + kv('性格', s.personality) + kv('身份', s.identity)
              + kv('外貌', s.appearance) + kv('服装', s.outfit);
          })()}
          <details style="margin-top:7px;padding-top:7px;border-top:1px dashed #232838">
            <summary style="cursor:pointer;color:#7c9cff;font-size:11px">▸ 心体轴（♥${h} / ♠${b}）</summary>
            <div style="margin-top:5px">
              <div class="row" style="font-size:11px;margin-bottom:2px">
                <span style="color:#f87171">♥心 ${h}</span>
                <span class="grow"></span>
                <span style="color:#5f6675;font-size:10px">${esc(s.heart_note || heartBand(h))}（上限${hMax}）</span>
              </div>
              ${bar(h, hMax, '#f87171')}
              <div class="row" style="font-size:11px;margin-bottom:2px;margin-top:5px">
                <span style="color:#fbbf24">♠体 ${b}</span>
                <span class="grow"></span>
                <span style="color:#5f6675;font-size:10px">${esc(s.body_note || bodyBand(b))}（上限${bMax}）</span>
              </div>
              ${bar(b, bMax, '#fbbf24')}
              ${tierHtml}
            </div>
          </details>
          ${(S.rejectNote && S.rejectNote.name === c.name) ? `<div style="margin-top:7px;padding:6px 8px;background:#3a1d1d;border:1px solid #7f1d1d;border-radius:6px;color:#fca5a5;font-size:10.5px;line-height:1.5">⚠ 阈值已上移（press ${S.rejectNote.press_now}cm）：拒绝线 ${S.rejectNote.reject_line}cm，你当前 ${S.rejectNote.player_length}cm 不够，她拒绝了。需要更长的尺寸才能再进入。</div>` : ''}
          ${kv('位置', s.location)}${kv('状态', s.mood)}
          ${s.inner_voice ? `<div style="color:#7c8798;font-size:10.5px;font-style:italic;margin-top:5px">「${esc(s.inner_voice)}」</div>` : ''}
          ${bdHtml}
        </div>`;
      }).join('') + `<button class="btn ghost sm" id="sideAddCast" style="width:100%;margin-top:4px">＋ 从角色库…</button>`;

      $('#bgCast').textContent = castAll.length;
      $$('#fbCast .xx').forEach(x => {
        x.onclick = async () => {
          const cid = x.dataset.rm;
          S.cast = S.cast.filter(i => i !== cid);
          await syncSession({ active_npcs: S.cast });
          renderChat();
        };
      });
      $('#sideAddCast').onclick = () => openAddCast(script, chars);
    }
    drawCastFace();

    /* 周边角色 */
    function drawExtras() {
      const box = $('#fbExtras');
      const ex = (sess && sess.state && sess.state.extras) || {};
      const names = Object.keys(ex);
      $('#bgExtras').textContent = names.length;

      if (!names.length) {
        box.innerHTML = `<div style="color:#5f6675;font-size:12px;padding:4px 0">（还没有周边角色。正文里出现的长期 NPC 会自动记录）</div>`;
        return;
      }

      const ROLE_COLOR = {
        '黄毛': '#f87171', '苦主': '#fbbf24', '对手': '#f472b6',
        '长期路人': '#7c9cff', '路人': '#7c8798',
      };

      box.innerHTML = names.map(n => {
        const v = ex[n] || {};
        const role = v.role || '路人';
        const color = ROLE_COLOR[role] || '#7c8798';
        const dim = v.status === 'background' ? 'opacity:.45' : '';
        const rel = v.relation ? `<div style="color:#8d93a3;font-size:11px;margin-top:2px">${esc(v.relation)}</div>` : '';
        const desc = v.appearance ? `<div style="color:#6b7280;font-size:10.5px;margin-top:3px;line-height:1.5">${esc(v.appearance)}</div>` : '';
        const loc = [v.location ? '位置：' + v.location : '', v.mood ? '情绪：' + v.mood : ''].filter(Boolean).join(' · ');
        const state_txt = v.status === 'background' ? '（暂时离场）' : (v.status === 'gone' ? '（不再出现）' : loc);
        return `<div class="chip2" style="align-items:flex-start;${dim}">
          <div class="nmm" style="min-width:0">
            <div style="display:flex;align-items:center;gap:6px">
              <b style="font-size:12.5px">${esc(n)}</b>
              <span style="font-size:10px;color:${color};border:1px solid ${color}33;padding:0 5px;border-radius:4px">${esc(role)}</span>
            </div>
            ${rel}${desc}
            ${state_txt ? `<div style="color:#5f6675;font-size:10.5px;margin-top:3px">${esc(state_txt)}</div>` : ''}
          </div>
          <span class="xx" data-exrm="${esc(n)}">×</span>
        </div>`;
      }).join('');

      $$('#fbExtras .xx').forEach(x => {
        x.onclick = async () => {
          const nm = x.dataset.exrm;
          if (!confirm('移除周边角色「' + nm + '」？')) return;
          delete sess.state.extras[nm];
          await syncSession({ state: sess.state });
          drawExtras();
          toast('已移除', 'ok');
        };
      });
    }
    drawExtras();

    /* 记忆库 */
    function drawMem() {
      const box = $('#fbMem');
      const cfg = memory.config || { stm_limit: 6 };
      const stm = memory.stm || [];
      const ltm = memory.ltm || [];
      box.innerHTML = `
        <div class="memhead">
          <span class="lb2">短期上限</span>
          <input id="stmLimit" type="number" value="${cfg.stm_limit || 6}">
          <span class="sp2"></span>
          <button class="btn ghost sm" id="memSum">立即总结</button>
        </div>
        <div style="font-size:11.5px;color:#7c9cff;margin-bottom:5px">短期记忆 ${stm.length}/${cfg.stm_limit || 6}</div>
        <div class="ovf" style="margin-bottom:10px">
          ${stm.map(x => `<div class="mem"><div class="mt2">#${esc(x.round)} ${esc(x.scene || '')}</div><div class="me">${esc(x.event || '')}</div></div>`).join('')
            || '<div style="color:#5f6675;font-size:11.5px">（空）</div>'}
        </div>
        <div style="font-size:11.5px;color:#7c9cff;margin-bottom:5px">长期记忆 ${ltm.length} 条</div>
        <div class="ovf">
          ${ltm.slice().reverse().map(x => `<div class="mem"><div class="mt2">[${esc(x.range || '')}] ${esc(x.scene || '')}</div><div class="me">${esc(x.event || '')}</div></div>`).join('')
            || '<div style="color:#5f6675;font-size:11.5px">（空）</div>'}
        </div>`;
      $('#bgMem').textContent = `${stm.length}/${cfg.stm_limit || 6}`;
      $('#memSum').onclick = () => doSummarize(true);
      $('#stmLimit').onchange = async (e) => {
        const n = Math.max(2, +e.target.value || 6);
        memory.config = Object.assign({}, cfg, { stm_limit: n });
        await syncSession({ memory });
        toast('短期上限已设为 ' + n, 'ok');
        drawMem();
      };
    }
    drawMem();

    /* 重绘右侧全部面板（发送后 / 手动改状态后调用） */
    async function refreshPanels() {
      // 玩家卡（读 sess.state.player）
      drawPlayer();
      // 登场角色卡（读 sess.state.npcs，含双轴 + 身体特征）
      drawCastFace();
      // 周边角色（读 sess.state.extras）
      drawExtras();
      // 记忆库（读 memory）
      drawMem();
    }

    async function syncSession(patch) {
      if (!S.sessionId) return;
      try { await api('/sessions/' + S.sessionId, { method: 'PUT', body: patch }); } catch (e) {}
    }

    /* ── 正文渲染 ── */
    const msgsBox = $('#chatMsgs');
    const inp = $('#inp');

    function renderMsg(m, idx) {
      if (m.role === 'user') {
        return `<div class="userblk"><div class="txt">${esc(m.content)}</div></div>`;
      }
      // 只有最后一条 AI 消息才渲染选项
      const isLastAI = (idx === S.msgs.length - 1);
      // AI 消息：拆正文 / 选项
      const raw = m.content || '';
      const optIdx = raw.search(/^选项[：:]/m);
      let body = raw, opts = [];
      if (optIdx >= 0) {
        body = raw.slice(0, optIdx).trim();
        const tail = raw.slice(optIdx);
        const lines = tail.split('\n').slice(1);
        for (const ln of lines) {
          const t = ln.trim();
          if (!t) continue;
          const mm = t.match(/^(?:选项)?\s*([A-Ga-g]|\d+)[.、．]\s*(.+)$/);
          if (!mm) {
            // 遇到非选项行（正文），停止解析——避免把续写的正文当选项
            if (opts.length > 0) break;
            continue;
          }
          const txt = mm[2].trim();
          if (!txt) continue;
          if (opts.some(o => o.text === txt)) continue;   // 去重
          opts.push({ n: String(mm[1]).toUpperCase(), text: txt });
          if (opts.length >= 7) break;                    // 最多 7 条
        }
      }
      const meta = m.meta || {};
      // 方案B：本轮档位徽章
      const _tier = m.tier || '';
      const _tag = m.tag || '';
      const _tierColor = _tier === '身体释放' ? '#f87171' : (_tier === '可以满足' ? '#4ade80' : '#9ca3af');
      const tierBadge = _tier ? `<span style="color:${_tierColor};border:1px solid ${_tierColor}55;background:${_tierColor}14;border-radius:4px;padding:1px 7px;font-size:10.5px">♠${esc(_tier)}${_tag ? ' · ' + esc(_tag) : ''}</span>` : '';
      const metaHtml = (meta.time || meta.scene || meta.round || tierBadge) ? `
        <div class="meta2">
          ${meta.time ? `<span><b>时间</b> ${esc(meta.time)}</span>` : ''}
          ${meta.scene ? `<span><b>地点</b> ${esc(meta.scene)}</span>` : ''}
          ${meta.round ? `<span><b>第 ${esc(meta.round)} 轮</b></span>` : ''}
          ${tierBadge}
        </div>` : '';

      const optsHtml = (opts.length && isLastAI) ? `
        <div class="opts">
          <div class="oh">选一个，或自己写</div>
          ${opts.map(o => `
            <button class="opt" data-opt="${esc(o.text)}">
              <span class="on2">${esc(o.n)}.</span>${esc(o.text)}
            </button>`).join('')}
        </div>` : '';

      const wcInfo = (() => {
        if (!body.length) return '';
        const len = body.length;
        const tg = m.wordTarget || 0;
        const rt = m.retries || 0;
        let s = `${len} 字`;
        if (tg) {
          const pct = Math.round(100 * len / tg);
          s += ` / 目标 ${tg}（${pct}%）`;
        }
        if (rt) s += ` · 续写 ${rt} 次`;
        return s;
      })();
      const wc = wcInfo ? `<div class="wordcount">${wcInfo}</div>` : '';

      return `<div class="aiblk">
        ${metaHtml}
        <div class="txt">${esc(body)}</div>
        ${optsHtml}
        ${wc}
      </div>`;
    }

    function drawMsgs() {
      let html = '';
      // 配置单（只渲染一次，放最顶）
      const cfgInfo = S.cfgSheet;
      if (cfgInfo) html += cfgSheetHtml(cfgInfo);
      html += S.msgs.map(renderMsg).join('');
      msgsBox.innerHTML = html;
      // 选项点击
      $$('#chatMsgs .opt').forEach(b => {
        b.onclick = () => {
          inp.value = b.dataset.opt;
          send();
        };
      });
      msgsBox.scrollTop = msgsBox.scrollHeight;
    }

    function cfgSheetHtml(info) {
      return `<div class="cfgsheet">
        <div class="cht">【开局确认】</div>
        ${(info.rows || []).map(r => `<div class="cr"><b>${esc(r[0])}</b><span>${esc(r[1])}</span></div>`).join('')}
        ${info.cast && info.cast.length ? `<div class="cr"><b>登场</b><span>${esc(info.cast.join('、'))}</span></div>` : ''}
        ${info.opening ? `<div class="cr" style="margin-top:10px;padding-top:10px;border-top:1px dashed #262c3a"><b>开场</b><span>${esc(info.opening)}</span></div>` : ''}
      </div>`;
    }

    if (!S.cfgSheet && sess) {
      // 从会话构造配置单
      const rows = [];
      const roleLabel = (() => {
        const rc = (script.role_choices || []).find(r => r.key === sess.role_choice);
        return rc ? rc.label : '';
      })();
      if (roleLabel) rows.push(['身份', roleLabel]);
      const fields = script.player_fields || [];
      if (fields.length) {
        for (const f of fields) {
          if (player[f.key]) rows.push([f.label, player[f.key]]);
        }
      } else {
        if (player.name) rows.push(['姓名', player.name]);
        if (player.age) rows.push(['年龄', player.age]);
        if (player.identity) rows.push(['身份', player.identity]);
        if (player.extra) rows.push(['其他', player.extra]);
      }
      S.cfgSheet = {
        rows,
        cast: castAll.map(c => c.name),
        opening: S.msgs.length ? (S.msgs[0].content || '').slice(0, 60) : '',
      };
    }
    drawMsgs();

    /* ── 工具栏 ── */
    $('#btnMod').onclick = () => openModModal(script, chars);
    $('#btnAddCast').onclick = () => openAddCast(script, chars);
    $('#btnMem').onclick = () => {
      S.sideCollapsed = false;
      S.sideOpen.mem = true;
      $('#chatSide').classList.remove('collapsed');
      folds.forEach(f => f.classList.toggle('open', f.dataset.k === 'mem' || !!S.sideOpen[f.dataset.k]));
      $('#btnMem').scrollIntoView({ block: 'nearest' });
    };
    $('#btnFixPersona').onclick = async () => {
      if (!S.sessionId) return toast('先开一局', 'err');
      try {
        const r = await api('/fix-persona', { method: 'POST', body: { session_id: S.sessionId } });
        toast(r.data.msg || '下一轮将重新校准人设', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#btnFixMem').onclick = async () => {
      if (!S.sessionId) return toast('先开一局', 'err');
      if (!confirm('清空短期记忆（STM）？长期记忆和配置会保留。')) return;
      try {
        const r = await api('/fix-memory', { method: 'POST', body: { session_id: S.sessionId } });
        toast(r.data.msg || '短期记忆已清空', 'ok');
        await renderChat();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#btnTop').onclick = () => { msgsBox.scrollTop = 0; };

    // 字数下拉
    const dd = $('#ddWord');
    $('#btnWord').onclick = (e) => { e.stopPropagation(); dd.classList.toggle('open'); };
    document.addEventListener('click', () => dd.classList.remove('open'), { once: true });
    $$('#ddWord .it').forEach(it => {
      it.onclick = async () => {
        S.wordTarget = +it.dataset.w;
        $('#btnWord').textContent = '字数 ' + S.wordTarget + ' ▾';
        dd.classList.remove('open');
        await syncSession({ word_target: S.wordTarget });
        toast('字数设为 ' + S.wordTarget, 'ok');
      };
    });
    $('#cusWord').onchange = async (e) => {
      const n = Math.max(100, +e.target.value || 0);
      if (!n) return;
      S.wordTarget = n;
      $('#btnWord').textContent = '字数 ' + n + ' ▾';
      dd.classList.remove('open');
      await syncSession({ word_target: n });
      toast('字数设为 ' + n, 'ok');
    };

    $('#btnPrompt').onclick = async () => {
      try {
        const r = await api('/preview', {
          method: 'POST',
          body: {
            script_id: S.scriptId,
            session_id: S.sessionId,
            active_npcs: S.cast,
            word_target: S.wordTarget,
          },
        });
        showPrompt(r);
      } catch (e) { toast(e.message, 'err'); }
    };

    const _bSideHide = $('#sideHide');
    if (_bSideHide) _bSideHide.onclick = () => { S.sideCollapsed = true; renderChat(); };
    const _bSideShow = $('#sideShow');
    if (_bSideShow) _bSideShow.onclick = () => { S.sideCollapsed = false; renderChat(); };

    $('#back').onclick = () => {
      state.chat = { scriptId: null, sessionId: null, msgs: [], busy: false, cast: [] };
      setView('chat');
    };

    $('#btnCfg').onclick = () => openCfgModal(script, sess, S);

    // 模型切换：本地 Ollama ↔ DeepSeek API（一键）
    $('#btnModel').onclick = async () => {
      const cur = (state.settings && state.settings.provider === 'ollama') ? 'ollama' : 'api';
      const next = cur === 'ollama' ? 'api' : 'ollama';
      try {
        await api('/settings', { method: 'POST', body: { provider: next } });
        state.settings = await api('/settings');
        toast('已切换到 ' + (next === 'ollama' ? '本地 Ollama' : 'DeepSeek API'), 'ok');
        renderChat();
      } catch (e) { toast(e.message, 'err'); }
    };

    /* ── 发送 ── */
    async function send() {
      const text = inp.value.trim();
      if (!text || S.busy) return;
      S.busy = true;
      S.msgs.push({ role: 'user', content: text });
      inp.value = '';
      drawMsgs();
      const _t0 = Date.now();
      const rid = 'rq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      let _stopped = false;
      msgsBox.insertAdjacentHTML('beforeend',
        `<div class="aiblk" id="pending">
           <div class="txt" style="color:#8d93a3">正在写…（已 0 秒）</div>
           <div id="pendPre" style="white-space:pre-wrap;margin-top:8px;color:#c9cdd6;max-height:42vh;overflow:auto"></div>
           <div style="margin-top:8px"><button class="btn ghost sm" id="btnStop">■ 停止</button></div>
         </div>`);
      msgsBox.scrollTop = msgsBox.scrollHeight;
      const _sendBtn = $('#send');
      if (_sendBtn) _sendBtn.disabled = true;
      const _timer = setInterval(() => {
        const p = $('#pending .txt');
        if (p && !_stopped) p.textContent = '正在写…（已 ' + Math.floor((Date.now() - _t0) / 1000) + ' 秒，可随时点停止）';
      }, 1000);
      const _bStop = $('#btnStop');
      if (_bStop) _bStop.onclick = async () => {
        _stopped = true;
        const p = $('#pending .txt'); if (p) p.textContent = '已停止，本轮不会保存。';
        _bStop.disabled = true; _bStop.textContent = '已停止';
        try { await api('/chat/stop', { method: 'POST', body: { request_id: rid } }); } catch (e) {}
      };
      // 每 1.2 秒拉一次已生成的增量，让人看到模型确实在写而不是卡死
      let _tailFrom = 0;
      const _tailTimer = setInterval(async () => {
        if (_stopped) return;
        try {
          const t = await api('/chat/tail?rid=' + encodeURIComponent(rid) + '&from=' + _tailFrom);
          if (t && t.text) {
            _tailFrom = t.n;
            const pre = $('#pendPre');
            if (pre) {
              pre.textContent = (pre.textContent || '') + t.text;
              if (pre.textContent.length > 4000) pre.textContent = pre.textContent.slice(-3000);
              msgsBox.scrollTop = msgsBox.scrollHeight;
            }
          }
        } catch (e) {}
      }, 400);

      try {
        const r = await api('/chat', {
          method: 'POST',
          body: {
            script_id: S.scriptId,
            session_id: S.sessionId,
            input: text,
            active_npcs: S.cast,
            word_target: S.wordTarget,
            request_id: rid,
          },
        });
        S.sessionId = r.session_id;
        const _mn = $('#modelNow'); if (_mn) _mn.textContent = '本轮模型：' + (r.model || '未知');
        S.msgs.push({ role: 'assistant', content: r.reply, wordTarget: r.word_target || 0, retries: r.retries || 0, bodyChars: r.body_chars || 0, tier: r.tier || '', tag: r.tag || '' });
        // 拒绝提示：破宫后阈值上移，尺寸不够被拒
        if (r.reject) {
          S.rejectNote = r.reject;
          toast(`⚠ ${r.reject.name} 阈值已上移（拒绝线 ${r.reject.reject_line}cm），你当前 ${r.reject.player_length}cm 不够，她拒绝了`, 'err');
        } else {
          S.rejectNote = null;
        }
        // 刷新整份会话（state + memory），并重绘右侧全部面板
        try {
          const fresh = await api('/sessions/' + S.sessionId);
          if (fresh) {
            sess = fresh;                                  // 更新会话快照
            Object.assign(memory, fresh.memory || {});      // 更新记忆
            await refreshPanels();
            // STM 超上限 → 自动总结成 LTM
            const _stm = memory.stm || [];
            const _limit = (memory.config || {}).stm_limit || 6;
            if (_stm.length > _limit) {
              await doSummarize(false);
            }
          }
        } catch (e) {}
      } catch (e) {
        if (/已停止/.test(e.message || '')) {
          S.msgs.push({ role: 'assistant', content: '（已停止，本轮未保存）' });
        } else {
          S.msgs.push({ role: 'assistant', content: '［出错了］' + e.message });
        }
      } finally {
        S.busy = false;
        clearInterval(_timer);
        clearInterval(_tailTimer);
        if (_sendBtn) _sendBtn.disabled = false;
        const p = $('#pending'); if (p) p.remove();
        drawMsgs();
      }
    }

    $('#send').onclick = send;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });
    inp.focus();

    async function doSummarize(manual) {
      if (!S.sessionId) return toast('还没有会话', 'err');
      try {
        const r = await api('/memory/summarize', { method: 'POST', body: { session_id: S.sessionId, force: !!manual } });
        if (r.summarized) {
          toast('已总结成 ' + (r.ltm_count || 1) + ' 条长期记忆', 'ok');
          Object.assign(memory, r.memory || {});
          drawMem();
        } else {
          toast('短期记忆还不够（' + (r.stm_count || 0) + '/' + (r.limit || 6) + '）', 'err');
        }
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  /* ═══════════ 加角色弹层 ═══════════ */
  async function openAddCast(script, chars) {
    const S = state.chat;
    const [cats] = await Promise.all([api('/categories')]);
    const catOn = {};
    (cats || []).forEach(c => { catOn[c.name] = c.enabled !== false; });
    const avail = chars.filter(c => catOn[c._category || ''] !== false);
    const inCast = new Set(S.cast || []);
    let filterCat = null;
    let kw = '';

    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="modal" style="width:min(820px,95vw)">
        <div class="hd"><h2>从角色库添加</h2><span style="flex:1"></span>
          <button class="btn ghost sm" id="acX">关闭</button></div>
        <div class="bd">
          <div class="row" style="margin-bottom:10px">
            <input id="acQ" placeholder="搜角色名 / 作品名 / 别名…" style="flex:1">
          </div>
          <div class="row" style="margin-bottom:12px;gap:6px" id="acCats"></div>
          <div class="pcards" id="acList" style="max-height:46vh;overflow:auto"></div>
        </div>
        <div class="ft">
          <span class="sub" id="acCnt" style="margin:0"></span>
          <span style="flex:1"></span>
          <button class="btn" id="acOk">添加到在场</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const picked = new Set();

    function drawCats() {
      const names = [...new Set(avail.map(c => c._category || ''))];
      $('#acCats').innerHTML =
        `<button class="btn ghost sm ${filterCat === null ? 'on' : ''}" data-c="">全部</button>` +
        names.map(n => `<button class="btn ghost sm ${filterCat === n ? 'on' : ''}" data-c="${esc(n)}">${esc(n || '未分类')}</button>`).join('');
      $$('#acCats button').forEach(b => {
        b.onclick = () => { filterCat = b.dataset.c === '' ? null : b.dataset.c; drawCats(); drawList(); };
      });
    }

    function drawList() {
      const k = kw.trim().toLowerCase();
      let arr = avail.slice();
      if (filterCat !== null) arr = arr.filter(c => (c._category || '') === filterCat);
      if (k) {
        arr = arr.filter(c =>
          (c.name || '').toLowerCase().includes(k) ||
          (c._category || '').toLowerCase().includes(k) ||
          (c.aliases || []).some(a => a.toLowerCase().includes(k))
        );
      }
      $('#acList').innerHTML = arr.map(c => {
        const already = inCast.has(c.id);
        const on = picked.has(c.id);
        return `<div class="pcard ${on ? 'on' : ''}" data-cid="${c.id}" style="${already ? 'opacity:.4;cursor:not-allowed' : ''}">
          <div class="pn">${esc(c.name)}</div>
          <div class="pa">${esc(c._category || '未分类')}${already ? ' · 已在场' : ''}</div>
          <div class="pd">${esc(((c.blocks || {}).core || {}).text || '')}</div>
        </div>`;
      }).join('') || '<div class="empty">没找到</div>';

      $$('#acList .pcard').forEach(card => {
        const cid = card.dataset.cid;
        if (inCast.has(cid)) return;
        card.onclick = () => {
          if (picked.has(cid)) picked.delete(cid); else picked.add(cid);
          card.classList.toggle('on');
          $('#acCnt').textContent = `已选 ${picked.size} 个`;
        };
      });
    }

    drawCats();
    drawList();
    $('#acQ').oninput = e => { kw = e.target.value; drawList(); };
    $('#acX').onclick = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    $('#acOk').onclick = async () => {
      if (!picked.size) return toast('先选几个', 'err');
      S.cast = [...new Set([...(S.cast || []), ...picked])];
      mask.remove();
      await syncSessionSilent(S.sessionId, { active_npcs: S.cast });
      toast('已加入 ' + picked.size + ' 个', 'ok');
      renderChat();
    };
  }

  async function syncSessionSilent(sid, patch) {
    if (!sid) return;
    try { await api('/sessions/' + sid, { method: 'PUT', body: patch }); } catch (e) {}
  }

  /* ═══════════ 自定义配置弹窗 ═══════════ */
  async function openCfgModal(script, sess, S) {
    // 全局 = 剧本级；会话 = 本局
    let tab = 'sess';
    const g = {
      prompt: script.global_prompt || '',
      pre: script.global_pre || '',
      post: script.global_post || '',
    };
    const s = {
      prompt: (sess && sess.sess_prompt) || '',
      pre: (sess && sess.sess_pre) || '',
      post: (sess && sess.sess_post) || '',
    };
    const mem = (sess && sess.memory) || { stm: [], ltm: [] };

    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="modal" style="width:min(880px,96vw)">
        <div class="hd">
          <h2>自定义配置</h2>
          <span style="flex:1"></span>
          <button class="btn ghost sm" id="cfgX">关闭</button>
        </div>
        <div class="bd">
          <div class="mtabs" style="margin-bottom:14px">
            <button data-t="global">全局配置（本剧本）</button>
            <button data-t="sess" class="on">会话配置（这一局）</button>
          </div>
          <div id="cfgPane"></div>
        </div>
        <div class="ft">
          <span class="sub" style="margin:0">会话配置会覆盖同名的全局配置；这三项是<b style="color:#b8c4ff">第一优先级</b>，压过剧本与 MOD</span>
          <span style="flex:1"></span>
          <button class="btn" id="cfgSave">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    function pane() {
      const cur = tab === 'global' ? g : s;
      const isG = tab === 'global';
      $('#cfgPane').innerHTML = `
        <label class="fld"><span>前置词 <em style="color:#5f6675;font-style:normal">— 拼在「你的输入」之前</em></span>
          <textarea id="c_pre" style="min-height:110px">${esc(cur.pre)}</textarea></label>
        <label class="fld"><span>后置词 <em style="color:#5f6675;font-style:normal">— 拼在「你的输入」之后</em></span>
          <textarea id="c_post" style="min-height:110px">${esc(cur.post)}</textarea></label>
        <label class="fld"><span>提示词 <em style="color:#5f6675;font-style:normal">— 主提示词，实现世界观和设定</em></span>
          <textarea id="c_prompt" style="min-height:150px">${esc(cur.prompt)}</textarea></label>
        ${isG ? '' : `
        <label class="fld"><span>长期记忆单 <em style="color:#5f6675;font-style:normal">— AI 总结出来的（只读，可在右侧删除）</em></span>
          <div style="background:var(--bg3);border:1px solid var(--line);border-radius:9px;padding:11px;max-height:200px;overflow:auto;font-size:12.5px;line-height:1.75">
            ${(mem.ltm || []).slice().reverse().map(x => `<div style="margin-bottom:9px"><b style="color:#7c9cff">[${esc(x.range || '')}] ${esc(x.scene || '')}</b><div style="color:#a3aab8">${esc(x.event || '')}</div></div>`).join('')
              || '<div style="color:#5f6675">（还没有长期记忆）</div>'}
          </div>
        </label>`}
      `;
      $$('#cfgPane textarea').forEach(t => t.addEventListener('input', () => {
        const k = t.id.replace('c_', '');
        cur[k] = t.value;
      }));
    }
    pane();

    $$('.mtabs button').forEach(b => {
      b.classList.toggle('on', b.dataset.t === tab);
      b.onclick = () => {
        tab = b.dataset.t;
        $$('.mtabs button').forEach(x => x.classList.toggle('on', x.dataset.t === tab));
        pane();
      };
    });

    $('#cfgX').onclick = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) mask.remove(); };

    $('#cfgSave').onclick = async () => {
      try {
        await api('/scripts/' + script.id, {
          method: 'PUT',
          body: { global_prompt: g.prompt, global_pre: g.pre, global_post: g.post },
        });
        // 同步回本地变量，否则再次点开会读到旧值（后置词丢失）
        script.global_prompt = g.prompt;
        script.global_pre = g.pre;
        script.global_post = g.post;
        if (S && S.sessionId) {
          await api('/sessions/' + S.sessionId, {
            method: 'PUT',
            body: { sess_prompt: s.prompt, sess_pre: s.pre, sess_post: s.post },
          });
          if (sess) {
            sess.sess_prompt = s.prompt;
            sess.sess_pre = s.pre;
            sess.sess_post = s.post;
          }
        }
        toast('已保存', 'ok');
        mask.remove();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ═══════════ MOD 弹层（剧本内）═══════════ */
  async function openModModal(script, chars) {
    const [allMods, fresh] = await Promise.all([api('/mods'), api('/scripts/' + script.id)]);
    const overrides = Object.assign({}, fresh.mod_overrides || {});
    const sid = script.id;
    let tab = 'script';   // script | global | mine

    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="hd">
          <div>
            <h2>Mod</h2>
            <div class="sub">在这里开关的 MOD，只影响《${esc(script.name)}》这一部｜专用＝只绑本剧本，公用＝所有剧本（含标为 all 的）</div>
          </div>
          <span style="flex:1"></span>
          <button class="btn ghost sm" id="mClose">关闭</button>
        </div>
        <div class="bd">
          <div class="mtabs">
            <button data-t="script">专用 Mod</button>
            <button data-t="global">公用 Mod</button>
            <button data-t="mine">我的 Mod</button>
          </div>
          <div class="row" style="margin-bottom:12px">
            <input id="mSearch" placeholder="搜索…" style="flex:0 0 220px">
            <span class="grow"></span>
            <button class="btn ghost sm" id="mNew">＋ 新建</button>
          </div>
          <div id="mList" style="border:1px solid var(--line);border-radius:9px;background:var(--bg3);overflow:hidden"></div>
        </div>
        <div class="ft">
          <span class="sub" id="mCount" style="margin:0"></span>
          <span style="flex:1"></span>
          <button class="btn" id="mSave">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const isOn = (m) => {
      if (overrides[m.id] !== undefined) return !!overrides[m.id];
      return m.enabled !== false;
    };

    function listFor(t, kw = '') {
      let arr = allMods.slice();
      if (t === 'script') arr = arr.filter(m => (m.scope === 'script') && (m.script_id === sid || !m.script_id));
      else if (t === 'global') arr = arr.filter(m => { const s = m.scope || 'global'; return s === 'global' || s === 'all'; });
      else arr = arr.filter(m => m.author === '自建' || m.mine);
      if (kw) {
        const k = kw.toLowerCase();
        arr = arr.filter(m => (m.name || '').toLowerCase().includes(k) || (m.content || '').toLowerCase().includes(k));
      }
      return arr;
    }

    function draw() {
      const kw = ($('#mSearch') || {}).value || '';
      const arr = listFor(tab, kw);
      const box = $('#mList');
      if (!arr.length) {
        box.innerHTML = `<div style="padding:26px;text-align:center;color:#5f6675;font-size:12.5px">这里还没有 MOD${tab === 'script' ? '（专用 MOD 绑定在当前剧本）' : ''}</div>`;
      } else {
        box.innerHTML = arr.map(m => `
          <div class="mrow" data-id="${m.id}">
            <label class="sw" style="flex:0 0 auto">
              <input type="checkbox" data-tog="${m.id}" ${isOn(m) ? 'checked' : ''}>
              <span class="dot"></span>
            </label>
            <div class="nm">
              <b>${esc(m.name || '未命名')}</b>
              <p>${esc((m.content || '').slice(0, 46) || '（空）')}</p>
            </div>
            <div class="mt">${(m.content || '').length} 字<br>${esc(m.group || '未分组')}</div>
            <div class="op">
              <button class="btn ghost sm" data-edit="${m.id}">编辑</button>
            </div>
          </div>`).join('');
        $$('#mList input[data-tog]').forEach(cb => {
          cb.onchange = () => { overrides[cb.dataset.tog] = cb.checked; };
        });
        $$('#mList button[data-edit]').forEach(b => {
          b.onclick = () => { mask.remove(); openModEditorFromChat(b.dataset.edit, script); };
        });
      }
      const onCount = arr.filter(m => isOn(m)).length;
      $('#mCount').textContent = `本页 ${arr.length} 个 · 已开 ${onCount} 个`;
      paintTabs();
    }

    $$('.mtabs button').forEach(b => {
      b.classList.toggle('on', b.dataset.t === tab);
      b.onclick = () => {
        tab = b.dataset.t;
        $$('.mtabs button').forEach(x => x.classList.toggle('on', x.dataset.t === tab));
        draw();
      };
    });
    // 页签带数量；默认停在第一个有内容的页签，避免「专用」为空时看起来没有 MOD
    const TAB_LABELS = { script: '专用 Mod', global: '公用 Mod', mine: '我的 Mod' };
    const countFor = (t) => listFor(t).length;
    tab = ['script', 'global', 'mine'].find(t => countFor(t) > 0) || 'script';
    const paintTabs = () => {
      $$('.mtabs button').forEach(b => {
        b.textContent = TAB_LABELS[b.dataset.t] + ' · ' + countFor(b.dataset.t);
        b.classList.toggle('on', b.dataset.t === tab);
      });
    };
    paintTabs();
    $('#mSearch').oninput = draw;
    draw();

    $('#mNew').onclick = async () => {
      const name = prompt('MOD 名称');
      if (!name) return;
      const scope = tab === 'script' ? 'script' : 'global';
      const m = await api('/mods', {
        method: 'POST',
        body: { name, scope, script_id: scope === 'script' ? sid : '', group: '通用', content: '', enabled: true },
      });
      allMods.push(m);
      overrides[m.id] = true;
      toast('已创建', 'ok');
      draw();
    };

    $('#mClose').onclick = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) mask.remove(); };

    $('#mSave').onclick = async () => {
      try {
        await api('/scripts/' + sid, { method: 'PUT', body: { mod_overrides: overrides } });
        toast('已保存（只影响这一部）', 'ok');
        mask.remove();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function openModEditorFromChat(id, script) {
    const m = await api('/mods/' + id);
    main.innerHTML = `
      <h1>编辑 MOD</h1>
      <div class="sub">改完回剧本继续。</div>
      <div class="row" style="margin-bottom:14px">
        <input id="em_n" value="${esc(m.name)}" placeholder="名称" style="flex:1">
        <select id="em_s" style="flex:0 0 150px">
          <option value="global" ${(m.scope || 'global') === 'global' ? 'selected' : ''}>公用（多剧本）</option>
          <option value="script" ${m.scope === 'script' ? 'selected' : ''}>专用（本剧本）</option>
        </select>
      </div>
      <label class="fld"><span>内容</span><textarea id="em_c" style="min-height:340px">${esc(m.content)}</textarea></label>
      <div class="row">
        <button class="btn" id="em_save">保存</button>
        <button class="btn ghost" id="em_cancel">返回剧本</button>
      </div>
    `;
    $('#em_cancel').onclick = () => { state.chat.scriptId = script.id; setView('chat'); };
    $('#em_save').onclick = async () => {
      const scope = $('#em_s').value;
      await api('/mods/' + id, {
        method: 'PUT',
        body: {
          name: $('#em_n').value.trim(),
          content: $('#em_c').value,
          scope,
          script_id: scope === 'script' ? script.id : '',
        },
      });
      toast('已保存', 'ok');
      state.chat.scriptId = script.id;
      setView('chat');
    };
  }

  /* ═══════════ prompt 预览弹层 ═══════════ */
  function showPrompt(r) {
    const mask = document.createElement('div');
    mask.className = 'mask';
    const rows = (r.report || []).map(it =>
      `<tr><td style="padding:3px 10px 3px 0">${esc(it[0])}</td><td style="padding:3px 10px 3px 0;text-align:right">${it[1]}</td><td style="padding:3px 0;color:#5f6675">${esc(it[2])}</td></tr>`
    ).join('');
    mask.innerHTML = `
      <div class="modal" style="width:min(1000px,96vw)">
        <div class="hd">
          <div><h2>这一轮会发给 AI 的内容</h2><div class="sub">system ${r.total_chars} 字</div></div>
          <span style="flex:1"></span>
          <button class="btn ghost sm" id="pClose">关闭</button>
        </div>
        <div class="bd">
          <table style="font-size:12.5px;margin-bottom:16px">${rows}</table>
          <div style="background:#12151c;border:1px solid #22262f;border-radius:9px;padding:14px;font-size:12.5px;line-height:1.85;white-space:pre-wrap;color:#b9bfcc;max-height:44vh;overflow:auto">${esc(r.system)}</div>
        </div>
      </div>`;
    document.body.appendChild(mask);
    $('#pClose').onclick = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
  }

  /* ═══════════ 渲染 ═══════════ */
  async function render() {
    try {
      const v = state.view;
      if (v === 'scripts') await renderScripts();
      else if (v === 'characters') await renderCharacters();
      else if (v === 'worldbook') await renderWorldbook();
      else if (v === 'mods') await renderMods();
      else if (v === 'settings') await renderSettings();
      else if (v === 'chat') await renderChat();
    } catch (e) {
      main.innerHTML = `<div class="banner">加载失败：${esc(e.message)}</div>`;
    }
  }

  (async () => {
    try {
      const h = await api('/health');
      $('#health').textContent = 'v' + h.version + ' · 已连接';
    } catch {
      $('#health').textContent = '未连接';
    }
    setView('scripts');
  })();
})();
