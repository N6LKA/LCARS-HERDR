'use strict';
/* LCARS front end: spaces of tabs of split panes, each pane a live herdr-core terminal.
   The model, commands, shortcuts and menus follow the Herdr desktop app (Apache-2.0, herdrdev/herdr-app). */

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const DOC = new URLSearchParams(location.search).get('doc') || 'lcars-web';
const STATUS_WORD = { working: 'WORKING', blocked: 'NEEDS YOU', error: 'ERROR', done: 'DONE', idle: 'IDLE', live: 'LIVE', ended: 'ENDED' };
const STATUS_COLOR = { working: 'var(--s-working)', blocked: 'var(--s-blocked)', error: 'var(--red)', done: 'var(--s-done)', idle: 'var(--s-idle)', live: 'var(--s-live)', ended: 'var(--s-ended)' };
const RANK = { error: 5, blocked: 4, done: 3, working: 2, idle: 1, live: 0, ended: 0 };
const ORDER = { blocked: 0, error: 0.5, done: 1, working: 2, idle: 3, live: 4, ended: 5 };
const GROUPS = [['blocked', 'NEEDS YOU'], ['error', 'ERROR'], ['done', 'DONE'], ['working', 'WORKING'], ['idle', 'IDLE'], ['live', 'LIVE']];
const pad2 = n => String(n).padStart(2, '0');
const SPACE_COLORS = ['var(--tan)', 'var(--lilac)', 'var(--peach)', 'var(--sky)', 'var(--violet)', 'var(--gold)'];
const BARS = '<i></i><i></i><i></i><i></i>';
const TRICORDER = `<span class="tri">${BARS}</span>`;

// Which finished runs this browser has already looked at, by terminal address and its turn counter. The core keeps a
// finished agent as "done" until someone views it; like the Herdr app, each viewer tracks that for itself, so a run
// you have seen shows IDLE here and one you have not shows DONE.
const VIEWED_KEY = 'lcars-viewed';
const viewed = (() => { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}'))); } catch { return new Map(); } })();
function markViewed() {
  if (!S.focus || !document.hasFocus() || document.hidden) return false;
  const t = S.terms.get(S.focus), p = P.get(S.focus);
  if (!t || !p || p.el.offsetParent === null || !(t.status && t.status.state === 'done') || viewed.get(t.address) === t.turn) return false;
  viewed.set(t.address, t.turn);
  for (const a of [...viewed.keys()]) if (!S.terms.has(a)) viewed.delete(a);
  try { localStorage.setItem(VIEWED_KEY, JSON.stringify(Object.fromEntries(viewed))); } catch {}
  return true;
}
const S = {
  terms: new Map(),      // address -> terminal facts from the core
  spaces: [],            // [{id, name|null, tab, tabs:[{id, name|null, root}]}]
  active: null,          // active space id
  zoomed: {},            // tab id -> zoomed pane address (this browser only)
  focus: null,           // focused pane address
  docVersion: 0,
  sound: localStorage.getItem('lcars-sound') !== 'off',
  font: Number(localStorage.getItem('lcars-font-v2')) || 15,
  prev: new Map(),       // address -> last status, for alerts
  fresh: new Map(),      // address -> time created here, so a new terminal is not pruned before the list has it
  first: true,
  dismissed: new Set(),   // helpers the user closed or hid: never reopened automatically (saved with the layout)
  autoOpen: localStorage.getItem('lcars-autoopen') !== 'off',
  agents: [],            // coding agents this server knows, with an installed flag (from /api/agents)
  agentEnv: '',
  coreName: '',          // this server's core name, the default name of the machine it runs on
  localName: '',         // the name shown for this server instead, set by renaming it (kept in the layout)
  machines: [],          // other machines added to the core, with their connection state
  linkOk: false,
  remoteVersion: 0,      // newest layout version another browser announced
  saving: false,
};
const P = new Map();     // address -> Pane (only panes of the active tab)
window.P = P; window.S = S;

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
const stateOf = t => (t.state && t.state !== 'live') ? 'ended' : (t.status && t.status.state === 'done' && viewed.get(t.address) === t.turn ? 'idle' : ((t.status && t.status.state) || 'live'));
const isAgent = t => !!(t.status && t.status.app) || (t.labels && (t.labels.kind === 'claude' || t.labels.kind === 'agent'));
const agentById = id => S.agents.find(a => a.id === id);
const PROGRAMS = { claude: 'Claude Code', 'claude-code': 'Claude Code', copilot: 'GitHub Copilot', codex: 'OpenAI Codex', grok: 'Grok', opencode: 'OpenCode',
  'cursor-agent': 'Cursor Agent', agent: 'Cursor Agent', amp: 'Amp', pi: 'Pi', agy: 'Antigravity', gemini: 'Gemini CLI',
  bash: 'Shell', zsh: 'Shell', sh: 'Shell', fish: 'Shell', dash: 'Shell' };
function programName(t) {   // what is running in it right now, e.g. "Claude Code" or "Shell"
  const p = ((t.foreground && t.foreground.name) || (t.argv && t.argv[0]) || '').split('/').pop();
  return PROGRAMS[p] || p || 'Terminal';
}
const labelOf = t => (t.labels && t.labels.title) || t.name || (t.labels && t.labels.agent && (agentById(t.labels.agent) || {}).name) || programName(t) || t.address;
const folderOf = t => (((t.foreground && t.foreground.cwd) || t.cwd || '').split('/').filter(Boolean).pop()) || '/';
const cwdOf = addr => { const t = S.terms.get(addr); return t ? ((t.foreground && t.foreground.cwd) || t.cwd) : undefined; };
function ageOf(t) {
  const m = Math.floor((Date.now() - (t.status_ms || t.created_ms || Date.now())) / 60000);
  return m < 1 ? '<1M' : m < 60 ? `${m}M` : m < 1440 ? `${Math.floor(m / 60)}H` : `${Math.floor(m / 1440)}D`;
}
function topState(addrs) {  // the most urgent state among terminals: blocked > done > working > idle
  let best = 'live';
  for (const a of addrs) { const t = S.terms.get(a); if (!t) continue; const s = stateOf(t); if (RANK[s] > RANK[best]) best = s; }
  return best;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── the split tree ────────────────────────────────────────────────────
// node: {t:'p', a:address}  |  {t:'s', d:'row'|'col', c:[node...], w:[weight...]}
const leaf = a => ({ t: 'p', a });
const isLeaf = n => n.t === 'p';
function leaves(n, out = []) { if (!n) return out; if (isLeaf(n)) out.push(n.a); else n.c.forEach(c => leaves(c, out)); return out; }
function insertBeside(n, addr, dir, newAddr, before = false) {
  if (isLeaf(n)) return n.a === addr ? { t: 's', d: dir, c: before ? [leaf(newAddr), n] : [n, leaf(newAddr)], w: [1, 1] } : n;
  const i = n.c.findIndex(c => isLeaf(c) && c.a === addr);
  if (i >= 0 && n.d === dir) {           // same direction as the parent: add a sibling, sharing the old size
    const c = n.c.slice(), w = n.w.slice(), half = w[i] / 2, at = before ? i : i + 1;
    w[i] = half; c.splice(at, 0, leaf(newAddr)); w.splice(at, 0, half);
    return { ...n, c, w };
  }
  return { ...n, c: n.c.map(x => insertBeside(x, addr, dir, newAddr, before)) };
}
function removeLeaf(n, addr) {
  if (!n) return null;
  if (isLeaf(n)) return n.a === addr ? null : n;
  const c = [], w = [];
  n.c.forEach((x, i) => { const r = removeLeaf(x, addr); if (r) { c.push(r); w.push(n.w[i]); } });
  if (!c.length) return null;
  if (c.length === 1) return c[0];
  const sum = w.reduce((a, b) => a + b, 0);
  return { ...n, c, w: w.map(x => x * c.length / sum) };
}
function swapLeaves(n, a, b) {
  if (isLeaf(n)) return n.a === a ? leaf(b) : n.a === b ? leaf(a) : n;
  return { ...n, c: n.c.map(x => swapLeaves(x, a, b)) };
}
const newTab = (root = null) => ({ id: uid(), name: null, root });
const newSpace = (name, machine = '') => { const t = newTab(); return { id: uid(), name, tabs: [t], tab: t.id, ...(machine ? { machine } : {}) }; };
const curSpace = () => S.spaces.find(s => s.id === S.active) || S.spaces[0];
const curTab = () => { const sp = curSpace(); return sp && (sp.tabs.find(t => t.id === sp.tab) || sp.tabs[0]); };
function locate(addr) {
  for (const sp of S.spaces) for (const t of sp.tabs) if (leaves(t.root).includes(addr)) return { sp, tab: t };
  return null;
}
const spaceAddrs = sp => sp.tabs.flatMap(t => leaves(t.root));
// ── machines: this server is '' ; another machine added to the core is its name, and its terminals are `name/t7`
const MACHINE_COLORS = ['var(--peach)', 'var(--lilac)', 'var(--sky)', 'var(--gold)', 'var(--violet)', 'var(--tan)'];
const machineOf = addr => { const i = (addr || '').indexOf('/'); return i > 0 ? addr.slice(0, i) : ''; };
const spaceMachine = sp => (sp && sp.machine) || '';
const machineView = name => S.machines.find(m => m.name === name);
const machineLabel = name => (name || S.localName || S.coreName || '—').toUpperCase();
let collapsedMachines = (() => { try { return new Set(JSON.parse(localStorage.getItem('lcars-machines-collapsed') || '[]')); } catch { return new Set(); } })();
const spaceName = (sp, i) => sp.name || folderAutoName(sp) || `SPACE ${i + 1}`;
function folderAutoName(sp) {
  const a = sp.tabs.flatMap(t => leaves(t.root))[0]; const t = a && S.terms.get(a);
  return t ? folderOf(t).toUpperCase() : null;
}
function tabName(tab, i) {
  if (tab.name) return tab.name;
  for (const a of leaves(tab.root)) { const t = S.terms.get(a); if (t) return labelOf(t).toUpperCase(); }
  return `TAB ${i + 1}`;
}

// ── persistence (a document in herdr-core, shared by every browser) ───
async function loadLayout() {
  let doc = { version: 0, value: null };
  try { doc = await api(`/api/doc/${encodeURIComponent(DOC)}`); } catch (e) { toast('Layout unavailable: ' + e.message, true); }
  S.docVersion = doc.version || 0;
  const v = doc.value;
  S.localName = (v && v.localName) || '';
  if (v && v.v === 2 && Array.isArray(v.spaces) && v.spaces.length) { S.spaces = v.spaces; S.active = v.active; S.dismissed = new Set(v.dismissed || []); }
  else if (v && Array.isArray(v.workspaces) && v.workspaces.length) {       // first version: flat workspaces
    S.spaces = v.workspaces.map(w => {
      const addrs = w.panes || [];
      const root = addrs.length === 0 ? null : addrs.length === 1 ? leaf(addrs[0])
        : { t: 's', d: w.layout === 'rows' ? 'col' : 'row', c: addrs.map(leaf), w: addrs.map(() => 1) };
      const t = newTab(root); return { id: w.id || uid(), name: w.name, tabs: [t], tab: t.id };
    });
    S.active = v.active;
  } else S.spaces = [newSpace('BRIDGE')];
  for (const sp of S.spaces) { if (!sp.tabs || !sp.tabs.length) { const t = newTab(); sp.tabs = [t]; sp.tab = t.id; } }
  if (!S.spaces.some(s => s.id === S.active)) S.active = S.spaces[0].id;
}
let saveT = null;
function saveLayout() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const url = `/api/doc/${encodeURIComponent(DOC)}`;
    const put = () => api(url, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: { v: 2, spaces: S.spaces, active: S.active, dismissed: [...S.dismissed].slice(-200), localName: S.localName || undefined }, version: S.docVersion }) });
    saveT = null; S.saving = true;
    try { S.docVersion = (await put()).version; }
    catch { try { S.docVersion = (await api(url)).version; S.docVersion = (await put()).version; } catch {} }
    S.saving = false; maybeSync();
  }, 400);
}
// Another browser changed the layout: take its spaces, tabs and splits, but keep what this browser has
// selected, zoomed and focused (Herdr keeps those local too).
async function maybeSync() {
  if (S.saving || saveT || S.remoteVersion <= S.docVersion) return;
  try {
    const doc = await api(`/api/doc/${encodeURIComponent(DOC)}`);
    if (doc.version <= S.docVersion) return;
    S.docVersion = doc.version;
    const v = doc.value;
    if (!v || v.v !== 2 || !Array.isArray(v.spaces) || !v.spaces.length) return;
    const tabs = new Map(S.spaces.map(sp => [sp.id, sp.tab])), active = S.active;
    S.spaces = v.spaces; S.dismissed = new Set(v.dismissed || []); S.localName = v.localName || '';
    for (const sp of S.spaces) if (tabs.has(sp.id) && sp.tabs.some(t => t.id === tabs.get(sp.id))) sp.tab = tabs.get(sp.id);
    S.active = S.spaces.some(sp => sp.id === active) ? active : S.spaces[0].id;
    render();
  } catch {}
}
const commit = () => { saveLayout(); render(); };

