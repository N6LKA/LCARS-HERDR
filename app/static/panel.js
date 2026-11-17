'use strict';
/* Files and Changes panels, after the Herdr app: a folder tree and a git change list beside the terminals.
   Loaded before app.js; it uses app.js's S, api, post, toast, cwdOf, def and bind when those functions run. */

const PANEL = {
  which: null,            // 'files' | 'changes' | null (the panel shows the choice saved for the active space)
  saved: JSON.parse(localStorage.getItem('lcars-panels') || '{}'),
  width: Number(localStorage.getItem('lcars-panel-w')) || 368,
  root: '',               // the folder the panel is showing (the focused terminal's folder)
  openDirs: new Set(),    // expanded folders (this root)
  openByRoot: new Map(),  // remembered per root while the page is open
  cache: new Map(),       // folder -> entries
  marks: new Map(),       // absolute path -> A/M/D/U
  truncated: false,
  view: null,             // a file being viewed {path, text, ...}
  git: null,              // last /api/git/status
  diffOpen: null, diffClosed: false, diff: null,
  busy: false,
};
const panelEl = id => document.getElementById(id);
const joinPath = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
const MARK_COLOR = { A: '#7fd17f', M: '#ffcc66', D: '#ff7766', U: '#cc99cc' };
const ICON_DIR = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.2l1.6 1.6h6.2a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.5 1.7h6l3 3v9.6h-9z"/><path d="M9.5 1.7v3h3"/></svg>';

// Sidebar width: drag its right edge; remembered in this browser, double-click for the default.
const SIDE = { def: 250, min: 200, max: 560, key: 'lcars-side-w' };
function setSide(w, save) {
  w = Math.round(Math.max(SIDE.min, Math.min(SIDE.max, w, window.innerWidth * 0.5)));
  document.documentElement.style.setProperty('--side', w + 'px');
  if (save) localStorage.setItem(SIDE.key, w);
  return w;
}
function initSideResize() {
  const saved = Number(localStorage.getItem(SIDE.key)); if (saved) setSide(saved, false);
  const d = document.getElementById('sdiv'); if (!d) return;
  d.addEventListener('pointerdown', e => {
    e.preventDefault(); d.setPointerCapture(e.pointerId); d.classList.add('active'); document.body.style.userSelect = 'none';
    const x0 = e.clientX, w0 = document.getElementById('side').getBoundingClientRect().width;   // relative to where it was grabbed
    const move = ev => { setSide(w0 + ev.clientX - x0, false); };
    const up = ev => { d.classList.remove('active'); document.body.style.userSelect = ''; d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up);
      setSide(w0 + ev.clientX - x0, true); P.forEach(p => p.refit()); };
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
  });
  d.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--side'); localStorage.removeItem(SIDE.key); P.forEach(p => p.refit()); });
  window.addEventListener('resize', () => { const w = Number(localStorage.getItem(SIDE.key)); if (w) setSide(w, false); });
}
function savePanels() { localStorage.setItem('lcars-panels', JSON.stringify(PANEL.saved)); }
function panelCwd() { return (typeof cwdOf === 'function' && S.focus && cwdOf(S.focus)) || (typeof S !== 'undefined' && S.home) || '/'; }
function relPath(p) { return PANEL.root && p.startsWith(PANEL.root + '/') ? p.slice(PANEL.root.length + 1) : p; }

function applyPanelDom() {
  const open = !!PANEL.which, panel = panelEl('panel');
  panel.hidden = !open; panelEl('pdiv').hidden = !open;
  panel.style.setProperty('--pw', PANEL.width + 'px');
  panelEl('btn-files').classList.toggle('on', PANEL.which === 'files');
  panelEl('btn-changes').classList.toggle('on', PANEL.which === 'changes');
  panelEl('p-title').textContent = PANEL.which === 'changes' ? 'CHANGES' : 'FILES';
  panelEl('p-foot').hidden = PANEL.which !== 'changes';
  requestAnimationFrame(() => typeof P !== 'undefined' && P.forEach(p => p.refit()));
  if (open) panelRefresh();
}
function setPanel(which) {            // choosing the open one closes it
  PANEL.which = PANEL.which === which ? null : which;
  PANEL.saved[S.active] = PANEL.which; savePanels();
  PANEL.view = null; PANEL.diffClosed = false; PANEL.diffOpen = null; PANEL.diff = null;
  applyPanelDom();
}
let lastSpace = null, lastCwd = null;
function panelSync() {                // called after every draw: follow the space and the focused terminal's folder
  if (S.active !== lastSpace) {
    lastSpace = S.active;
    const w = PANEL.saved[S.active] || null;
    if (w !== PANEL.which) { PANEL.which = w; PANEL.view = null; PANEL.diff = null; applyPanelDom(); }
  }
  if (PANEL.which) { const c = panelCwd(); if (c !== lastCwd) { lastCwd = c; panelRefresh(); } }
}

