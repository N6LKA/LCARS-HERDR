// Look of the interface: TNG era (the original) or Picard era. The choice is kept in this browser (so the page paints
// the right look at once) and in the signed-in account (so every device follows it).
(() => {
  const KEY = 'lcars-theme', VALID = ['tng', 'picard', 'titan'], BAR = { tng: '#000000', picard: '#03060a', titan: '#05070b' };
  const cur = () => VALID.includes(document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : 'tng';
  function mark() {
    document.querySelectorAll('#sec-themes button').forEach(b => {
      const on = b.dataset.theme === cur(); b.setAttribute('aria-pressed', on);
      b.textContent = (on ? '\u2713 ' : '') + (b.dataset.label || b.textContent.replace('\u2713 ', ''));
    });
  }
  function apply(t) {
    if (!VALID.includes(t)) return;
    if (t !== 'tng') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(KEY, t); } catch {}
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', BAR[t]);
    window.dispatchEvent(new CustomEvent('lcars-theme', { detail: t }));
    mark();
  }
  const saveToAccount = t => fetch('/api/auth/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: t }) }).catch(() => {});
  const saveClock = v => fetch('/api/auth/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clock: v }) }).catch(() => {});
  window.lcarsTheme = { apply, cur };
  // 12 or 24 hour clock: kept in this browser and, like the look, in the account
  const CK = 'lcars-clock';
  const clockGet = () => { try { return localStorage.getItem(CK) === '24' ? '24' : '12'; } catch { return '12'; } };
  function clockMark() {
    document.querySelectorAll('#sec-clock button').forEach(b => {
      const on = b.dataset.clock === clockGet(); b.setAttribute('aria-pressed', on);
      b.textContent = (on ? '\u2713 ' : '') + (b.dataset.label || b.textContent.replace('\u2713 ', ''));
    });
  }
  function clockApply(v) {
    if (v !== '12' && v !== '24') return;
    try { localStorage.setItem(CK, v); } catch {}
    window.dispatchEvent(new CustomEvent('lcars-clock', { detail: v })); clockMark();
  }
  window.lcarsClock = { get: clockGet, apply: clockApply };
  // the default agent (what NEW AGENT starts): this browser and the account, same as the clock
  const AK = 'lcars-agent';
  const agentGet = () => { try { return localStorage.getItem(AK) || ''; } catch { return ''; } };
  const agentApply = v => { if (!/^[a-z0-9_-]{1,20}$/.test(v || '')) return; try { localStorage.setItem(AK, v); } catch {} window.dispatchEvent(new CustomEvent('lcars-agent', { detail: v })); };
  const agentSave = v => fetch('/api/auth/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: v }) }).catch(() => {});
  window.lcarsAgent = { get: agentGet, apply: agentApply, save: agentSave };
  // follow the account's choice (set on another device), or hand it this browser's choice if the account has none yet
  fetch('/api/auth/status').then(r => r.ok ? r.json() : null).then(s => {
    if (!s || !s.user) return;
    const t = s.prefs && s.prefs.theme;
    if (t && t !== cur()) apply(t); else if (!t && cur() !== 'tng') saveToAccount(cur());
    const c = s.prefs && s.prefs.clock;
    if (c && c !== clockGet()) clockApply(c); else if (!c && clockGet() === '24') saveClock('24');
    const ag = s.prefs && s.prefs.agent;
    if (ag && ag !== agentGet()) agentApply(ag); else if (!ag && agentGet()) agentSave(agentGet());
  }).catch(() => {});
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#sec-themes button').forEach(b => { b.dataset.label = b.textContent; b.onclick = () => { apply(b.dataset.theme); saveToAccount(b.dataset.theme); }; });
    mark();
    document.querySelectorAll('#sec-clock button').forEach(b => { b.dataset.label = b.textContent; b.onclick = () => { clockApply(b.dataset.clock); saveClock(b.dataset.clock); }; });
    clockMark();
  });
})();