// ── terminals ─────────────────────────────────────────────────────────
async function refreshTerms() {
  const data = await api('/api/terminals');
  S.machines = data.machines || [];
  const seen = new Set();
  for (const t of data.terminals) {
    seen.add(t.address);
    const now = stateOf(t), was = S.prev.get(t.address);
    if (!S.first && was !== now) statusChanged(t, was, now);
    S.prev.set(t.address, now); S.terms.set(t.address, t);
  }
  for (const a of [...S.terms.keys()]) if (!seen.has(a)) { S.terms.delete(a); S.prev.delete(a); }
  S.first = false;
  prune();
  adoptHelpers();
  render();
}
function prune() {   // drop panes whose terminal is gone (ended while this page was closed)
  const now = Date.now(); let changed = false;
  for (const [a, ts] of S.fresh) if (now - ts > 8000) S.fresh.delete(a);
  for (const sp of S.spaces) for (const tab of sp.tabs) {
    for (const a of leaves(tab.root)) {
      const mv = machineOf(a) && machineView(machineOf(a));
      if (machineOf(a) && !(mv && mv.state === 'connected')) continue;      // not connected (or not known yet): keep its panes
      if (!S.terms.has(a) && !S.fresh.has(a)) { tab.root = removeLeaf(tab.root, a); changed = true; }
    }
  }
  if (changed) saveLayout();
}
function adoptHelpers() {   // a terminal started by one of our panes opens beside it: first to the right, then stacked below
  if (!S.autoOpen) return;
  let changed = false;
  for (const t of S.terms.values()) {
    if (!t.parent || S.dismissed.has(t.address) || locate(t.address) || stateOf(t) === 'ended') continue;
    const loc = locate(t.parent); if (!loc) continue;
    const sibs = leaves(loc.tab.root).filter(a => { const x = S.terms.get(a); return x && x.parent === t.parent; });
    loc.tab.root = sibs.length ? insertBeside(loc.tab.root, sibs[sibs.length - 1], 'col', t.address) : insertBeside(loc.tab.root, t.parent, 'row', t.address);
    changed = true;
  }
  if (changed) saveLayout();
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
async function createTerminal(kind, opt = {}) {
  const machine = opt.machine !== undefined ? opt.machine : spaceMachine(curSpace());
  // a folder belongs to one machine: use it only if it was typed, or comes from a pane on the same machine
  const cwd = opt.cwd && (opt.explicit || opt.machine !== undefined || machineOf(S.focus || '') === machine) ? opt.cwd : undefined;
  const t = await post('/api/terminals', { kind, agent: opt.agent || undefined, name: opt.name || undefined, cwd: cwd || undefined, on: machine || undefined, cols: 120, rows: 32 });
  S.terms.set(t.address, t); S.fresh.set(t.address, Date.now());
  return t.address;
}
async function endTerminal(addr) {
  try { await api('/api/terminals?terminal=' + encodeURIComponent(addr), { method: 'DELETE' }); } catch (e) { toast(e.message, true); }
}
const agentLive = addr => { const t = S.terms.get(addr); return !!t && isAgent(t) && stateOf(t) !== 'ended'; };

// ── layout operations ─────────────────────────────────────────────────
function focusPane(addr) {
  if (!addr) return;
  S.focus = addr;
  requestAnimationFrame(() => { const p = P.get(addr); if (p) { for (const [a, q] of P) q.el.classList.toggle('focus', a === addr); p.term.focus(); } if (markViewed()) render(); });
}
function dropFromTree(addr) {      // remove a pane everywhere; an emptied tab closes if it has siblings
  S.dismissed.add(addr);
  for (const sp of S.spaces) {
    for (const tab of [...sp.tabs]) {
      if (!leaves(tab.root).includes(addr)) continue;
      tab.root = removeLeaf(tab.root, addr);
      if (S.zoomed[tab.id] === addr) S.zoomed[tab.id] = null;
      if (!tab.root && sp.tabs.length > 1) {
        const i = sp.tabs.indexOf(tab); sp.tabs.splice(i, 1);
        if (sp.tab === tab.id) sp.tab = (sp.tabs[i] || sp.tabs[i - 1]).id;
      }
    }
  }
  if (S.focus === addr) S.focus = leaves((curTab() || {}).root)[0] || null;
  commit();
}
async function newTabWith(kind, opt = {}) {
  try {
    const addr = await createTerminal(kind, opt);
    const sp = curSpace(), cur = curTab();
    if (cur && !cur.root) cur.root = leaf(addr);          // an empty tab is filled before a new one is added
    else { const tab = newTab(leaf(addr)); sp.tabs.push(tab); sp.tab = tab.id; }
    S.focus = addr; commit(); focusPane(addr);
  } catch (e) { toast(e.message, true); }
}
async function openBeside(kind, opt = {}) {   // beside the focused pane; fills an empty tab; a new tab only if nothing is focused
  try {
    const addr = await createTerminal(kind, opt), tab = curTab();
    if (tab && !tab.root) tab.root = leaf(addr);
    else if (tab && S.focus && leaves(tab.root).includes(S.focus)) { tab.root = insertBeside(tab.root, S.focus, 'row', addr); S.zoomed[tab.id] = null; }
    else { const sp = curSpace(), t = newTab(leaf(addr)); sp.tabs.push(t); sp.tab = t.id; }
    S.focus = addr; commit(); focusPane(addr);
  } catch (e) { toast(e.message, true); }
}
function movePane(src, target, zone) {   // drop on an edge to place beside, on the middle to swap
  const tab = curTab(); if (!tab || src === target) return;
  if (zone === 'center') tab.root = swapLeaves(tab.root, src, target);
  else {
    const root = removeLeaf(tab.root, src);
    tab.root = insertBeside(root, target, zone === 'left' || zone === 'right' ? 'row' : 'col', src, zone === 'left' || zone === 'top');
  }
  S.zoomed[tab.id] = null; S.focus = src; commit(); focusPane(src);
}
async function splitPane(addr, dir, kind = 'shell') {
  addr = addr || S.focus;
  const loc = addr && locate(addr);
  if (!loc) return newTabWith(kind, { cwd: cwdOf(S.focus) });
  try {
    const na = await createTerminal(kind, { cwd: cwdOf(addr), machine: machineOf(addr) });
    loc.tab.root = insertBeside(loc.tab.root, addr, dir === 'right' ? 'row' : 'col', na);
    S.zoomed[loc.tab.id] = null; S.focus = na; commit(); focusPane(na);
  } catch (e) { toast(e.message, true); }
}
async function closePane(addr) {
  addr = addr || S.focus; if (!addr) return;
  if (agentLive(addr) && !confirm('End this agent? The program running in it will stop.')) return;
  dropFromTree(addr); await endTerminal(addr);
}
const hidePane = addr => { addr = addr || S.focus; if (addr) dropFromTree(addr); };
function toggleZoom(addr) {
  const tab = curTab(); addr = addr || S.focus; if (!tab || !addr) return;
  S.zoomed[tab.id] = S.zoomed[tab.id] === addr ? null : addr; S.focus = addr; render(); focusPane(addr);
}
function neighbor(addr, dir) {
  const me = P.get(addr); if (!me) return null;
  const r = me.el.getBoundingClientRect(); let best = null;
  for (const [a, p] of P) {
    if (a === addr || !p.el.isConnected) continue;
    const q = p.el.getBoundingClientRect(); if (!q.width) continue;
    const ov = dir === 'left' || dir === 'right' ? Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) : Math.min(r.right, q.right) - Math.max(r.left, q.left);
    const dist = dir === 'left' ? r.left - q.right : dir === 'right' ? q.left - r.right : dir === 'up' ? r.top - q.bottom : q.top - r.bottom;
    if (ov <= 0 || dist < -4) continue;
    const score = dist * 1000 - ov;
    if (!best || score < best.score) best = { a, score };
  }
  return best && best.a;
}
function goDir(dir) { const n = neighbor(S.focus, dir); if (n) focusPane(n); }
function swapDir(dir) {
  const n = neighbor(S.focus, dir), tab = curTab(); if (!n || !tab) return;
  tab.root = swapLeaves(tab.root, S.focus, n); commit(); focusPane(S.focus);
}
async function renameTab(id) {
  const sp = curSpace(), tab = sp.tabs.find(t => t.id === (id || sp.tab)); if (!tab) return;
  const v = await ask('RENAME TAB', tab.name || tabName(tab, sp.tabs.indexOf(tab)), 'empty restores the automatic name');
  if (v !== null) { tab.name = v ? v.toUpperCase() : null; commit(); }
}
const SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function replaceAddress(oldAddr, newAddr) {   // the same pane, now backed by a new terminal
  const re = a => a === oldAddr ? newAddr : a;
  const walk = n => !n ? n : isLeaf(n) ? { ...n, a: re(n.a) } : { ...n, c: n.c.map(walk) };
  for (const sp of S.spaces) for (const t of sp.tabs) t.root = walk(t.root);
  for (const k of Object.keys(S.zoomed)) if (S.zoomed[k]) S.zoomed[k] = re(S.zoomed[k]);
  if (S.focus) S.focus = re(S.focus);
  S.dismissed.add(oldAddr); S.terms.delete(oldAddr);
}
async function renameTerminal(addr) {
  addr = addr || S.focus; const t = addr && S.terms.get(addr); if (!t) return;
  const v = await ask('RENAME THIS PANE AND SESSION', (t.labels && t.labels.title) || t.name || '', 'letters, numbers, - and _ ; empty goes back to the automatic name');
  if (v === null) return;
  try {
    const name = v.toLowerCase(), isClaude = t.agent === 'claude-code' || (t.labels && (t.labels.agent === 'claude' || t.labels.kind === 'claude'));
    if (v && isClaude && !addr.includes('/') && t.name !== name) {
      if (!SESSION_NAME.test(name)) toast('Label only: a session name can use letters, numbers, - and _ (no spaces)', true);
      else if (confirm(`Make "${name}" this session's name too, so other agents can reach it with: hc send ${name}\n\n` +
          `OK: restart this Claude under that name. The same conversation resumes` + (stateOf(t) === 'working' ? ', but the answer it is working on right now is lost' : '') + `.\n` +
          `Cancel: only change the pane label (other agents cannot find it by that name).`)) {
        const r = await post('/api/terminals/session-name', { terminal: addr, name });
        if (r.restarted) { replaceAddress(addr, r.address); commit(); focusPane(r.address); toast(`SESSION NAMED ${name.toUpperCase()}`); return; }
      }
    }
    const r = await post('/api/terminals/title', { terminal: addr, title: v }); S.terms.set(addr, { ...t, labels: r.labels || t.labels }); render();
  } catch (e) { toast(e.message, true); }
}
async function newClaudeNamed(where) {
  const v = await ask('NAME THIS CLAUDE SESSION', '', 'letters, numbers, - and _ ; this is the name for hc send');
  if (v === null) return;
  const name = v.toLowerCase();
  if (name && !SESSION_NAME.test(name)) return toast('A session name can use letters, numbers, - and _ (up to 32, no spaces)', true);
  const opt = { cwd: cwdOf(S.focus), ...(name ? { name } : {}) };
  return where === 'tab' ? newTabWith('claude', opt) : openBeside('claude', opt);
}
async function renameSpace(id) {
  const sp = S.spaces.find(s => s.id === (id || S.active)); if (!sp) return;
  const v = await ask('RENAME SPACE', sp.name || spaceName(sp, S.spaces.indexOf(sp)), 'empty restores the automatic name');
  if (v !== null) { sp.name = v ? v.toUpperCase() : null; commit(); }
}
async function closeTab(id) {
  const sp = curSpace(), tab = sp.tabs.find(t => t.id === (id || sp.tab)); if (!tab) return;
  const addrs = leaves(tab.root);
  if (addrs.length && !confirm(`Close this tab and end its ${addrs.length} terminal${addrs.length > 1 ? 's' : ''}?`)) return;
  if (sp.tabs.length > 1) { const i = sp.tabs.indexOf(tab); sp.tabs.splice(i, 1); if (sp.tab === tab.id) sp.tab = (sp.tabs[i] || sp.tabs[i - 1]).id; }
  else tab.root = null;
  commit(); await Promise.all(addrs.map(endTerminal));
}
async function closeSpace(id) {
  const sp = S.spaces.find(s => s.id === (id || S.active)); if (!sp) return;
  const addrs = spaceAddrs(sp);
  if (!confirm(`Close ${spaceName(sp, S.spaces.indexOf(sp))}${addrs.length ? ` and end its ${addrs.length} terminal${addrs.length > 1 ? 's' : ''}` : ''}?`)) return;
  S.spaces = S.spaces.filter(s => s !== sp);
  if (!S.spaces.length) S.spaces = [newSpace('BRIDGE')];
  if (S.active === sp.id) S.active = S.spaces[0].id;
  commit(); await Promise.all(addrs.map(endTerminal));
}
function selectSpace(id) { if (S.spaces.some(s => s.id === id)) { S.active = id; S.focus = leaves((curTab() || {}).root)[0] || null; commit(); focusPane(S.focus); } }
function selectTab(id) { const sp = curSpace(); if (sp.tabs.some(t => t.id === id)) { sp.tab = id; S.focus = leaves(curTab().root)[0] || null; commit(); focusPane(S.focus); } }
function stepSpace(d) { const i = S.spaces.indexOf(curSpace()); selectSpace(S.spaces[(i + d + S.spaces.length) % S.spaces.length].id); }
function stepTab(d) { const sp = curSpace(), i = sp.tabs.findIndex(t => t.id === sp.tab); selectTab(sp.tabs[(i + d + sp.tabs.length) % sp.tabs.length].id); }
function moveInList(list, from, to) { if (from === to || from < 0 || to < 0) return; const [x] = list.splice(from, 1); list.splice(to, 0, x); }
function agentList() {
  return [...S.terms.values()].filter(isAgent).sort((a, b) => (ORDER[stateOf(a)] - ORDER[stateOf(b)]) || (a.created_ms - b.created_ms));
}
function focusAddr(addr) {
  const loc = locate(addr);
  if (!loc) {   // a terminal no tab shows: open it in a new tab here
    const sp = curSpace(), tab = newTab(leaf(addr)); sp.tabs.push(tab); sp.tab = tab.id; S.focus = addr; commit(); return focusPane(addr);
  }
  S.active = loc.sp.id; loc.sp.tab = loc.tab.id; S.focus = addr; commit(); focusPane(addr);
}
function stepAgent(d) {
  const list = agentList(); if (!list.length) return;
  const i = list.findIndex(t => t.address === S.focus);
  focusAddr(list[(i + d + list.length) % list.length].address);
}
function applyFont() {
  localStorage.setItem('lcars-font-v2', S.font);
  for (const p of P.values()) { p.term.options.fontSize = S.font; p.refit(); }
}