async function panelRefresh() {
  if (!PANEL.which || PANEL.busy) return;
  if (S.focus && S.focus.includes('/')) { panelEl('p-sub').textContent = ''; panelEl('p-back').hidden = true; panelEl('p-foot').hidden = true; return renderMessage('Not available on remote machines yet.'); }
  PANEL.busy = true;
  try { await (PANEL.which === 'files' ? filesRefresh() : changesRefresh()); }
  catch (e) { renderMessage(e.message || String(e)); }
  finally { PANEL.busy = false; }
}
function renderMessage(text) { const b = panelEl('p-body'); b.textContent = ''; const d = document.createElement('div'); d.className = 'pmsg'; d.textContent = text; b.appendChild(d); }

// ── Files ──────────────────────────────────────────────────────────────
async function filesRefresh() {
  const root = panelCwd();
  if (root !== PANEL.root) {
    if (PANEL.root) PANEL.openByRoot.set(PANEL.root, PANEL.openDirs);
    PANEL.root = root; PANEL.openDirs = PANEL.openByRoot.get(root) || new Set(); PANEL.cache = new Map(); PANEL.view = null;
  }
  const dirs = [root, ...PANEL.openDirs];
  await Promise.all(dirs.map(async d => {
    try { const r = await api('/api/fs/list?path=' + encodeURIComponent(d)); PANEL.cache.set(d, r.entries); if (d === root) PANEL.truncated = r.truncated; }
    catch (e) { if (d === root) { PANEL.cache.delete(d); PANEL.rootError = e.message; } else PANEL.openDirs.delete(d); }
  }));
  try {
    const g = await api('/api/git/status?cwd=' + encodeURIComponent(root));
    PANEL.marks = new Map(); if (!g.error) for (const f of g.files) PANEL.marks.set(joinPath(g.root, f.path), f.status);
  } catch { PANEL.marks = new Map(); }
  renderFiles();
}
function renderFiles() {
  const body = panelEl('p-body'), sub = panelEl('p-sub'); body.textContent = '';
  panelEl('p-back').hidden = !PANEL.view;
  if (PANEL.view) return renderViewer(body, sub);
  sub.textContent = PANEL.root.split('/').filter(Boolean).pop() || '/';
  sub.title = PANEL.root;
  if (!PANEL.cache.has(PANEL.root)) return renderMessage(PANEL.rootError || 'No folder');
  const entries = PANEL.cache.get(PANEL.root);
  if (!entries.length) return renderMessage('No files');
  let rows = 0;
  const walk = (dir, depth) => {
    for (const e of PANEL.cache.get(dir) || []) {
      if (rows++ > 5000) return;
      const path = joinPath(dir, e.name), row = document.createElement('div');
      row.className = 'frow'; row.style.paddingLeft = `${8 + Math.min(depth, 40) * 18}px`;
      const open = e.dir && PANEL.openDirs.has(path);
      row.innerHTML = `<span class="chev">${e.dir ? (open ? '▾' : '▸') : ''}</span><span class="ico">${e.dir ? ICON_DIR : ICON_FILE}</span><span class="fn"></span><span class="gm"></span>`;
      row.querySelector('.fn').textContent = e.name;
      const m = !e.dir && PANEL.marks.get(path);
      if (m) { const g = row.querySelector('.gm'); g.textContent = m; g.style.color = MARK_COLOR[m]; }
      row.onclick = () => (e.dir ? toggleDir(path) : openFile(path));
      body.appendChild(row);
      if (open) walk(path, depth + 1);
    }
  };
  walk(PANEL.root, 0);
  if (PANEL.truncated) { const n = document.createElement('div'); n.className = 'pmsg dim'; n.textContent = 'File list limited to 500 entries per folder'; body.appendChild(n); }
}
async function toggleDir(path) {
  if (PANEL.openDirs.has(path)) { for (const d of [...PANEL.openDirs]) if (d === path || d.startsWith(path + '/')) { PANEL.openDirs.delete(d); PANEL.cache.delete(d); } renderFiles(); return; }
  PANEL.openDirs.add(path);
  try { PANEL.cache.set(path, (await api('/api/fs/list?path=' + encodeURIComponent(path))).entries); } catch (e) { PANEL.openDirs.delete(path); toast(e.message, true); }
  renderFiles();
}
async function openFile(path) {
  try { PANEL.view = await api('/api/fs/read?path=' + encodeURIComponent(path)); }
  catch (e) { toast(e.message, true); return; }
  renderFiles();
}

