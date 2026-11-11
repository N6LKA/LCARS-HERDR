'use strict';
/* LCARS Claude front end: workspaces of live terminals served by herdr-core. */

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const STATUS_WORD = { working: 'WORKING', blocked: 'NEEDS YOU', done: 'DONE', idle: 'IDLE', live: 'LIVE', ended: 'ENDED' };
const STATUS_COLOR = { working: 'var(--s-working)', blocked: 'var(--s-blocked)', done: 'var(--s-done)', idle: 'var(--s-idle)', live: 'var(--s-live)', ended: 'var(--s-ended)' };
const NEW_KIND = { claude: 'NEW CLAUDE SESSION', shell: 'NEW SHELL' };

const S = {
  terms: new Map(),     // address -> terminal facts from the core
  ws: [],               // workspaces: {id, name, panes:[address], layout:'cols'|'rows'}
  active: null,         // active workspace id
  zoom: null,           // address shown alone, or null
  focus: null,          // focused pane address
  docVersion: 0,
  sound: localStorage.getItem('lcars-sound') !== 'off',
  prevStatus: new Map(),
  firstSnapshot: true,
};
const P = new Map();    // address -> Pane (only the active workspace's panes are attached)

// ── helpers ───────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 3200);
}
function stateOf(t) {
  if (t.state && t.state !== 'live') return 'ended';
  return (t.status && t.status.state) || 'live';
}
const isAgent = t => !!(t.status && t.status.app) || (t.labels && t.labels.kind === 'claude');
const ORDER = { blocked: 0, working: 1, done: 2, idle: 3, live: 4, ended: 5 };
const TRICORDER = '<span class="tri"><i></i><i></i><i></i><i></i></span>';
function ageOf(t) {
  const ms = Date.now() - (t.status_ms || t.created_ms || Date.now());
  const m = Math.floor(ms / 60000);
  return m < 1 ? '<1M' : m < 60 ? `${m}M` : m < 1440 ? `${Math.floor(m / 60)}H` : `${Math.floor(m / 1440)}D`;
}
const labelOf = t => t.name || (t.labels && t.labels.kind) || (t.argv && t.argv[0] && t.argv[0].split('/').pop()) || t.address;
const wsActive = () => S.ws.find(w => w.id === S.active) || S.ws[0];

// ── workspaces and layout persistence ─────────────────────────────────
async function loadLayout() {
  let doc = { version: 0, value: null };
  try { doc = await api('/api/doc/lcars-web'); } catch (e) { toast('Layout unavailable: ' + e.message, true); }
  S.docVersion = doc.version || 0;
  const v = doc.value;
  if (v && Array.isArray(v.workspaces) && v.workspaces.length) { S.ws = v.workspaces; S.active = v.active; }
  else { S.ws = [{ id: uid(), name: 'BRIDGE', panes: [], layout: 'cols' }]; }
  if (!S.ws.some(w => w.id === S.active)) S.active = S.ws[0].id;
}
let saveT;
function saveLayout() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const body = () => JSON.stringify({ value: { workspaces: S.ws, active: S.active }, version: S.docVersion });
    const put = () => api('/api/doc/lcars-web', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: body() });
    try { S.docVersion = (await put()).version; }
    catch {
      try { S.docVersion = (await api('/api/doc/lcars-web')).version; S.docVersion = (await put()).version; } catch {}
    }
  }, 400);
}
function addPane(addr, wsId = S.active) {
  const w = S.ws.find(x => x.id === wsId);
  if (!w.panes.includes(addr)) w.panes.push(addr);
  S.focus = addr; S.zoom = null; saveLayout(); render();
}
function removePane(addr) {
  const w = wsActive();
  w.panes = w.panes.filter(a => a !== addr);
  if (S.zoom === addr) S.zoom = null;
  if (S.focus === addr) S.focus = w.panes[0] || null;
  saveLayout(); render();
}
function newWorkspace() {
  const name = (prompt('Workspace name', `WORKSPACE ${S.ws.length + 1}`) || '').trim().slice(0, 24);
  if (!name) return;
  const w = { id: uid(), name: name.toUpperCase(), panes: [], layout: 'cols' };
  S.ws.push(w); S.active = w.id; S.zoom = null; saveLayout(); render();
}
function closeWorkspace(id) {
  if (S.ws.length < 2) return;
  const w = S.ws.find(x => x.id === id);
  if (w.panes.length && !confirm(`Close ${w.name}? Its terminals keep running.`)) return;
  S.ws = S.ws.filter(x => x.id !== id);
  if (S.active === id) S.active = S.ws[0].id;
  S.zoom = null; saveLayout(); render();
}