// ── commands, key bindings ────────────────────────────────────────────
const CMDS = new Map();
const KEYS = [];
const def = (id, label, run, group = 'General') => CMDS.set(id, { id, label, run, group });
const bind = (combo, id) => KEYS.push([combo, id]);
const run = (id, arg) => { const c = CMDS.get(id); if (c) return c.run(arg); };

def('app.palette', 'Command palette', () => openPalette(), 'App');
def('app.picker', 'Find a space, tab or agent…', () => openPicker(), 'App');
def('app.help', 'Keyboard shortcuts', () => openHelp(), 'App');
def('agent.menu', 'Start another coding agent…', () => agentsMenu(Math.max(20, innerWidth / 2 - 110), 110), 'Agents');
def('app.install', 'Install LCARS as an app', () => installApp(), 'App');
def('layout.toggle_sidebar', 'Show or hide the sidebar', () => { document.body.classList.toggle('side-hidden'); requestAnimationFrame(() => P.forEach(p => p.refit())); }, 'App');
def('app.zoom_in', 'Bigger terminal text', () => { S.font = Math.min(28, S.font + 1); applyFont(); }, 'App');
def('app.zoom_out', 'Smaller terminal text', () => { S.font = Math.max(9, S.font - 1); applyFont(); }, 'App');
def('app.zoom_reset', 'Reset terminal text size', () => { S.font = 15; applyFont(); }, 'App');
def('sound.toggle', 'Turn sound on or off', () => toggleSound(), 'App');
async function newSpaceOn(machine) {
  if (machine) { const mv = machineView(machine); if (!mv || mv.state !== 'connected') return toast(`${machineLabel(machine)} is not connected`, true); }
  const n = await ask('NEW SPACE', '', 'name (optional)'); if (n === null) return;
  const sp = newSpace(n ? n.toUpperCase() : null, machine); S.spaces.push(sp); S.active = sp.id; S.focus = null; collapsedMachines.delete(machine); commit();
}
def('space.new', 'New space', () => newSpaceOn(spaceMachine(curSpace())), 'Spaces');
def('space.rename', 'Rename space', id => renameSpace(typeof id === 'string' ? id : undefined), 'Spaces');
def('space.close', 'Close space', id => closeSpace(typeof id === 'string' ? id : undefined), 'Spaces');
def('space.next', 'Next space', () => stepSpace(1), 'Spaces');
def('space.prev', 'Previous space', () => stepSpace(-1), 'Spaces');
def('pane.new_claude', 'New Claude beside this pane', () => openBeside('claude', { cwd: cwdOf(S.focus) }), 'Panes');
def('pane.new_claude_named', 'New Claude with a session name…', () => newClaudeNamed('pane'), 'Panes');
def('tab.new_claude_named', 'New tab (Claude, named)…', () => newClaudeNamed('tab'), 'Tabs');
def('pane.new_shell', 'New shell beside this pane', () => openBeside('shell', { cwd: cwdOf(S.focus) }), 'Panes');
def('app.auto_open', 'Open helper terminals automatically: turn on or off', () => {
  S.autoOpen = !S.autoOpen; localStorage.setItem('lcars-autoopen', S.autoOpen ? 'on' : 'off');
  toast(`HELPER TERMINALS WILL ${S.autoOpen ? 'OPEN' : 'NOT OPEN'} AUTOMATICALLY`); if (S.autoOpen) refreshTerms().catch(() => {});
}, 'App');
def('tab.new', 'New tab (shell)', () => newTabWith('shell', { cwd: cwdOf(S.focus) }), 'Tabs');
def('tab.new_claude', 'New tab (Claude)', () => newTabWith('claude', { cwd: cwdOf(S.focus) }), 'Tabs');
def('tab.rename', 'Rename tab', id => renameTab(typeof id === 'string' ? id : undefined), 'Tabs');
def('tab.close', 'Close tab', id => closeTab(typeof id === 'string' ? id : undefined), 'Tabs');
def('tab.next', 'Next tab', () => stepTab(1), 'Tabs');
def('tab.prev', 'Previous tab', () => stepTab(-1), 'Tabs');
def('pane.split_right', 'Split right', a => splitPane(typeof a === 'string' ? a : undefined, 'right'), 'Panes');
def('pane.split_down', 'Split down', a => splitPane(typeof a === 'string' ? a : undefined, 'down'), 'Panes');
def('pane.split_right_claude', 'Split right with Claude', a => splitPane(typeof a === 'string' ? a : undefined, 'right', 'claude'), 'Panes');
def('pane.split_down_claude', 'Split down with Claude', a => splitPane(typeof a === 'string' ? a : undefined, 'down', 'claude'), 'Panes');
def('pane.rename', 'Rename pane', a => renameTerminal(typeof a === 'string' ? a : undefined), 'Panes');
def('pane.zoom', 'Zoom pane or show all panes', a => toggleZoom(typeof a === 'string' ? a : undefined), 'Panes');
def('pane.close', 'Close pane (ends its terminal)', a => closePane(typeof a === 'string' ? a : undefined), 'Panes');
def('pane.hide', 'Hide pane (keeps running)', a => hidePane(typeof a === 'string' ? a : undefined), 'Panes');
for (const d of ['left', 'right', 'up', 'down']) {
  def(`pane.go_${d}`, `Focus pane ${d}`, () => goDir(d), 'Panes');
  def(`pane.swap_${d}`, `Swap pane ${d}`, () => swapDir(d), 'Panes');
}
def('agent.next', 'Next agent', () => stepAgent(1), 'Agents');
def('agent.prev', 'Previous agent', () => stepAgent(-1), 'Agents');
def('terminal.copy', 'Copy selection', () => copySel(), 'Terminal');
def('terminal.paste', 'Paste', () => pasteClip(), 'Terminal');
for (let n = 1; n <= 9; n++) {
  def(`space.select_${n}`, `Go to space ${n}`, () => { const sp = S.spaces[n - 1]; if (sp) selectSpace(sp.id); }, 'Spaces');
  def(`tab.select_${n}`, `Go to tab ${n}`, () => { const t = curSpace().tabs[n - 1]; if (t) selectTab(t.id); }, 'Tabs');
  bind(`alt+${n}`, `space.select_${n}`); bind(`ctrl+${n}`, `tab.select_${n}`); bind(`ctrl+alt+${n}`, `tab.select_${n}`);
}
// Herdr's default keys, plus ctrl+alt twins where a browser keeps the original (new/close tab, new space).
[['alt+h', 'pane.go_left'], ['alt+j', 'pane.go_down'], ['alt+k', 'pane.go_up'], ['alt+l', 'pane.go_right'], ['alt+left', 'pane.go_left'], ['alt+right', 'pane.go_right'],
 ['alt+shift+h', 'pane.swap_left'], ['alt+shift+j', 'pane.swap_down'], ['alt+shift+k', 'pane.swap_up'], ['alt+shift+l', 'pane.swap_right'],
 ['ctrl+equal', 'app.zoom_in'], ['ctrl+plus', 'app.zoom_in'], ['ctrl+shift+plus', 'app.zoom_in'], ['ctrl+minus', 'app.zoom_out'], ['ctrl+0', 'app.zoom_reset'],
 ['ctrl+pagedown', 'tab.next'], ['ctrl+tab', 'tab.next'], ['alt+rbracket', 'tab.next'], ['ctrl+pageup', 'tab.prev'], ['ctrl+shift+tab', 'tab.prev'], ['alt+lbracket', 'tab.prev'],
 ['ctrl+shift+pagedown', 'space.next'], ['ctrl+shift+pageup', 'space.prev'], ['alt+down', 'agent.next'], ['alt+up', 'agent.prev'],
 ['ctrl+shift+question', 'app.help'], ['ctrl+question', 'app.help'], ['f1', 'app.help'],
 ['ctrl+shift+b', 'layout.toggle_sidebar'], ['ctrl+shift+n', 'space.new'], ['ctrl+alt+n', 'space.new'],
 ['ctrl+shift+t', 'tab.new'], ['ctrl+alt+t', 'tab.new'], ['ctrl+shift+w', 'tab.close'], ['ctrl+alt+w', 'tab.close'],
 ['ctrl+shift+p', 'app.palette'], ['ctrl+shift+k', 'app.picker'], ['ctrl+alt+k', 'app.picker'], ['ctrl+alt+p', 'app.palette'], ['ctrl+shift+o', 'pane.split_right'], ['ctrl+shift+e', 'pane.split_down'],
 ['ctrl+shift+x', 'pane.close'], ['ctrl+shift+z', 'pane.zoom'], ['f2', 'tab.rename'], ['ctrl+alt+r', 'pane.rename'], ['shift+f2', 'space.rename'], ['ctrl+shift+c', 'terminal.copy'],
].forEach(([k, c]) => bind(k, c));
const KEYNAME = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pageup', PageDown: 'pagedown', Tab: 'tab', Escape: 'esc', Enter: 'enter', ' ': 'space',
  '-': 'minus', '+': 'plus', '=': 'equal', '[': 'lbracket', ']': 'rbracket', '/': 'slash', '?': 'question', ',': 'comma', F1: 'f1', F2: 'f2' };