// ── syntax highlighting (highlight.js, vendored; only for languages it knows, and not for huge files) ──
const HL_EXT = { py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml', plist: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', cs: 'csharp', ini: 'ini', conf: 'ini', cfg: 'ini', toml: 'ini', env: 'ini',
  service: 'ini', timer: 'ini', socket: 'ini', desktop: 'ini', diff: 'diff', patch: 'diff', ps1: 'powershell', mk: 'makefile', graphql: 'graphql' };
const HL_NAME = { dockerfile: 'dockerfile', makefile: 'makefile', '.bashrc': 'bash', '.profile': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash',
  '.env': 'ini', 'nginx.conf': 'nginx' };
const HL_SHEBANG = [[/python/, 'python'], [/node|deno|bun/, 'javascript'], [/\b(ba|z|k|da)?sh\b/, 'bash'], [/ruby/, 'ruby'], [/perl/, 'perl'], [/php/, 'php'], [/lua/, 'lua']];
function hlLanguage(path, text) {
  if (typeof hljs === 'undefined') return null;
  const base = path.split('/').pop().toLowerCase();
  let lang = HL_NAME[base] || HL_EXT[base.includes('.') ? base.split('.').pop() : ''] || null;
  if (!lang && text.startsWith('#!')) { const first = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 120); for (const [re, l] of HL_SHEBANG) if (re.test(first)) { lang = l; break; } }
  return lang && hljs.getLanguage(lang) ? lang : null;
}
// highlight.js returns one run of HTML; cut it at the line ends, closing and reopening spans so every line stands alone
function hlLines(html) {
  const out = [], open = []; let cur = '';
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (tok === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else { if (tok.startsWith('<span')) open.push(tok); else if (tok === '</span>') open.pop(); cur += tok; }
  }
  out.push(cur); return out;
}
function renderViewer(body, sub) {
  const v = PANEL.view; sub.textContent = relPath(v.path); sub.title = v.path;
  const bar = document.createElement('div'); bar.className = 'vbar';
  const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'pill gold small'; b.textContent = label; b.onclick = fn; bar.appendChild(b); };
  mk('PASTE PATH', () => { const p = P.get(S.focus); if (p) { p.term.paste(v.path + ' '); p.term.focus(); } else toast('Focus a terminal first', true); });
  mk('COPY PATH', async () => { try { await navigator.clipboard.writeText(v.path); toast('COPIED'); } catch { toast('Copy needs a secure page (https)', true); } });
  const size = document.createElement('span'); size.className = 'dim'; size.textContent = `${v.size.toLocaleString()} bytes`; bar.appendChild(size);
  body.appendChild(bar);
  if (v.binary) return renderNote(body, 'Binary file · no text preview');
  const code = document.createElement('div'); code.className = 'code';
  const lines = v.text.split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let marked = null;   // the same lines as HTML with syntax colours, when the language is known and the file is a sensible size
  const lang = v.text.length <= 300000 ? hlLanguage(v.path, v.text) : null;
  if (lang) { try { marked = hlLines(hljs.highlight(v.text.replace(/\t/g, '    '), { language: lang, ignoreIllegals: true }).value); } catch { marked = null; } }
  const frag = document.createDocumentFragment();
  lines.forEach((t, i) => {
    const l = document.createElement('div'); l.className = 'dl';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1;
    const x = document.createElement('span'); x.className = 't';
    if (marked && marked.length >= lines.length) x.innerHTML = marked[i]; else x.textContent = t.replace(/\t/g, '    ');
    l.append(n, x); frag.appendChild(l);
  });
  code.appendChild(frag); body.appendChild(code);
  if (v.truncated) renderNote(body, '… (file truncated)');
}
function renderNote(body, text) { const n = document.createElement('div'); n.className = 'pmsg dim'; n.textContent = text; body.appendChild(n); }