// ── terminals ─────────────────────────────────────────────────────────
async function refreshTerms() {
  const data = await api('/api/terminals');
  const seen = new Set();
  for (const t of data.terminals) {
    seen.add(t.address);
    const now = stateOf(t), was = S.prevStatus.get(t.address);
    if (!S.firstSnapshot && was !== now) statusChanged(t, was, now);
    S.prevStatus.set(t.address, now);
    S.terms.set(t.address, t);
  }
  for (const a of [...S.terms.keys()]) if (!seen.has(a)) { S.terms.delete(a); S.prevStatus.delete(a); }
  S.firstSnapshot = false;
  render();
}
function statusChanged(t, was, now) {
  if (now === 'blocked') { play('tng_red_alert3'); toast(`${labelOf(t)} NEEDS YOU`, true); }
  else if (now === 'done' && was === 'working') { play('padd_1'); toast(`${labelOf(t)} DONE`); }
}
const sounds = {};
function play(name) {
  if (!S.sound) return;
  try {
    const a = sounds[name] || (sounds[name] = new Audio(`/static/audio/${name}.mp3`));
    a.currentTime = 0; a.volume = name.includes('alert') ? 0.5 : 0.7; a.play().catch(() => {});
  } catch {}
}
async function startSession(kind) {
  const dlg = $('#new-dlg');
  $('#new-title').textContent = NEW_KIND[kind];
  $('#new-name').value = '';
  dlg.returnValue = ''; dlg.dataset.kind = kind; dlg.showModal(); $('#new-name').focus();
}
async function createSession(kind, name, cwd) {
  try {
    const t = await post('/api/terminals', { kind, name: name || undefined, cwd: cwd || undefined, cols: 120, rows: 32 });
    S.terms.set(t.address, t);
    addPane(t.address);
    refreshTerms().catch(() => {});
  } catch (e) { toast(e.message, true); }
}
async function killTerminal(addr) {
  const t = S.terms.get(addr);
  if (!confirm(`End ${t ? labelOf(t) : addr}? The program running in it will stop.`)) return;
  try { await api('/api/terminals?terminal=' + encodeURIComponent(addr), { method: 'DELETE' }); } catch (e) { toast(e.message, true); }
}

// ── panes: one xterm.js attached to one core terminal ─────────────────
const XTERM_THEME = {
  background: '#000000', foreground: '#ffe6cc', cursor: '#ff9900', cursorAccent: '#000000', selectionBackground: '#7a4a10aa',
  black: '#000000', red: '#ff5544', green: '#7fd17f', yellow: '#ffcc66', blue: '#5599ff', magenta: '#cc99cc', cyan: '#99ccff', white: '#ffcc99',
  brightBlack: '#666688', brightRed: '#ff7766', brightGreen: '#9be89b', brightYellow: '#ffe08a', brightBlue: '#99bbff', brightMagenta: '#e0b0e0', brightCyan: '#bde0ff', brightWhite: '#ffffff',
};