function comboOf(e) {
  let k = e.code && /^(Key|Digit)[A-Z0-9]$/.test(e.code) ? e.code.slice(-1).toLowerCase() : e.key;
  k = KEYNAME[k] || k.toLowerCase();
  if (['control', 'alt', 'shift', 'meta'].includes(k)) return '';
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', k].filter(Boolean).join('+');
}
const SHOW = { equal: '=', plus: '+', minus: '−', lbracket: '[', rbracket: ']', question: '?', slash: '/', pagedown: 'PgDn', pageup: 'PgUp', left: '←', right: '→', up: '↑', down: '↓' };
const fmtKey = c => c.split('+').map(p => SHOW[p] || (p.length > 1 ? p[0].toUpperCase() + p.slice(1) : p.toUpperCase())).join('+');
const hintOf = id => { const k = KEYS.find(([, c]) => c === id); return k ? fmtKey(k[0]) : ''; };
const modalOpen = () => !!document.querySelector('dialog[open], .ctx');
document.addEventListener('keydown', e => {
  if (e.isComposing || modalOpen()) return;
  const id = (KEYS.find(([k]) => k === comboOf(e)) || [])[1];
  if (!id) return;
  e.preventDefault(); e.stopPropagation();
  run(id);
}, true);

// ── dialogs, context menu, palette, help ──────────────────────────────
function ask(title, value = '', placeholder = '') {
  return new Promise(resolve => {
    const d = $('#ask-dlg'), i = $('#ask-input');
    $('#ask-title').textContent = title; i.value = value; i.placeholder = placeholder; d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? i.value.trim() : null);
    d.showModal(); i.select();
  });
}
let ctxEl = null, ctxSel = -1;
function closeMenu() { const sb = document.getElementById('agents-sort'); if (sb) sb.classList.remove('on'); if (ctxEl) { ctxEl.remove(); ctxEl = null; ctxSel = -1; document.removeEventListener('keydown', menuKeys, true); } }
function menuKeys(e) {
  const items = [...ctxEl.querySelectorAll('.it:not(.off)')];
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    ctxSel = (ctxSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((x, i) => x.classList.toggle('sel', i === ctxSel));
  } else if (e.key === 'Enter' && ctxSel >= 0) { e.preventDefault(); e.stopPropagation(); items[ctxSel].click(); }
  else if (/^[1-9]$/.test(e.key)) { const row = ctxEl.querySelector(`.it[data-key="${e.key}"]`); if (row) { e.preventDefault(); e.stopPropagation(); row.click(); } }
}
function showMenu(x, y, items) {
  closeMenu();
  const m = (ctxEl = document.createElement('div')); m.className = 'ctx';
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    if (it.show === false) continue;
    if (it.head) { const h = document.createElement('div'); h.className = 'hd'; h.textContent = it.head; m.appendChild(h); continue; }
    const row = document.createElement('div'); row.className = 'it' + (it.off ? ' off' : '') + (it.dim ? ' dim' : '') + (it.check ? ' chk' : '');
    if (it.key) row.dataset.key = it.key;
    const hint = it.key || (it.cmd ? hintOf(it.cmd) : '');
    row.innerHTML = (it.icon ? '<span class="lb"><i class="ic"></i><span></span></span>' : '<span></span>') + (hint ? '<kbd></kbd>' : '');
    if (it.icon) $('.ic', row).innerHTML = it.icon;
    $(it.icon ? '.lb span' : 'span', row).textContent = it.label; if (hint) $('kbd', row).textContent = hint;
    row.onclick = () => { closeMenu(); if (it.fn) it.fn(); else run(it.cmd, it.arg); };
    m.appendChild(row);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  document.addEventListener('keydown', menuKeys, true);
}
document.addEventListener('mousedown', e => { if (ctxEl && !ctxEl.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

function paneMenu(e, addr) {
  if (e.shiftKey) return;                       // shift+right-click keeps the browser's own menu
  e.preventDefault(); setFocusQuiet(addr);
  const p = P.get(addr), sel = p && p.term.hasSelection();
  showMenu(e.clientX, e.clientY, [
    { label: 'Copy', cmd: 'terminal.copy', off: !sel }, { label: 'Paste', cmd: 'terminal.paste' }, '-',
    { label: 'Split right', cmd: 'pane.split_right', arg: addr }, { label: 'Split down', cmd: 'pane.split_down', arg: addr },
    { label: 'Split right with Claude', cmd: 'pane.split_right_claude', arg: addr }, { label: 'Split down with Claude', cmd: 'pane.split_down_claude', arg: addr },
    { label: S.zoomed[(curTab() || {}).id] === addr ? 'Show all panes' : 'Zoom', cmd: 'pane.zoom', arg: addr },
    { label: 'Rename', cmd: 'pane.rename', arg: addr }, '-',
    { label: 'Hide pane (keeps running)', cmd: 'pane.hide', arg: addr }, { label: 'Close pane', cmd: 'pane.close', arg: addr },
  ]);
}
function tabMenu(e, id) {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: 'Rename', cmd: 'tab.rename', arg: id }, { label: 'New tab', cmd: 'tab.new' }, { label: 'New Claude tab', cmd: 'tab.new_claude' }, { label: 'New Claude tab (named)…', cmd: 'tab.new_claude_named' }, '-',
    { label: 'Close', cmd: 'tab.close', arg: id },
  ]);
}
function spaceMenu(e, id) {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: 'Rename', cmd: 'space.rename', arg: id }, { label: 'New space', cmd: 'space.new' }, '-', { label: 'Close', cmd: 'space.close', arg: id },
  ]);
}
const setFocusQuiet = addr => { S.focus = addr; for (const [a, q] of P) q.el.classList.toggle('focus', a === addr); if (markViewed()) render(); };
window.addEventListener('focus', () => { if (markViewed()) render(); });
document.addEventListener('visibilitychange', () => { if (markViewed()) render(); });
async function copySel() {
  const p = P.get(S.focus); const t = p && p.term.getSelection();
  if (!t) return toast('Nothing selected');
  try { await navigator.clipboard.writeText(t); toast('COPIED'); } catch { toast('Copy needs a secure page (https)', true); }
}
async function pasteClip() {
  const p = P.get(S.focus); if (!p) return;
  try {
    for (const item of await navigator.clipboard.read()) {        // an image on the clipboard is sent as a file
      const type = item.types.find(t => t.startsWith('image/'));
      if (type) { const blob = await item.getType(type); return p.sendFiles([new File([blob], `clipboard.${type.split('/')[1] || 'png'}`, { type })]); }
    }
    const t = await navigator.clipboard.readText(); if (t) p.term.paste(t); p.term.focus();
  } catch { toast('Allow clipboard access, or press Ctrl+V', true); }
}
async function loadAgents() {
  try { const d = await api('/api/agents'); S.agents = d.agents; S.agentEnv = d.env_file; } catch {}
}
const startAgent = a => spaceMachine(curSpace()) && a.id !== 'claude' ? toast('Other agents start on this server only for now', true) : a.id === 'claude' ? openBeside('claude', { cwd: cwdOf(S.focus) }) : openBeside('agent', { agent: a.id, cwd: cwdOf(S.focus) });
async function agentsMenu(x, y) {
  await loadAgents();
  const ok = S.agents.filter(a => a.installed), no = S.agents.filter(a => !a.installed), items = [];
  ok.forEach((a, i) => items.push({ label: a.name, key: i < 9 ? String(i + 1) : undefined, fn: () => startAgent(a) }));
  if (no.length) { items.push('-'); no.forEach(a => items.push({ label: `${a.name} · not installed`, dim: true, fn: () => showAgentInfo(a) })); }
  items.push({ label: 'Claude, with a session name…', fn: () => newClaudeNamed('pane') });
  items.push('-', { label: 'Setup and sign-in help…', fn: () => showMenu(x, y, S.agents.map(a => ({ label: a.name + (a.installed ? '' : ' · not installed'), dim: !a.installed, fn: () => showAgentInfo(a) }))) });
  showMenu(x, y, items);
}
function showAgentInfo(a) {
  $('#info-title').textContent = `${a.name} · ${a.installed ? 'INSTALLED' : 'NOT INSTALLED'}`;
  const body = $('#info-body'); body.textContent = '';
  const head = t => { const h = document.createElement('h4'); h.textContent = t; body.appendChild(h); };
  const para = t => { const p = document.createElement('p'); p.className = 'ip'; p.textContent = t; body.appendChild(p); };
  const code = c => {
    const r = document.createElement('div'), k = document.createElement('code'), b = document.createElement('button');
    r.className = 'icode'; k.textContent = c; b.textContent = 'COPY'; b.className = 'pill gold';
    b.onclick = async () => { try { await navigator.clipboard.writeText(c); toast('COPIED'); } catch { toast('Select the text and copy it', true); } };
    r.append(k, b); body.appendChild(r);
  };
  if (a.install.length) { head('INSTALL'); para('Run in a shell on this server (the OPEN A SHELL button below). It uses the same account as your other terminals.'); a.install.forEach(code); }
  if (a.login.length) { head('SIGN IN'); a.login.forEach(l => l.startsWith('$ ') ? code(l.slice(2)) : para(l)); }
  if (/_KEY|API/.test(a.login.join(' '))) para(`Keys go in ${S.agentEnv || '/root/.config/lcars-claude/agents.env'}, one KEY=value per line. Create the file yourself and make it readable only by root (chmod 600). Agents started from this menu get those values.`);
  if (a.account) { head('ACCOUNT'); para(a.account); }
  if (a.note) { head('NOTE'); para(a.note); }
  para('Steps are from the vendor documentation read on 2026-11-10. If one fails, check the vendor page.');
  const d = $('#info-dlg'); d.showModal(); d.scrollTop = 0;
}
let pickSel = 0, pickItems = [];
function pickerData() {
  const items = [];
  S.spaces.forEach((sp, i) => items.push({ kind: 'SPACE', label: spaceName(sp, i), sub: `${sp.tabs.length} TAB${sp.tabs.length === 1 ? '' : 'S'}`, run: () => selectSpace(sp.id) }));
  S.spaces.forEach(sp => sp.tabs.forEach((tab, i) => items.push({ kind: 'TAB', label: tabName(tab, i), sub: spaceName(sp, S.spaces.indexOf(sp)),
    run: () => { S.active = sp.id; sp.tab = tab.id; S.focus = leaves(tab.root)[0] || null; commit(); focusPane(S.focus); } })));
  for (const t of agentList()) items.push({ kind: 'AGENT', label: labelOf(t), sub: `${folderOf(t)} · ${STATUS_WORD[stateOf(t)]}`, run: () => focusAddr(t.address) });
  for (const t of S.terms.values()) if (!isAgent(t)) items.push({ kind: 'TERMINAL', label: labelOf(t), sub: `${folderOf(t)} · ${t.address}`, run: () => focusAddr(t.address) });
  return items;
}
function openPicker() { const d = $('#pick-dlg'), i = $('#pick-input'); i.value = ''; fillPicker(''); d.showModal(); i.focus(); }
function fillPicker(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean), list = $('#pick-list'); list.textContent = '';
  pickItems = pickerData().filter(it => { const hay = `${it.kind} ${it.label} ${it.sub}`.toLowerCase(); return words.every(w => hay.includes(w)); });
  pickSel = 0;
  pickItems.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'pal-item' + (i === 0 ? ' sel' : '');
    row.innerHTML = '<span><span class="kind"></span><span class="lb"></span></span><kbd></kbd>';
    $('.kind', row).textContent = it.kind; $('.lb', row).textContent = it.label; $('kbd', row).textContent = it.sub;
    row.onclick = () => runPicker(i); list.appendChild(row);
  });
  if (!pickItems.length) list.innerHTML = '<div class="pal-item"><span>NOTHING MATCHES</span></div>';
}
function runPicker(i) { const it = pickItems[i]; if (!it) return; $('#pick-dlg').close(); setTimeout(it.run, 30); }
function movePick(d) {
  const rows = [...$('#pick-list').children]; if (!rows.length || !pickItems.length) return;
  rows[pickSel].classList.remove('sel'); pickSel = (pickSel + d + rows.length) % rows.length;
  rows[pickSel].classList.add('sel'); rows[pickSel].scrollIntoView({ block: 'nearest' });
}
let palSel = 0, palItems = [];
function openPalette() {
  const d = $('#pal-dlg'), input = $('#pal-input'); input.value = ''; fillPalette(''); d.showModal(); input.focus();
}
function fillPalette(q) {
  q = q.toLowerCase().trim(); const list = $('#pal-list'); list.textContent = '';
  palItems = [...CMDS.values()].filter(c => q
    ? (c.label.toLowerCase().includes(q) || c.id.includes(q) || c.group.toLowerCase().includes(q))
    : !/\.select_\d$/.test(c.id));
  palSel = 0;
  palItems.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'pal-item' + (i === 0 ? ' sel' : '');
    row.innerHTML = '<span></span><kbd></kbd>'; $('span', row).textContent = `${c.group}: ${c.label}`; $('kbd', row).textContent = hintOf(c.id);
    row.onclick = () => runPalette(i); list.appendChild(row);
  });
}
function runPalette(i) { const c = palItems[i]; if (!c) return; $('#pal-dlg').close(); setTimeout(() => run(c.id), 30); }
function movePal(d) {
  const rows = [...$('#pal-list').children]; if (!rows.length) return;
  rows[palSel].classList.remove('sel'); palSel = (palSel + d + rows.length) % rows.length;
  rows[palSel].classList.add('sel'); rows[palSel].scrollIntoView({ block: 'nearest' });
}
function openHelp() {
  const body = $('#help-body'); body.textContent = '';
  const ORDER_G = ['App', 'Spaces', 'Tabs', 'Panes', 'Agents', 'Terminal'];
  const groups = new Map(ORDER_G.map(g => [g, []]));
  const merged = /(space|tab)\.select_\d$|^pane\.(go|swap)_/;       // shown below as ranges
  for (const c of CMDS.values()) {
    if (merged.test(c.id)) continue;
    const keys = KEYS.filter(([, id]) => id === c.id).map(([k]) => fmtKey(k));
    if (keys.length) (groups.get(c.group) || groups.set(c.group, []).get(c.group)).push([c.label, keys.slice(0, 3).join('   or   ')]);
  }
  groups.get('Spaces').push(['Go to space 1–9', 'Alt+1 … 9']);
  groups.get('Tabs').push(['Go to tab 1–9', 'Ctrl+1 … 9   or   Ctrl+Alt+1 … 9']);
  groups.get('Panes').push(['Focus pane left / down / up / right', 'Alt+H  J  K  L   or   Alt+← →']);
  groups.get('Panes').push(['Swap pane left / down / up / right', 'Alt+Shift+H  J  K  L']);
  for (const [g, rows] of groups) {
    if (!rows.length) continue;
    const h = document.createElement('h4'); h.textContent = g.toUpperCase(); body.appendChild(h);
    let n = 0;
    for (const [label, keys] of rows) {
      const r = document.createElement('div'), a = document.createElement('span'), b = document.createElement('kbd');
      r.className = 'hrow' + (n++ % 2 ? ' alt' : ''); a.textContent = label; b.textContent = keys; r.append(a, b); body.appendChild(r);
    }
  }
  const note = document.createElement('p'); note.className = 'hnote';
  note.textContent = 'Some browsers keep Ctrl+T, Ctrl+W, Ctrl+N and Ctrl+1–9 for themselves. The Ctrl+Alt versions work everywhere, and the originals work when the page is installed as an app. Right-click a pane for its menu; Shift+right-click for the browser menu.';
  body.appendChild(note);
  const d = $('#help-dlg'); d.showModal(); d.scrollTop = 0;   // opening focuses Close at the bottom; start at the top
}

