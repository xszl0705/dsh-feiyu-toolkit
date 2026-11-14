/**
 * dsh-rp-mode · 独立卡库页（给「手机上不是网页版」的场景用）
 *
 * 背景：卡库面板原本由 host 注入 index.html，只有 DSH 的 web 前端能看到。
 * 用 DSH Go 这类原生客户端时（走 SSH / DSH Remote），App 不加载网页，面板就没了。
 * 但面板的数据全在三条只读路由上（/cards /cover /meta），跟 WebSocket、mux 一点关系都没有 ——
 * 所以单独开一页静态 HTML 就够了：手机浏览器打开 /dsh-rp-mode/picker，
 * 挑完卡点「复制指令」，回 App 粘进输入框。
 */

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#14161c;color:#e8eaf0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
header{position:sticky;top:0;z-index:5;background:rgba(20,22,28,.96);border-bottom:1px solid rgba(255,255,255,.09);padding:8px 10px;backdrop-filter:blur(8px)}
h1{margin:0 0 6px;font-size:14px;font-weight:600;opacity:.9}
input{width:100%;padding:9px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;font-size:15px;outline:none}
input:focus{border-color:rgba(120,180,255,.7)}
.chips{display:flex;gap:6px;overflow-x:auto;padding:8px 0 2px;-webkit-overflow-scrolling:touch}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.16);font-size:12px;white-space:nowrap;cursor:pointer}
.chip.on{border-color:rgba(120,180,255,.7);background:rgba(120,180,255,.2)}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:10px}
.card{position:relative;border-radius:9px;overflow:hidden;background:rgba(255,255,255,.05);cursor:pointer;border:2px solid transparent}
.card.on{border-color:rgba(120,180,255,.9)}
.card img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;background:rgba(255,255,255,.04)}
.card .n{position:absolute;left:0;right:0;bottom:0;padding:12px 6px 5px;font-size:11px;line-height:1.3;background:linear-gradient(transparent,rgba(0,0,0,.85));word-break:break-all}
.card .r{position:absolute;top:4px;right:4px;padding:1px 5px;border-radius:5px;font-size:10px;background:rgba(0,0,0,.6)}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:9;display:none;gap:8px;align-items:center;padding:10px 10px calc(10px + env(safe-area-inset-bottom));background:rgba(26,29,38,.98);border-top:1px solid rgba(255,255,255,.12)}
.bar.on{display:flex}
.bar .name{flex:1;min-width:0;font-size:12px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{padding:9px 14px;border-radius:9px;border:1px solid rgba(140,180,255,.55);background:rgba(70,110,190,.35);color:#eaf1ff;font-size:13px;font-weight:600;cursor:pointer}
button:active{transform:scale(.97)}
#toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:rgba(60,140,90,.92);font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.on{opacity:1}
#empty{padding:40px 20px;text-align:center;opacity:.55}
`

const SCRIPT = `
var state={q:'',l1:'',rating:'',active:null,items:[]};
var grid=document.getElementById('grid');
var bar=document.getElementById('bar');
var barName=document.getElementById('barName');
var toast=document.getElementById('toast');

function el(t,c){var d=document.createElement(t);if(c)d.className=c;return d}

function api(path){
  return fetch(path,{cache:'no-store'}).then(function(r){return r.json()})
}

function render(){
  grid.innerHTML='';
  if(!state.items.length){
    var e=el('div');e.id='empty';e.textContent='没有匹配的卡，换个词试试';grid.appendChild(e);return;
  }
  state.items.forEach(function(it){
    var c=el('div','card');
    if(state.active&&state.active.id===it.id)c.className='card on';
    var img=el('img');img.loading='lazy';img.src=it.thumb||it.cover||'';
    img.alt='';
    c.appendChild(img);
    var n=el('div','n');n.textContent=it.name||'';c.appendChild(n);
    if(it.rating){var r=el('div','r');r.textContent=it.rating.toUpperCase();c.appendChild(r)}
    c.onclick=function(){pick(it,c)};
    grid.appendChild(c);
  });
}

function pick(it,node){
  state.active=it;
  Array.prototype.forEach.call(grid.children,function(x){x.className='card'});
  if(node)node.className='card on';
  bar.className='bar on';
  barName.textContent=it.name||'';
  if(window.navigator&&navigator.vibrate)try{navigator.vibrate(12)}catch(e){}
}

function instruct(it){
  return 'rp_card(action=pick, name="'+(it.name||'')+'")';
}

function legacyCopy(text){
  var ta=document.createElement('textarea');
  ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy')}catch(e){}
  document.body.removeChild(ta);
  return Promise.resolve();
}

function copy(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    return navigator.clipboard.writeText(text).catch(function(){return legacyCopy(text)});
  }
  return legacyCopy(text);
}

function showToast(msg){
  toast.textContent=msg;toast.className='on';
  setTimeout(function(){toast.className=''},1400);
}

document.getElementById('doCopy').onclick=function(){
  if(!state.active)return;
  copy(instruct(state.active)).then(function(){showToast('已复制，回 App 粘贴即可')});
};

document.getElementById('q').oninput=function(){
  state.q=this.value;
  clearTimeout(window.__t);
  window.__t=setTimeout(load,220);
};

function chip(label,key,value){
  var b=el('div','chip'+(state[key]===value?' on':''));
  b.textContent=label;
  b.onclick=function(){
    state[key]=state[key]===value?'':value;
    location.hash='';
    boot();
  };
  return b;
}

function renderChips(meta){
  var box=document.getElementById('chips');
  box.innerHTML='';
  box.appendChild(chip('全部','l1',''));
  ((meta&&meta.levels&&meta.levels.l1)||[]).forEach(function(x){box.appendChild(chip(x.label,'l1',x.id))});
  var sep=el('div','chip');sep.textContent='·';sep.style.opacity='.3';sep.style.pointerEvents='none';
  box.appendChild(sep);
  [['SFW','sfw'],['轻度','light'],['NSFW','nsfw'],['重口','hard']].forEach(function(p){
    box.appendChild(chip(p[0],'rating',p[1]));
  });
}

function load(){
  var q='./cards?limit=48';
  if(state.q)q+='&q='+encodeURIComponent(state.q);
  if(state.l1)q+='&l1='+encodeURIComponent(state.l1);
  if(state.rating)q+='&rating='+encodeURIComponent(state.rating);
  api(q).then(function(data){
    state.items=(data&&data.items)||[];
    render();
  }).catch(function(){
    state.items=[];render();
  });
}

function boot(){
  api('./meta').then(renderChips).catch(function(){renderChips(null)});
  load();
}

boot();
`

const BODY = `
<header>
  <h1>🎴 卡库 · 选卡</h1>
  <input id="q" placeholder="搜卡名 / 标签，例如「病娇 御姐」" autocomplete="off">
  <div class="chips" id="chips"></div>
</header>
<div id="grid"></div>
<div class="bar" id="bar">
  <div class="name" id="barName"></div>
  <button id="doCopy">复制选用指令</button>
</div>
<div id="toast"></div>
`

export const PICKER_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<title>卡库 · 选卡</title><style>',
  STYLE,
  '</style></head><body>',
  BODY,
  '<script>',
  SCRIPT,
  '</script></body></html>',
].join('')

/** 独立卡库页：纯静态，只用三条只读路由，不依赖注入、不依赖 WebSocket。 */
export function pickerHandler() {
  return (req, res) => {
    try {
      const buf = Buffer.from(PICKER_HTML, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(buf.length),
        'cache-control': 'no-store',
      })
      res.end(buf)
    } catch {
      // 响应对象不可用就算了
    }
  }
}