class Pane {
  constructor(addr) {
    this.addr = addr; this.ws = null; this.dead = false; this.retry = 0;
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.innerHTML = `<div class="pane-h"><span class="cap"></span><span class="title"></span>${TRICORDER}<span class="st"></span>
      <button data-a="zoom" title="Fill the workspace">ZOOM</button><button data-a="file" title="Send a file">FILE</button>
      <button data-a="close" class="close" title="Remove from this workspace (keeps running)">✕</button></div>
      <div class="pane-b"><span class="pane-msg">RECONNECTING</span></div>`;
    this.body = $('.pane-b', this.el);
    this.term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'), fontSize: 14, lineHeight: 1.05,
      cursorBlink: true, scrollback: 5000, theme: XTERM_THEME, allowProposedApi: true, macOptionIsMeta: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    try { const u = new Unicode11Addon.Unicode11Addon(); this.term.loadAddon(u); this.term.unicode.activeVersion = '11'; } catch {}
    this.term.open(this.body);
    this.term.onData(d => this.send({ type: 'input', data: d }));
    this.term.onBinary(b => { if (this.ws && this.ws.readyState === 1) this.ws.send(Uint8Array.from(b, c => c.charCodeAt(0))); });
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.body);
    this.el.addEventListener('mousedown', () => setFocus(addr), true);
    this.el.addEventListener('focusin', () => setFocus(addr));
    this.el.addEventListener('click', ev => {
      const a = ev.target.dataset && ev.target.dataset.a;
      if (a === 'close') removePane(addr);
      else if (a === 'zoom') { S.zoom = S.zoom === addr ? null : addr; render(); }
      else if (a === 'file') { setFocus(addr); $('#file-input').click(); }
    });
    this.body.addEventListener('paste', ev => this.onPaste(ev), true);
    ['dragenter', 'dragover'].forEach(n => this.el.addEventListener(n, ev => { if (hasFiles(ev)) { ev.preventDefault(); this.el.classList.add('drop'); } }));
    ['dragleave', 'drop'].forEach(n => this.el.addEventListener(n, () => this.el.classList.remove('drop')));
    this.el.addEventListener('drop', ev => { if (hasFiles(ev)) { ev.preventDefault(); this.sendFiles([...ev.dataTransfer.files]); } });
    this.connect();
  }
  refit() { try { if (this.el.offsetParent) this.fit.fit(); } catch {} }
  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  connect() {
    if (this.dead) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.refit();
    const url = `${proto}://${location.host}/ws/term?terminal=${encodeURIComponent(this.addr)}&cols=${this.term.cols}&rows=${this.term.rows}`;
    const ws = (this.ws = new WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.retry = 0; this.el.classList.remove('down'); };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'closed') {
          this.ended = true;
          const r = m.reason || {};
          this.term.write('\r\n\x1b[38;5;208m[ terminal ended ]\x1b[0m\r\n');
          // A clean exit or an end-it-yourself closes the pane; a crash stays so its last output can be read.
          if (r.reason === 'killed' || (r.reason === 'exited' && !r.exit_code)) setTimeout(() => removePane(this.addr), 600);
        }
        else if (m.type === 'error') { this.term.write(`\r\n\x1b[31m[ ${m.error} ]\x1b[0m\r\n`); this.ended = true; }
        return;
      }
      this.term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (this.dead || this.ended) return;
      this.el.classList.add('down');
      setTimeout(() => this.connect(), Math.min(5000, 600 * ++this.retry));
    };
  }
  async sendFiles(files) {
    for (const f of files) {
      if (f.size > 8 * 1024 * 1024) { toast(`${f.name} is larger than 8 MB`, true); continue; }
      const fd = new FormData(); fd.append('terminal', this.addr); fd.append('file', f, f.name || 'pasted-image.png');
      try {
        const r = await fetch('/api/terminals/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
        const { path } = await r.json();
        this.term.paste(path + ' ');   // bracketed paste, so Claude sees it as an attached file
        toast(`SENT ${f.name || 'IMAGE'}`);
      } catch (e) { toast(`Upload failed: ${e.message}`, true); }
    }
    this.term.focus();
  }
  onPaste(ev) {
    const files = [...(ev.clipboardData ? ev.clipboardData.files : [])];
    if (!files.length) return;           // plain text: let the terminal handle it
    ev.preventDefault(); ev.stopPropagation();
    this.sendFiles(files);
  }
  update() {
    const t = S.terms.get(this.addr), st = t ? stateOf(t) : 'ended';
    this.el.style.setProperty('--c', STATUS_COLOR[st]);
    this.el.classList.toggle('blocked', st === 'blocked');
    this.el.dataset.state = st;
    $('.title', this.el).textContent = t ? `${labelOf(t)} · ${this.addr}${t.cwd ? ' · ' + t.cwd : ''}` : this.addr;
    $('.st', this.el).textContent = STATUS_WORD[st];
    $('[data-a=zoom]', this.el).textContent = S.zoom === this.addr ? 'RESTORE' : 'ZOOM';
  }
  destroy() {
    this.dead = true; this.ro.disconnect();
    try { this.ws && this.ws.close(); } catch {}
    this.term.dispose(); this.el.remove();
  }
}
const hasFiles = ev => ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files');
function setFocus(addr) {
  if (S.focus === addr && P.get(addr) && P.get(addr).el.classList.contains('focus')) return;
  S.focus = addr;
  for (const [a, p] of P) p.el.classList.toggle('focus', a === addr);
}