function beginPaneDrag(addr, e0) {
  if (e0.button !== 0 || P.size < 2) return;
  const x0 = e0.clientX, y0 = e0.clientY, hint = document.createElement('div');
  let active = false, target = null, zone = null;
  hint.className = 'dropzone';
  const move = e => {
    if (!active) { if (Math.hypot(e.clientX - x0, e.clientY - y0) < 8) return; active = true; document.body.classList.add('dragging'); document.body.appendChild(hint); }
    const el = document.elementFromPoint(e.clientX, e.clientY), pe = el && el.closest && el.closest('.pane');
    if (!pe || pe.dataset.addr === addr) { hint.style.display = 'none'; target = null; return; }
    const r = pe.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    zone = fx < 0.28 ? 'left' : fx > 0.72 ? 'right' : fy < 0.28 ? 'top' : fy > 0.72 ? 'bottom' : 'center'; target = pe.dataset.addr;
    const w = zone === 'left' || zone === 'right' ? r.width / 2 : r.width, h = zone === 'top' || zone === 'bottom' ? r.height / 2 : r.height;
    hint.style.cssText = `display:block;left:${r.left + (zone === 'right' ? r.width / 2 : 0)}px;top:${r.top + (zone === 'bottom' ? r.height / 2 : 0)}px;width:${w}px;height:${h}px`;
    hint.dataset.zone = zone;
  };
  const end = drop => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key, true);
    document.body.classList.remove('dragging'); hint.remove();
    if (drop && active && target) movePane(addr, target, zone);
  };
  const up = () => end(true);
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); end(false); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('keydown', key, true);
}

// ── panes: one xterm.js attached to one core terminal ─────────────────
const XTERM_THEME = {
  background: '#000000', foreground: '#ffe6cc', cursor: '#ff9900', cursorAccent: '#000000', selectionBackground: '#7a4a10aa',
  black: '#000000', red: '#ff5544', green: '#7fd17f', yellow: '#ffcc66', blue: '#5599ff', magenta: '#cc99cc', cyan: '#99ccff', white: '#ffcc99',
  brightBlack: '#666688', brightRed: '#ff7766', brightGreen: '#9be89b', brightYellow: '#ffe08a', brightBlue: '#99bbff', brightMagenta: '#e0b0e0', brightCyan: '#bde0ff', brightWhite: '#ffffff',
};
const XTERM_PICARD = {
  background: '#02050a', foreground: '#d6e4ee', cursor: '#5ad2f4', cursorAccent: '#02050a', selectionBackground: '#1d5a74aa',
  black: '#02050a', red: '#ff5d5d', green: '#7fe0a8', yellow: '#f2c14a', blue: '#5a8cff', magenta: '#b88cff', cyan: '#5ad2f4', white: '#d6e4ee',
  brightBlack: '#5b6f82', brightRed: '#ff8080', brightGreen: '#a0f0c0', brightYellow: '#ffd978', brightBlue: '#88aaff', brightMagenta: '#cfaaff', brightCyan: '#8fe4fa', brightWhite: '#ffffff',
};
const XTERM_TITAN = {
  background: '#000000', foreground: '#cfd8e6', cursor: '#5fc3e8', cursorAccent: '#000000', selectionBackground: '#446075bb',
  black: '#000000', red: '#ff6f5e', green: '#7fd6a8', yellow: '#e3b072', blue: '#6fa3ff', magenta: '#b79ad0', cyan: '#5fc3e8', white: '#cfd8e6',
  brightBlack: '#647791', brightRed: '#ff9084', brightGreen: '#a3ecc4', brightYellow: '#f2c791', brightBlue: '#9bc0ff', brightMagenta: '#d0b8e6', brightCyan: '#97c8e2', brightWhite: '#ffffff',
};
const xtermTheme = () => ({ picard: XTERM_PICARD, titan: XTERM_TITAN })[document.documentElement.dataset.theme] || XTERM_THEME;
window.addEventListener('lcars-theme', () => { for (const p of P.values()) { try { p.term.options.theme = xtermTheme(); } catch {} } });
const hasFiles = ev => ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files');