// ── Changes ────────────────────────────────────────────────────────────
async function changesRefresh() {
  const cwd = panelCwd();
  const g = await api('/api/git/status?cwd=' + encodeURIComponent(cwd));
  PANEL.git = g; PANEL.root = cwd;
  if (g.error) { PANEL.diff = null; return renderChanges(); }
  if (PANEL.diffOpen && !g.files.some(f => f.path === PANEL.diffOpen)) { PANEL.diffOpen = null; PANEL.diff = null; }
  if (!PANEL.diffOpen && !PANEL.diffClosed && g.files.length) PANEL.diffOpen = g.files[0].path;   // the first file opens until you close one
  if (PANEL.diffOpen) { try { PANEL.diff = await api(`/api/git/diff?cwd=${encodeURIComponent(g.root)}&path=${encodeURIComponent(PANEL.diffOpen)}`); } catch (e) { PANEL.diff = { error: e.message }; } }
  renderChanges();
}
function renderChanges() {
  const body = panelEl('p-body'), sub = panelEl('p-sub'), g = PANEL.git; body.textContent = '';
  panelEl('p-back').hidden = true;
  if (!g) return renderMessage('Loading changes…');
  panelEl('p-foot').hidden = !!g.error;
  if (g.error) { sub.textContent = ''; return renderMessage(g.error); }
  sub.textContent = '';
  const head = document.createElement('div'); head.className = 'chead';
  const branch = `⎇ ${g.branch}${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}`;
  head.innerHTML = '<span class="br"></span><span class="cnt"></span><span class="tot"><b class="a"></b> <b class="d"></b></span>';
  head.querySelector('.br').textContent = branch; head.querySelector('.br').title = g.root;
  head.querySelector('.cnt').textContent = `${g.files.length} FILE${g.files.length === 1 ? '' : 'S'}`;
  head.querySelector('.a').textContent = `+${g.add}`; head.querySelector('.d').textContent = `−${g.del}`;
  body.appendChild(head);
  if (!g.files.length) return renderNote(body, 'No uncommitted changes');
  const list = document.createElement('div'); list.className = 'clist';
  for (const f of g.files) {
    const row = document.createElement('div'); row.className = 'frow' + (f.path === PANEL.diffOpen ? ' sel' : ''); row.style.paddingLeft = '8px';
    const slash = f.path.lastIndexOf('/'), dir = slash >= 0 ? f.path.slice(0, slash + 1) : '', name = f.path.slice(slash + 1);
    row.innerHTML = '<span class="gm"></span><span class="fdir"></span><span class="fn"></span><span class="ca"></span><span class="cd"></span>';
    const gm = row.querySelector('.gm'); gm.textContent = f.status; gm.style.color = MARK_COLOR[f.status];
    row.querySelector('.fdir').textContent = dir; row.querySelector('.fn').textContent = name;
    if (f.add) { const a = row.querySelector('.ca'); a.textContent = `+${f.add}`; }
    if (f.del) { const d = row.querySelector('.cd'); d.textContent = `−${f.del}`; }
    row.onclick = () => {
      if (PANEL.diffOpen === f.path) { PANEL.diffOpen = null; PANEL.diff = null; PANEL.diffClosed = true; renderChanges(); }
      else { PANEL.diffOpen = f.path; PANEL.diffClosed = false; PANEL.diff = null; renderChanges(); loadDiff(); }
    };
    list.appendChild(row);
  }
  body.appendChild(list);
  if (g.truncated) renderNote(body, 'Showing the first 1,000 changed files');
  const dv = document.createElement('div'); dv.className = 'cdiff'; body.appendChild(dv);
  if (!PANEL.diffOpen) { const n = document.createElement('div'); n.className = 'pmsg dim'; n.textContent = 'Select a file to view its changes'; dv.appendChild(n); return; }
  renderDiff(dv);
}
async function loadDiff() {
  if (!PANEL.git || !PANEL.diffOpen) return;
  try { PANEL.diff = await api(`/api/git/diff?cwd=${encodeURIComponent(PANEL.git.root)}&path=${encodeURIComponent(PANEL.diffOpen)}`); } catch (e) { PANEL.diff = { error: e.message }; }
  renderChanges();
}
function renderDiff(dv) {
  const d = PANEL.diff;
  const note = t => { const n = document.createElement('div'); n.className = 'pmsg dim'; n.textContent = t; dv.appendChild(n); };
  if (!d) return note('Loading…');
  if (d.error) return note('Cannot preview this diff (' + d.error + ')');
  if (d.binary) return note('Binary file · no text diff');
  if (!d.diff) return note('No text diff available');
  let oldN = 0, newN = 0;
  const frag = document.createDocumentFragment();
  for (const raw of d.diff.split('\n')) {
    const l = document.createElement('div'), n = document.createElement('span'), t = document.createElement('span');
    n.className = 'n'; t.className = 't';
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/); if (m) { oldN = +m[1]; newN = +m[2]; }
      l.className = 'dl hunk'; t.textContent = raw;
    } else if (raw.startsWith('+')) { l.className = 'dl add'; n.textContent = newN++; t.textContent = raw.slice(1).replace(/\t/g, '    '); }
    else if (raw.startsWith('-')) { l.className = 'dl del'; n.textContent = oldN++; t.textContent = raw.slice(1).replace(/\t/g, '    '); }
    else if (raw.startsWith('\\')) { l.className = 'dl hunk'; t.textContent = raw; }
    else { l.className = 'dl'; n.textContent = newN; oldN++; newN++; t.textContent = raw.slice(1).replace(/\t/g, '    '); }
    l.append(n, t); frag.appendChild(l);
  }
  dv.appendChild(frag);
  if (d.truncated) note('… (showing the first 1,500 lines)');
}
async function commitChanges() {
  const input = panelEl('c-msg'), note = panelEl('c-note'), msg = input.value.trim(), g = PANEL.git;
  if (!msg || !g || g.error || !g.files.length) return;
  if (!confirm(`Commit ${g.files.length} file${g.files.length === 1 ? '' : 's'} to ${g.branch}?\n\nThis stages everything first (git add -A).`)) return;
  panelEl('c-btn').disabled = true; note.textContent = 'COMMITTING…'; note.className = '';
  try { await post('/api/git/commit', { cwd: g.root, message: msg }); input.value = ''; note.textContent = ''; toast('COMMITTED'); }
  catch (e) { note.textContent = 'Commit failed: ' + e.message; note.className = 'err'; }
  finally { panelEl('c-btn').disabled = false; PANEL.diffClosed = false; PANEL.diffOpen = null; panelRefresh(); }
}