// ── rendering ─────────────────────────────────────────────────────────
function render() {
  renderTabs(); renderTerms(); renderAgents(); renderPanes(); renderFoot();
}
function renderTabs() {
  const box = $('#tabs'); box.textContent = '';
  for (const w of S.ws) {
    const b = document.createElement('div');
    b.className = 'tab' + (w.id === S.active ? ' on' : '');
    b.innerHTML = '<span></span>' + (S.ws.length > 1 ? '<button class="x" title="Close workspace">×</button>' : '');
    b.firstChild.textContent = w.name;
    b.onclick = ev => {
      if (ev.target.classList.contains('x')) return closeWorkspace(w.id);
      if (S.active !== w.id) { S.active = w.id; S.zoom = null; S.focus = w.panes[0] || null; saveLayout(); render(); }
    };
    b.ondblclick = () => {
      const n = (prompt('Rename workspace', w.name) || '').trim().slice(0, 24);
      if (n) { w.name = n.toUpperCase(); saveLayout(); render(); }
    };
    box.appendChild(b);
  }
  $('#layout-btn').textContent = wsActive().layout === 'cols' ? 'SPLIT ▥' : 'SPLIT ▤';
}
function renderTerms() {
  const box = $('#terms'); box.textContent = '';
  const inWs = new Set(wsActive().panes);
  const list = [...S.terms.values()].filter(t => !isAgent(t)).sort((a, b) => a.created_ms - b.created_ms);
  for (const t of list) {
    const st = stateOf(t);
    const row = document.createElement('div');
    row.className = `term ${st}` + (inWs.has(t.address) ? ' in' : '');
    row.style.setProperty('--c', STATUS_COLOR[st]);
    row.innerHTML = '<span class="dot"></span><button class="nm"></button><button class="kill" title="End this terminal">⏻</button>';
    $('.nm', row).innerHTML = '<span></span><small></small>';
    $('.nm span', row).textContent = labelOf(t);
    $('.nm small', row).textContent = `${t.address} · ${STATUS_WORD[st]}`;
    $('.nm', row).onclick = () => { addPane(t.address); document.body.classList.remove('side-open'); };
    $('.kill', row).onclick = () => killTerminal(t.address);
    box.appendChild(row);
  }
  if (!list.length) box.innerHTML = '<div class="rail-title" style="color:#9a8aa8">NO PLAIN TERMINALS</div>';
}
function renderAgents() {
  const box = $('#agents'); box.textContent = '';
  const inWs = new Set(wsActive().panes);
  const list = [...S.terms.values()].filter(isAgent)
    .sort((a, b) => (ORDER[stateOf(a)] - ORDER[stateOf(b)]) || (a.created_ms - b.created_ms));
  const n = s => list.filter(t => stateOf(t) === s).length;
  $('#agents-title').textContent = list.length ? `AGENTS · ${n('working')} WORKING${n('blocked') ? ` · ${n('blocked')} NEED YOU` : ''}` : 'AGENTS';
  for (const t of list) {
    const st = stateOf(t);
    const row = document.createElement('div');
    row.className = 'agent' + (inWs.has(t.address) ? ' in' : '');
    row.dataset.state = st;
    row.style.setProperty('--c', STATUS_COLOR[st]);
    row.innerHTML = '<span class="blk"></span>' + TRICORDER + '<button class="nm"></button><button class="kill" title="End this agent">⏻</button>';
    $('.blk', row).textContent = STATUS_WORD[st];
    $('.nm', row).innerHTML = '<span></span><small></small>';
    $('.nm span', row).textContent = labelOf(t);
    $('.nm small', row).textContent = `${(t.cwd || '').split('/').pop() || '/'} · ${ageOf(t)}`;
    $('.nm', row).onclick = () => {
      if (inWs.has(t.address)) { setFocus(t.address); const p = P.get(t.address); if (p) p.term.focus(); }
      else addPane(t.address);
      document.body.classList.remove('side-open');
    };
    $('.kill', row).onclick = () => killTerminal(t.address);
    box.appendChild(row);
  }
  if (!list.length) box.innerHTML = '<div class="rail-title" style="color:#9a8aa8">NO AGENTS</div>';
}
function renderPanes() {
  const w = wsActive();
  const want = S.zoom && w.panes.includes(S.zoom) ? [S.zoom] : w.panes.filter(a => S.terms.has(a) || P.has(a));
  for (const [a, p] of [...P]) if (!want.includes(a)) { p.destroy(); P.delete(a); }
  const box = $('#panes');
  for (const a of want) if (!P.has(a)) P.set(a, new Pane(a));
  want.forEach((a, i) => { const p = P.get(a); if (box.children[i] !== p.el) box.insertBefore(p.el, box.children[i] || null); });
  const n = want.length, cols = w.layout === 'cols';
  let c = 1, r = 1;
  if (n > 1) {
    if (n === 2) { c = cols ? 2 : 1; r = cols ? 1 : 2; }
    else { c = Math.ceil(Math.sqrt(n)); r = Math.ceil(n / c); if (!cols) [c, r] = [r, c]; }
  }
  box.style.gridTemplateColumns = `repeat(${c},minmax(0,1fr))`;
  box.style.gridTemplateRows = `repeat(${r},minmax(0,1fr))`;
  document.body.classList.toggle('no-panes', n === 0);
  for (const [a, p] of P) { p.update(); p.el.classList.toggle('focus', a === S.focus); }
  requestAnimationFrame(() => P.forEach(p => p.refit()));
}
function renderFoot() {
  const all = [...S.terms.values()].map(stateOf);
  const n = s => all.filter(x => x === s).length;
  $('#f-counts').textContent = `${all.length} TERMINALS · ${n('working')} WORKING · ${n('blocked')} NEED YOU · ${n('done')} DONE`;
}