class Pane {
  constructor(addr) {
    this.addr = addr; this.ws = null; this.dead = false; this.ended = false; this.retry = 0;
    this.el = document.createElement('div');
    this.el.className = 'pane'; this.el.dataset.addr = addr;
    this.el.innerHTML = `<div class="pane-h"><span class="cap"></span><span class="title"></span><span class="sn" title="Session name: other agents reach this one with hc send"></span>${TRICORDER}<span class="st"></span>
      <button data-a="split_right" title="Split right">SPLIT R</button><button data-a="split_down" title="Split down">SPLIT D</button>
      <button data-a="zoom" title="Zoom">ZOOM</button><button data-a="file" title="Send a file">FILE</button>
      <button data-a="close" class="close" title="Close pane (ends its terminal)">CLOSE</button></div>
      <div class="pane-b"><span class="pane-msg">RECONNECTING</span></div>`;
    this.body = $('.pane-b', this.el);
    this.term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'), fontSize: S.font, lineHeight: 1.0,
      cursorBlink: true, scrollback: 5000, theme: xtermTheme(), allowProposedApi: true, macOptionIsMeta: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    try { this.term.loadAddon(new Unicode11Addon.Unicode11Addon()); this.term.unicode.activeVersion = '11'; } catch {}
    this.term.open(this.body);
    // GPU drawing: crisper text, and box characters join up (the default row-by-row drawing leaves gaps in lines).
    // If the browser cannot do it, the ordinary renderer stays in use.
    try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); this.term.loadAddon(gl); this.gpu = true; } catch { this.gpu = false; }
    // Ctrl+V / Cmd+V must stay a browser paste. If xterm turns it into a Ctrl+V key for the program, the program looks for
    // an image on the SERVER's clipboard ("no image in the clipboard") and the browser never gets to paste your screenshot.
    this.term.attachCustomKeyEventHandler(ev => !(ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'v'));
    this.term.onData(d => this.send({ type: 'input', data: d }));
    this.term.onBinary(b => { if (this.ws && this.ws.readyState === 1) this.ws.send(Uint8Array.from(b, c => c.charCodeAt(0))); });
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.body);
    this.el.addEventListener('mousedown', () => setFocusQuiet(addr), true);
    this.el.addEventListener('focusin', () => setFocusQuiet(addr));
    this.el.addEventListener('contextmenu', ev => paneMenu(ev, addr));
    $('.title', this.el).addEventListener('dblclick', () => renameTerminal(addr));
    $('.pane-h', this.el).addEventListener('pointerdown', ev => { if (ev.target.closest('.cap, .title')) beginPaneDrag(addr, ev); });
    this.el.addEventListener('click', ev => {
      const a = ev.target.dataset && ev.target.dataset.a; if (!a) return;
      if (a === 'file') { setFocusQuiet(addr); $('#file-input').click(); }
      else run(a === 'close' ? 'pane.close' : a === 'zoom' ? 'pane.zoom' : `pane.${a}`, addr);
    });
    this.touchScroll();
    this.body.addEventListener('paste', ev => this.onPaste(ev), true);
    ['dragenter', 'dragover'].forEach(n => this.el.addEventListener(n, ev => { if (hasFiles(ev)) { ev.preventDefault(); this.el.classList.add('drop'); } }));
    ['dragleave', 'drop'].forEach(n => this.el.addEventListener(n, () => this.el.classList.remove('drop')));
    this.el.addEventListener('drop', ev => { if (hasFiles(ev)) { ev.preventDefault(); this.sendFiles([...ev.dataTransfer.files]); } });
    this.connect();
  }
  // The terminal library does not scroll its history for a finger swipe, so a phone could never look back. Drag = scroll,
  // with a little coast after letting go. A plain tap (no real movement) is left alone so it still opens the keyboard.
  touchScroll() {
    let y0 = null, last = 0, lastT = 0, v = 0, moved = false, rest = 0, raf = 0;
    const lineH = () => Math.max(8, this.body.querySelector('.xterm-screen').getBoundingClientRect().height / this.term.rows);
    const scroll = dy => { rest += dy / lineH(); const n = Math.trunc(rest); if (n) { rest -= n; this.term.scrollLines(-n); } };
    this.body.addEventListener('touchstart', ev => {
      cancelAnimationFrame(raf);
      if (ev.touches.length !== 1) { y0 = null; return; }
      y0 = last = ev.touches[0].clientY; lastT = ev.timeStamp; v = 0; moved = false; rest = 0;
    }, { passive: true });
    this.body.addEventListener('touchmove', ev => {
      if (y0 === null || ev.touches.length !== 1) return;
      const y = ev.touches[0].clientY;
      if (!moved && Math.abs(y - y0) < 8) return;
      moved = true; ev.preventDefault();
      const dt = Math.max(1, ev.timeStamp - lastT); v = 0.8 * v + 0.2 * ((y - last) / dt * 16);   // px per frame
      scroll(y - last); last = y; lastT = ev.timeStamp;
    }, { passive: false });
    const end = ev => {
      if (y0 === null) return;
      y0 = null;
      if (moved) ev.preventDefault();   // a swipe is not a tap: do not focus the terminal or pop up the keyboard
      if (!moved || Math.abs(v) < 2) return;
      const coast = () => { v *= 0.95; if (Math.abs(v) < 0.5) return; scroll(v); raf = requestAnimationFrame(coast); };
      raf = requestAnimationFrame(coast);
    };
    this.body.addEventListener('touchend', end, { passive: false });
    this.body.addEventListener('touchcancel', () => { y0 = null; }, { passive: true });
  }
  refit() { try { if (this.el.isConnected && this.el.offsetParent) this.fit.fit(); } catch {} }
  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  connect() {
    if (this.dead) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.refit();
    const url = `${proto}://${location.host}/ws/term?terminal=${encodeURIComponent(this.addr)}&cols=${this.term.cols}&rows=${this.term.rows}`;
    const ws = (this.ws = new WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.retry = 0; this.el.classList.remove('down');
      this.refit();   // the first fit can happen before the link is up; tell the program the real size now
      this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
    };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'closed') {
          this.ended = true; const r = m.reason || {};
          this.term.write('\r\n\x1b[38;5;208m[ terminal ended ]\x1b[0m\r\n');
          // A clean exit or an end-it-yourself closes the pane; a crash stays so its last output can be read.
          if (r.reason === 'killed' || (r.reason === 'exited' && !r.exit_code)) setTimeout(() => dropFromTree(this.addr), 600);
        } else if (m.type === 'error') { this.term.write(`\r\n\x1b[31m[ ${m.error} ]\x1b[0m\r\n`); this.ended = true; }
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
        this.term.paste(path + ' ');   // bracketed paste, so Claude sees an attached file
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
    $('.title', this.el).textContent = t ? `${labelOf(t)} · ${folderOf(t)}` : this.addr;
    const sn = $('.sn', this.el); sn.textContent = t && t.name ? '@' + t.name : ''; sn.hidden = !(t && t.name);
    $('.st', this.el).textContent = STATUS_WORD[st];
    const tab = curTab(); $('[data-a=zoom]', this.el).title = tab && S.zoomed[tab.id] === this.addr ? 'Show all panes' : 'Zoom';
  }
  destroy() {
    this.dead = true; this.ro.disconnect();
    try { this.ws && this.ws.close(); } catch {}
    this.term.dispose(); this.el.remove();
  }
}

// ── rendering ─────────────────────────────────────────────────────────
function render() { markViewed(); renderTabs(); renderSpaces(); renderAgents(); renderUnplaced(); renderPanes(); renderFoot(); if (typeof panelSync === 'function') panelSync(); }

function stateMark(state) { return `<span class="mk" data-state="${state}" style="--c:${STATUS_COLOR[state]}">${BARS}</span>`; }
function renderTabs() {
  const sp = curSpace(), box = $('#tabs'); box.textContent = '';
  sp.tabs.forEach((tab, i) => {
    const st = topState(leaves(tab.root));
    const b = document.createElement('div');
    b.className = 'tab' + (tab.id === sp.tab ? ' on' : ''); b.dataset.state = st; b.draggable = true;
    b.innerHTML = '<span class="num"></span><span class="nm"></span>' + (['working', 'blocked', 'done'].includes(st) ? stateMark(st) : '') + '<button class="x" title="Close tab">×</button>';
    $('.num', b).textContent = pad2(i + 1);
    $('.nm', b).textContent = tabName(tab, i) + (S.zoomed[tab.id] ? ' Z' : '');
    b.onclick = ev => { if (ev.target.classList.contains('x')) closeTab(tab.id); else selectTab(tab.id); };
    b.ondblclick = ev => { if (!ev.target.classList.contains('x')) renameTab(tab.id); };
    b.oncontextmenu = ev => tabMenu(ev, tab.id);
    b.ondragstart = ev => { ev.dataTransfer.setData('text/x-tab', String(i)); ev.dataTransfer.effectAllowed = 'move'; };
    b.ondragover = ev => { if ([...ev.dataTransfer.types].includes('text/x-tab')) { ev.preventDefault(); b.classList.add('drop-before'); } };
    b.ondragleave = () => b.classList.remove('drop-before');
    b.ondrop = ev => { ev.preventDefault(); b.classList.remove('drop-before'); moveInList(sp.tabs, Number(ev.dataTransfer.getData('text/x-tab')), i); commit(); };
    box.appendChild(b);
    if (tab.id === sp.tab) requestAnimationFrame(() => b.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });
}
function machineRow(name, mi) {
  const v = name ? machineView(name) : null, state = name ? (v ? v.state : 'removed') : 'connected';
  const row = document.createElement('div');
  row.className = 'mrow' + (name ? '' : ' local') + (collapsedMachines.has(name) ? '' : ' open');
  row.style.setProperty('--c', MACHINE_COLORS[mi % MACHINE_COLORS.length]);
  row.dataset.mi = String(mi % 4);
  if (name) row.style.setProperty('--dot', state === 'connected' ? '#44cc44' : state === 'connecting' ? 'var(--gold)' : '#ff5544');
  row.innerHTML = '<span class="cap"></span><span class="bar"><button class="mn"></button><button class="mplus" title="New space on this machine">+</button><button class="st"></button><button class="chev">›</button></span>';
  $('.mn', row).textContent = machineLabel(name);
  const why = !name ? (S.linkOk ? 'Connected' : 'Link lost')
    : state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…'
    : state === 'needs_login' ? 'Needs a login: this server cannot log in there yet' : (v && v.why) || 'Not reachable';
  $('.st', row).title = why;
  row.onclick = () => toggleMachine(name);
  $('.mplus', row).onclick = ev => { ev.stopPropagation(); newSpaceOn(name); };
  $('.st', row).onclick = ev => { ev.stopPropagation(); if (name && state !== 'connected') showLoginHelp(name, why); else toast(why); };
  row.ondblclick = ev => { ev.preventDefault(); renameMachine(name); };
  row.oncontextmenu = ev => machineMenu(ev, name);
  return row;
}
function renderSpaces() {
  const box = $('#spaces'); box.textContent = '';
  const names = ['', ...S.machines.map(m => m.name)];
  for (const sp of S.spaces) if (!names.includes(spaceMachine(sp))) names.push(spaceMachine(sp));   // spaces of a machine no longer added
  names.forEach((mname, mi) => {
    box.appendChild(machineRow(mname, mi));
    if (collapsedMachines.has(mname)) return;
    S.spaces.forEach((sp, i) => {
      if (spaceMachine(sp) !== mname) return;
      const st = topState(spaceAddrs(sp)), name = spaceName(sp, i);
      const row = document.createElement('div');
      row.className = 'row sp' + (sp.id === S.active ? ' on' : ''); row.draggable = true;
      row.innerHTML = '<span class="tile"></span><button class="nm"></button>' + (['working', 'blocked', 'done'].includes(st) ? stateMark(st) : '');
      const tile = $('.tile', row); tile.textContent = name[0] || '?'; tile.style.setProperty('--c', SPACE_COLORS[i % SPACE_COLORS.length]);
      $('.nm', row).textContent = name;
      row.onclick = () => selectSpace(sp.id);
      row.ondblclick = () => renameSpace(sp.id);
      row.oncontextmenu = ev => spaceMenu(ev, sp.id);
      row.ondragstart = ev => { ev.dataTransfer.setData('text/x-space', String(i)); row.classList.add('drag'); };
      row.ondragend = () => row.classList.remove('drag');
      row.ondragover = ev => { if ([...ev.dataTransfer.types].includes('text/x-space')) { ev.preventDefault(); row.classList.add('drop-before'); } };
      row.ondragleave = () => row.classList.remove('drop-before');
      row.ondrop = ev => { ev.preventDefault(); row.classList.remove('drop-before'); moveInList(S.spaces, Number(ev.dataTransfer.getData('text/x-space')), i); commit(); };
      box.appendChild(row);
    });
  });
  $('#spaces-count').textContent = pad2(S.spaces.length);
}
const AGENT_SORT_KEY = 'lcars-agent-sort';
let agentSort = localStorage.getItem(AGENT_SORT_KEY) === 'space' ? 'space' : 'priority';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_LAYERS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>';
function setAgentSort(mode) { agentSort = mode; localStorage.setItem(AGENT_SORT_KEY, mode); renderAgents(); }
function agentSortMenu() {
  const b = $('#agents-sort'), r = b.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { head: 'SORT AGENTS' },
    { label: 'Priority', icon: ICON_CLOCK, check: agentSort === 'priority', fn: () => setAgentSort('priority') },
    { label: 'Grouped by space', icon: ICON_LAYERS, check: agentSort === 'space', fn: () => setAgentSort('space') },
  ]);
  b.classList.add('on');
}
function renderAgents() {
  const box = $('#agents'); box.textContent = '';
  const list = agentList();
  $('#agents-count').textContent = pad2(list.length);
  const header = (color, word, count) => { const h = document.createElement('div'); h.className = 'grp'; h.style.setProperty('--c', color); h.textContent = `${word} · ${count}`; box.appendChild(h); };
  // priority: grouped by what the agent is doing; space: grouped by the space it sits in (busiest first inside each)
  const groupOf = t => { if (agentSort !== 'space') return stateOf(t); const l = locate(t.address); return l ? l.sp.id : '~none'; };
  const groupInfo = key => {
    if (agentSort !== 'space') return { color: STATUS_COLOR[key], word: (GROUPS.find(g => g[0] === key) || [key, key.toUpperCase()])[1] };
    const i = S.spaces.findIndex(sp => sp.id === key);
    return i < 0 ? { color: 'var(--gray)', word: 'NOT IN A SPACE' } : { color: SPACE_COLORS[i % SPACE_COLORS.length], word: spaceName(S.spaces[i], i).toUpperCase() };
  };
  const rank = t => { const k = groupOf(t); return agentSort === 'space' ? (k === '~none' ? 9999 : S.spaces.findIndex(sp => sp.id === k)) : 0; };
  if (agentSort === 'space') list.sort((a, b) => (rank(a) - rank(b)) || (ORDER[stateOf(a)] - ORDER[stateOf(b)]) || (a.created_ms - b.created_ms));
  let lastGroup = null;
  for (const t of list) {
    const st = stateOf(t), loc = locate(t.address), g = groupOf(t);
    if (g !== lastGroup) { lastGroup = g; const gi = groupInfo(g); header(gi.color, gi.word, list.filter(x => groupOf(x) === g).length); }
    const row = document.createElement('div');
    row.className = 'row agent' + (loc && loc.sp.id === S.active ? ' in' : '') + (t.address === S.focus ? ' here' : '');
    row.dataset.state = st; row.dataset.addr = t.address; row.style.setProperty('--c', STATUS_COLOR[st]);
    row.innerHTML = `<span class="blk"></span>${TRICORDER}<button class="nm"></button><button class="kill" title="End this agent">⏻</button>`;
    $('.blk', row).textContent = STATUS_WORD[st];
    $('.nm', row).innerHTML = '<span></span><small></small>';
    $('.nm span', row).textContent = labelOf(t);
    $('.nm small', row).textContent = `${folderOf(t)} · ${ageOf(t)}`;
    $('.nm', row).onclick = () => { focusAddr(t.address); document.body.classList.remove('side-open'); };
    $('.nm', row).ondblclick = () => renameTerminal(t.address);
    $('.kill', row).onclick = () => { if (confirm(`End ${labelOf(t)}? The program running in it will stop.`)) { dropFromTree(t.address); endTerminal(t.address); } };
    box.appendChild(row);
  }
  if (!list.length) box.innerHTML = '<div class="rail-title" style="color:#9a8aa8">NO AGENTS</div>';
}
function renderUnplaced() {   // plain terminals no tab shows
  const box = $('#terms'); box.textContent = '';
  const list = [...S.terms.values()].filter(t => !isAgent(t) && !locate(t.address) && !S.fresh.has(t.address)).sort((a, b) => a.created_ms - b.created_ms);
  $('#terms-title').hidden = !list.length;
  for (const t of list) {
    const st = stateOf(t), row = document.createElement('div');
    row.className = 'row term'; row.style.setProperty('--c', STATUS_COLOR[st]);
    row.innerHTML = '<span class="dot"></span><button class="nm"></button><button class="kill" title="End this terminal">⏻</button>';
    $('.nm', row).innerHTML = '<span></span><small></small>';
    $('.nm span', row).textContent = labelOf(t); $('.nm small', row).textContent = `${t.address} · ${STATUS_WORD[st]}`;
    $('.nm', row).onclick = () => { focusAddr(t.address); document.body.classList.remove('side-open'); };
    $('.kill', row).onclick = () => { if (confirm(`End ${labelOf(t)}?`)) endTerminal(t.address); };
    box.appendChild(row);
  }
}