// ── wiring ─────────────────────────────────────────────────────────────
function initPanel() {
  panelEl('btn-files').onclick = () => setPanel('files');
  panelEl('btn-changes').onclick = () => setPanel('changes');
  panelEl('p-close').onclick = () => { PANEL.saved[S.active] = null; savePanels(); PANEL.which = null; applyPanelDom(); };
  panelEl('p-back').onclick = () => { PANEL.view = null; renderFiles(); };
  panelEl('c-btn').onclick = commitChanges;
  panelEl('c-msg').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitChanges(); } else if (e.key === 'Escape') e.target.blur(); e.stopPropagation(); });
  // drag the divider to resize; double-click resets
  initSideResize();
  const pd = panelEl('pdiv');
  pd.onpointerdown = e => {
    e.preventDefault(); pd.setPointerCapture(e.pointerId); pd.classList.add('active');
    const x0 = e.clientX, w0 = PANEL.width, max = Math.min(900, Math.floor(innerWidth * 0.7));
    const move = ev => { PANEL.width = Math.max(280, Math.min(max, w0 + (x0 - ev.clientX))); panelEl('panel').style.setProperty('--pw', PANEL.width + 'px'); };
    const up = () => { pd.classList.remove('active'); pd.removeEventListener('pointermove', move); pd.removeEventListener('pointerup', up); localStorage.setItem('lcars-panel-w', PANEL.width); P.forEach(p => p.refit()); };
    pd.addEventListener('pointermove', move); pd.addEventListener('pointerup', up);
  };
  pd.ondblclick = () => { PANEL.width = 368; localStorage.setItem('lcars-panel-w', 368); panelEl('panel').style.setProperty('--pw', '368px'); P.forEach(p => p.refit()); };
  setInterval(() => { if (PANEL.which && !document.hidden) panelRefresh(); }, 10000);   // like the Herdr app: every 10 seconds
  def('panel.files', 'Show or hide the Files panel', () => setPanel('files'), 'Panels');
  def('panel.changes', 'Show or hide the Changes panel', () => setPanel('changes'), 'Panels');
  bind('ctrl+alt+f', 'panel.files'); bind('ctrl+alt+g', 'panel.changes');
}