// ── event feed ────────────────────────────────────────────────────────
let evWS, evRetry = 0, refreshT;
function connectEvents() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  evWS = new WebSocket(`${proto}://${location.host}/ws/events`);
  evWS.onopen = () => { evRetry = 0; setConn(true); refreshTerms().catch(() => {}); };
  evWS.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'snapshot') { $('#f-core').textContent = `CORE · SEQ ${m.seq}`; }
    else if (m.type === 'notification' && m.method === 'event') {
      clearTimeout(refreshT); refreshT = setTimeout(() => refreshTerms().catch(() => {}), 120);
    } else if (m.type === 'error') { toast(m.error, true); }
  };
  evWS.onclose = () => { setConn(false); setTimeout(connectEvents, Math.min(8000, 700 * ++evRetry)); };
}
function setConn(ok) {
  const c = $('#conn'); c.textContent = ok ? 'LINK OK' : 'LINK LOST'; c.className = 'pill ' + (ok ? 'ok' : 'bad');
}

// ── wiring ────────────────────────────────────────────────────────────
const KEYS = { esc: '\x1b', tab: '\t', 'ctrl-c': '\x03', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r' };
function init() {
  $('#new-claude').onclick = () => startSession('claude');
  $('#new-shell').onclick = () => startSession('shell');
  $('#add-ws').onclick = newWorkspace;
  $('#layout-btn').onclick = () => { const w = wsActive(); w.layout = w.layout === 'cols' ? 'rows' : 'cols'; saveLayout(); render(); };
  $('#menu-btn').onclick = () => document.body.classList.toggle('side-open');
  $('#main').addEventListener('click', () => document.body.classList.remove('side-open'));
  $('#upload-btn').onclick = () => { if (!S.focus) return toast('Focus a terminal first', true); $('#file-input').click(); };
  $('#file-input').onchange = ev => { const p = P.get(S.focus); if (p) p.sendFiles([...ev.target.files]); ev.target.value = ''; };
  $('#sound-btn').onclick = () => { S.sound = !S.sound; localStorage.setItem('lcars-sound', S.sound ? 'on' : 'off'); $('#sound-btn').textContent = S.sound ? 'SOUND ON' : 'SOUND OFF'; if (S.sound) play('keyok1'); };
  $('#sound-btn').textContent = S.sound ? 'SOUND ON' : 'SOUND OFF';
  $('#keybar').addEventListener('click', ev => { const k = ev.target.dataset && ev.target.dataset.k; const p = P.get(S.focus); if (k && p) { p.send({ type: 'input', data: KEYS[k] }); p.term.focus(); } });
  $('#new-dlg').addEventListener('close', ev => {
    const dlg = ev.target;
    if (dlg.returnValue === 'ok') createSession(dlg.dataset.kind, $('#new-name').value.trim(), $('#new-cwd').value.trim());
  });
  setInterval(renderAgents, 30000);
  setInterval(() => { $('#f-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
  // Paste of an image anywhere on the page goes to the focused terminal.
  document.addEventListener('paste', ev => {
    const files = [...(ev.clipboardData ? ev.clipboardData.files : [])];
    const p = P.get(S.focus);
    if (files.length && p && !p.el.contains(ev.target)) { ev.preventDefault(); p.sendFiles(files); }
  });
  window.addEventListener('resize', () => P.forEach(p => p.refit()));
}

(async function main() {
  init();
  await loadLayout();
  render();
  try { await refreshTerms(); } catch (e) { toast(e.message, true); }
  connectEvents();
})();