// the split tree as nested flex boxes, with draggable dividers
let lastSig = '';
const flexOf = (n, i) => `${n.w[i] * n.c.length / n.w.reduce((a, b) => a + b, 0)} 1 0px`;
function buildNode(n) {
  if (isLeaf(n)) return P.get(n.a).el;
  const el = document.createElement('div'); el.className = `split ${n.d}`;
  const kids = n.c.map(buildNode);
  kids.forEach((k, i) => {
    k.style.flex = flexOf(n, i);
    if (i) el.appendChild(divider(n, i - 1, el, kids));
    el.appendChild(k);
  });
  return el;
}
function divider(n, i, container, kids) {
  const d = document.createElement('div'); d.className = `divider ${n.d}`;
  d.onpointerdown = e => {
    e.preventDefault(); d.setPointerCapture(e.pointerId); d.classList.add('active');
    const row = n.d === 'row', rect = container.getBoundingClientRect(), size = row ? rect.width : rect.height;
    const total = n.w.reduce((a, b) => a + b, 0), start = row ? e.clientX : e.clientY, w0 = n.w.slice(), min = total * 0.08;
    const move = ev => {
      const dx = ((row ? ev.clientX : ev.clientY) - start) / size * total;
      let a = w0[i] + dx, b = w0[i + 1] - dx;
      if (a < min) { b -= min - a; a = min; } if (b < min) { a -= min - b; b = min; }
      n.w[i] = a; n.w[i + 1] = b; kids.forEach((k, j) => { k.style.flex = flexOf(n, j); });
    };
    const up = () => {
      d.classList.remove('active'); d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up);
      const tab = curTab(); lastSig = sigOf(tab); saveLayout(); P.forEach(p => p.refit());
    };
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
  };
  return d;
}
function zoomOf(tab) { const a = tab && S.zoomed[tab.id]; return a && leaves(tab.root).includes(a) ? a : null; }
const sigOf = tab => JSON.stringify([tab && tab.id, zoomOf(tab), tab && tab.root]);
function renderPanes() {
  const tab = curTab(), root = tab ? tab.root : null, addrs = leaves(root), zoom = zoomOf(tab);
  for (const [a, p] of [...P]) if (!addrs.includes(a)) { p.destroy(); P.delete(a); }
  for (const a of addrs) if (!P.has(a)) P.set(a, new Pane(a));
  if (!addrs.includes(S.focus)) S.focus = addrs[0] || null;
  const sig = sigOf(tab), box = $('#panes');
  if (sig !== lastSig) {
    lastSig = sig; box.textContent = '';
    if (root) {
      if (zoom) { const el = P.get(zoom).el; el.style.flex = '1 1 auto'; box.appendChild(el); }
      else { const el = buildNode(root); if (isLeaf(root)) el.style.flex = '1 1 0px'; box.appendChild(el); }
    }
  }
  document.body.classList.toggle('no-panes', addrs.length === 0);
  for (const [a, p] of P) { p.update(); p.el.classList.toggle('focus', a === S.focus); }
  requestAnimationFrame(() => P.forEach(p => p.refit()));
}
function renderFoot() {
  const agents = agentList(), blocked = agents.filter(t => stateOf(t) === 'blocked').length;
  $('#f-machine').textContent = machineLabel(spaceMachine(curSpace()));
  $('#f-spaces').textContent = `${S.spaces.length} SPACE${S.spaces.length === 1 ? '' : 'S'}`;
  const fa = $('#f-agents'); fa.textContent = `${agents.length} AGENT${agents.length === 1 ? '' : 'S'}${blocked ? ` · ${blocked} NEED YOU` : ''}`; fa.classList.toggle('warn', blocked > 0);
  const sp = curSpace(); $('#top-info').textContent = `${sp ? spaceName(sp, S.spaces.indexOf(sp)) : ''}${' · ' + machineLabel(spaceMachine(sp))}`;
}

// ── event feed ────────────────────────────────────────────────────────
let evRetry = 0, refreshT;
function connectEvents() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
  ws.onopen = () => { evRetry = 0; setConn(true); refreshTerms().catch(() => {}); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'snapshot') $('#conn').title = `Live connection to the server (event ${m.seq})`;
    else if (m.type === 'notification' && m.method === 'event') {
      const e = m.params || {};
      if (e.type === 'doc') { if (e.data && e.data.name === DOC) { S.remoteVersion = Math.max(S.remoteVersion, e.data.version || 0); maybeSync(); } }
      else { clearTimeout(refreshT); refreshT = setTimeout(() => refreshTerms().catch(() => {}), 120); }
    }
    else if (m.type === 'error') toast(m.error, true);
  };
  ws.onclose = () => { setConn(false); setTimeout(connectEvents, Math.min(8000, 700 * ++evRetry)); };
}
function setConn(ok) { S.linkOk = ok; const c = $('#conn'); c.textContent = ok ? 'LINK OK' : 'LINK LOST'; c.className = 'chip sky' + (ok ? '' : ' bad'); document.documentElement.style.setProperty('--local-dot', ok ? '#44cc44' : '#ff5544'); if (S.spaces.length) renderSpaces(); }

// ── machines: collapse, rename, remove, add ───────────────────────────
function toggleMachine(name) {
  collapsedMachines.has(name) ? collapsedMachines.delete(name) : collapsedMachines.add(name);
  try { localStorage.setItem('lcars-machines-collapsed', JSON.stringify([...collapsedMachines])); } catch {}
  renderSpaces();
}
function machineMenu(e, name) {
  e.preventDefault();
  const v = name && machineView(name);
  showMenu(e.clientX, e.clientY, [
    { label: 'Rename', fn: () => renameMachine(name) },
    { label: 'New space here', fn: () => newSpaceOn(name) },
    { label: 'Reconnect', show: !!name, fn: () => reconnectMachine(name) },
    '-',
    { label: 'Remove machine', show: !!name, fn: () => removeMachine(name) },
  ]);
}
function renameAddresses(oldName, newName) {     // `old/t7` becomes `new/t7` everywhere the layout and this page refer to it
  const re = a => (typeof a === 'string' && a.startsWith(oldName + '/')) ? newName + a.slice(oldName.length) : a;
  const walk = n => !n ? n : isLeaf(n) ? { ...n, a: re(n.a) } : { ...n, c: n.c.map(walk) };
  for (const sp of S.spaces) { if (sp.machine === oldName) sp.machine = newName; for (const t of sp.tabs) t.root = walk(t.root); }
  for (const k of Object.keys(S.zoomed)) if (S.zoomed[k]) S.zoomed[k] = re(S.zoomed[k]);
  if (S.focus) S.focus = re(S.focus);
  S.dismissed = new Set([...S.dismissed].map(re));
  if (collapsedMachines.delete(oldName)) collapsedMachines.add(newName);
}
async function renameMachine(name) {
  const v = await ask('RENAME MACHINE', name || S.localName || S.coreName || '', name ? 'letters, digits, - _ .' : 'the name shown for this server');
  if (v === null || !v) return;
  if (!name) { S.localName = v.slice(0, 32); commit(); return; }
  const nn = v.toLowerCase();
  if (nn === name) return;
  try { await post('/api/machines/rename', { machine: name, new_name: nn }); }
  catch (e) { return toast(e.message, true); }
  renameAddresses(name, nn);
  for (const a of [...P.keys()]) if (machineOf(a) === name) { const p = P.get(a); p.destroy ? p.destroy() : p.el.remove(); P.delete(a); }
  commit(); refreshTerms().catch(() => {});
}
async function reconnectMachine(name) {
  try { const m = await post('/api/machines/connect', { machine: name }); toast(`${machineLabel(name)} · ${m.state || 'connecting'}`.toUpperCase()); }
  catch (e) { toast(e.message, true); }
  refreshTerms().catch(() => {});
}
async function removeMachine(name) {
  const spaces = S.spaces.filter(sp => spaceMachine(sp) === name), n = spaces.reduce((k, sp) => k + spaceAddrs(sp).length, 0);
  if (!confirm(`Remove ${machineLabel(name)}? Its ${spaces.length} space${spaces.length === 1 ? '' : 's'} leave LCARS${n ? `; its ${n} terminal${n === 1 ? '' : 's'} keep running on that machine` : ''}.`)) return;
  try { await api('/api/machines?machine=' + encodeURIComponent(name), { method: 'DELETE' }); }
  catch (e) { return toast(e.message, true); }
  for (const sp of spaces) for (const a of spaceAddrs(sp)) { S.dismissed.add(a); const p = P.get(a); if (p) { p.destroy ? p.destroy() : p.el.remove(); P.delete(a); } }
  S.spaces = S.spaces.filter(sp => spaceMachine(sp) !== name);
  if (!S.spaces.length) S.spaces = [newSpace('BRIDGE')];
  if (!S.spaces.some(sp => sp.id === S.active)) { S.active = S.spaces[0].id; S.focus = null; }
  collapsedMachines.delete(name); commit(); refreshTerms().catch(() => {});
}
async function keyHelp(into, cmdEl) {      // this server's public key and the one line that lets it log in
  try { const k = await api('/api/machines/pubkey'); cmdEl.textContent = k.command; into.hidden = false; return k.command; }
  catch (e) { toast(e.message, true); }
}
async function showLoginHelp(name, why) {
  $('#info-title').textContent = `${machineLabel(name)} · ${why.toUpperCase()}`;
  const body = $('#info-body'); body.textContent = '';
  const para = t => { const p = document.createElement('p'); p.className = 'ip'; p.textContent = t; body.appendChild(p); };
  para('This server logs in to other machines with its own SSH key. If it cannot, run this once in that machine\'s console, then right-click the machine and choose Reconnect:');
  const box = document.createElement('div'); box.className = 'icode'; const code = document.createElement('code'); const copy = document.createElement('button');
  copy.className = 'pill orange'; copy.textContent = 'COPY'; box.append(code, copy); body.appendChild(box);
  const cmd = await keyHelp({ hidden: false }, code);
  copy.onclick = async () => { try { await navigator.clipboard.writeText(cmd || ''); toast('COPIED'); } catch { toast('Copy needs a secure page (https)', true); } };
  $('#info-shell').hidden = true; $('#info-dlg').showModal();
}
function openAddMachine() {
  $('#mach-name').value = ''; $('#mach-target').value = ''; $('#mach-install').checked = true; $('#mach-help').hidden = true;
  const m = $('#mach-msg'); m.className = 'dim'; m.textContent = ''; $('#mach-go').disabled = false; $('#mach-go').textContent = 'CONNECT';
  $('#mach-dlg').showModal(); $('#mach-name').focus();
}
async function submitMachine() {
  const name = $('#mach-name').value.trim().toLowerCase(), target = $('#mach-target').value.trim(), msg = $('#mach-msg'), go = $('#mach-go');
  if (!name || !target) { msg.className = 'err'; msg.textContent = 'Give it a name and an SSH address.'; return; }
  go.disabled = true; go.textContent = 'CONNECTING…'; msg.className = 'dim'; msg.textContent = 'Logging in over SSH…'; $('#mach-help').hidden = true;
  try {
    await post('/api/machines', { name, target, install: $('#mach-install').checked });
    $('#mach-dlg').close();
    const sp = newSpace(null, name); S.spaces.push(sp); S.active = sp.id; S.focus = null; collapsedMachines.delete(name); commit();
    await refreshTerms().catch(() => {}); toast(`${machineLabel(name)} CONNECTED`);
  } catch (e) {
    msg.className = 'err'; msg.textContent = e.message;
    if (/log ?in|permission|publickey|password|host key|reach|denied/i.test(e.message)) keyHelp($('#mach-help'), $('#mach-cmd'));
  } finally { go.disabled = false; go.textContent = 'CONNECT'; }
}

// ── wiring ────────────────────────────────────────────────────────────
const KEYSEQ = { esc: '\x1b', tab: '\t', 'ctrl-c': '\x03', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r' };
function toggleSound() {
  S.sound = !S.sound; localStorage.setItem('lcars-sound', S.sound ? 'on' : 'off');
  $('#sound-btn').textContent = S.sound ? 'SOUND ON' : 'SOUND OFF'; if (S.sound) play('keyok1');
}
function startSession(kind) {
  const dlg = $('#new-dlg');
  $('#new-title').textContent = kind === 'claude' ? 'NEW CLAUDE SESSION' : 'NEW SHELL';
  const remote = !!spaceMachine(curSpace()), here = machineOf(S.focus || '') === spaceMachine(curSpace());
  $('#new-name').value = ''; $('#new-cwd').value = remote ? (here && cwdOf(S.focus)) || '' : (here && cwdOf(S.focus)) || '/root'; $('#new-cwd').placeholder = remote ? 'empty: its home folder' : ''; dlg.returnValue = ''; dlg.dataset.kind = kind; dlg.showModal(); $('#new-name').focus();
}
function init() {
  $('#new-claude').onclick = () => startSession('claude');
  $('#new-shell').onclick = () => startSession('shell');
  $('#tab-add').onclick = ev => {
    const r = ev.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [{ label: 'Terminal', cmd: 'tab.new' }, { label: 'Claude', cmd: 'tab.new_claude' }, { label: 'Claude (named)…', cmd: 'tab.new_claude_named' }, '-', { label: 'New space', cmd: 'space.new' }]);
  };
  $('#space-add').onclick = () => run('space.new');
  $('#search-btn').onclick = openPicker;
  initPanel();
  $('#agents-sort').onclick = () => { agentSortMenu(); };
  $('#machine-add').onclick = openAddMachine;
  $('#mach-form').addEventListener('submit', ev => { if (ev.submitter && ev.submitter.value === 'cancel') return; ev.preventDefault(); submitMachine(); });
  for (const id of ['#mach-name', '#mach-target']) $(id).addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submitMachine(); } });
  $('#mach-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#mach-cmd').textContent); toast('COPIED'); } catch { toast('Copy needs a secure page (https)', true); } };
  $('#side-btn').onclick = $('#side-show').onclick = () => run('layout.toggle_sidebar');
  const pk = $('#pick-input');
  pk.addEventListener('input', () => fillPicker(pk.value));
  pk.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePick(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); movePick(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPicker(pickSel); }
  });
  setupTitlebar();
  $('#agents-btn').onclick = ev => { const r = ev.currentTarget.getBoundingClientRect(); agentsMenu(r.right + 6, r.top); };
  $('#info-close').onclick = () => $('#info-dlg').close();
  $('#info-dlg').addEventListener('close', () => { $('#info-shell').hidden = false; });
  $('#info-shell').onclick = () => { $('#info-dlg').close(); openBeside('shell', { cwd: cwdOf(S.focus) }); };
  $('#keys-btn').onclick = () => run('app.help');
  $('#f-hint').onclick = () => run('app.palette');
  $('#menu-btn').onclick = () => document.body.classList.toggle('side-open');
  $('#main').addEventListener('click', () => document.body.classList.remove('side-open'));
  $('#upload-btn').onclick = () => { if (!S.focus) return toast('Focus a terminal first', true); $('#file-input').click(); };
  $('#file-input').onchange = ev => { const p = P.get(S.focus); if (p) p.sendFiles([...ev.target.files]); ev.target.value = ''; };
  $('#sound-btn').onclick = toggleSound; $('#sound-btn').textContent = S.sound ? 'SOUND ON' : 'SOUND OFF';
  $('#keybar').addEventListener('click', ev => { const k = ev.target.dataset && ev.target.dataset.k; const p = P.get(S.focus); if (k && p) { p.send({ type: 'input', data: KEYSEQ[k] }); p.term.focus(); } });
  $('#tabs').addEventListener('wheel', ev => { ev.preventDefault(); stepTab(ev.deltaY > 0 || ev.deltaX > 0 ? 1 : -1); }, { passive: false });
  $('#new-dlg').addEventListener('close', ev => {
    const dlg = ev.target;
    if (dlg.returnValue === 'ok') openBeside(dlg.dataset.kind, { name: $('#new-name').value.trim(), cwd: $('#new-cwd').value.trim(), explicit: true });
  });
  const pi = $('#pal-input');
  pi.addEventListener('input', () => fillPalette(pi.value));
  pi.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePal(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); movePal(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(palSel); }
  });
  $('#help-close').onclick = () => $('#help-dlg').close();
  document.querySelectorAll('dialog button[value=cancel]').forEach(b => { b.type = 'button'; b.onclick = () => b.closest('dialog').close('cancel'); });
  setInterval(renderAgents, 30000);
  setInterval(() => { $('#f-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
  document.addEventListener('paste', ev => {   // an image pasted anywhere goes to the focused terminal
    const files = [...(ev.clipboardData ? ev.clipboardData.files : [])], p = P.get(S.focus);
    if (files.length && p && !p.el.contains(ev.target)) { ev.preventDefault(); p.sendFiles(files); }
  });
  window.addEventListener('resize', () => P.forEach(p => p.refit()));
}

let installEvt = null;
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstall() { $('#install-btn').hidden = !installEvt || isInstalled(); }
async function installApp() {
  if (isInstalled()) return toast('ALREADY RUNNING AS AN APP');
  if (!installEvt) return toast('Use the install icon in the browser address bar, or its menu: Cast, save and share > Install page as app', true);
  installEvt.prompt();
  const choice = await installEvt.userChoice.catch(() => null);
  if (choice && choice.outcome === 'accepted') toast('INSTALLING…');
  installEvt = null; showInstall();
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; showInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; showInstall(); toast('INSTALLED'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

// Installed as an app with the title bar merged into our top bar (Window Controls Overlay): keep clear of the
// system's own minimize / maximize / close buttons, which stay at the window's edge.
function setupTitlebar() {
  const w = navigator.windowControlsOverlay; if (!w) return;
  const apply = () => {
    document.body.classList.toggle('wco', !!w.visible);
    if (w.visible) { const r = w.getTitlebarAreaRect(); document.documentElement.style.setProperty('--wco-right', Math.max(0, innerWidth - r.x - r.width) + 'px'); }
  };
  apply(); w.addEventListener('geometrychange', apply);
}
async function loadStatus() {
  try { const r = await api('/api/status'); S.coreName = (r.core && r.core.name) || ''; } catch {}
}

(async function main() {
  init();
  loadStatus().then(() => { if (S.spaces.length) render(); });
  // The terminal font must be loaded before the first terminal measures its cells, or text is laid out on the wrong grid.
  await Promise.all([document.fonts.load('15px "Hack"'), document.fonts.load('bold 15px "Hack"')]).catch(() => {});
  $('#install-btn').onclick = installApp;
  loadAgents().then(() => { if (S.spaces.length) render(); });   // names in the lists; wait until the layout has loaded
  await loadLayout();
  // Learn which terminals still exist before drawing, so a pane is never opened on a dead one.
  try { await refreshTerms(); } catch (e) { toast(e.message, true); render(); }
  connectEvents();
})();
