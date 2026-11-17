// SETTINGS: change the password, set up two-step login, see and sign out devices.
(() => {
  const $ = s => document.querySelector(s);
  const api = async (path, body) => {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error(j.detail || j.error || `error ${r.status}`);
    return j;
  };
  const say = (id, text, bad) => { const e = $(id); e.textContent = text || ''; e.style.color = bad ? '#ff7766' : ''; };
  const when = t => new Date(t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  let on = false, setting = false, tab = 'display';
  function showTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('#sec-tabs [data-tab]')) { const sel = b.dataset.tab === t; b.setAttribute('aria-selected', sel); b.tabIndex = sel ? 0 : -1; }
    for (const e of document.querySelectorAll('#sec-panels section[data-tab]')) e.classList.toggle('on', e.dataset.tab === t);
    $('#sec-panels').scrollTop = 0;
  }

  async function refresh() {
    const s = await api('/api/auth/status');
    on = s.totp;
    $('#sec-who').textContent = s.user ? `Signed in as ${s.user} (${s.role}).` : 'This session came from a program on this machine, not an account.';
    $('#sec-hid-user').value = s.user || '';
    $('#sec-users-sec').hidden = s.role !== 'admin'; $('#sec-tab-users').hidden = s.role !== 'admin'; if ($('#sec-users-sec').hidden && tab === 'users') showTab('display');
    if (s.users) $('#sec-users').replaceChildren(...s.users.map(x => {
      const d = document.createElement('div'); d.className = 'urow';
      const t = document.createElement('span'); t.textContent = `${x.username} · ${x.role} · 2FA ${x.totp ? 'on' : 'off'}${x.signed_in ? ' · signed in' : ''}`; d.append(t);
      if (x.username !== s.user) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pill red'; b.textContent = 'REMOVE'; b.onclick = () => removeUser(x.username); d.append(b); }
      return d;
    }));
    $('#sec-2fa-state').textContent = on ? `ON. ${s.recovery_left} recovery code(s) left.` : 'OFF. Logging in needs only the password.';
    $('#sec-2fa-go').textContent = on ? 'TURN OFF 2FA' : setting ? 'CONFIRM CODE' : 'SET UP 2FA';
    $('#sec-2fa-setup').hidden = on || !setting; $('#sec-code-l').hidden = on ? true : !setting;
    $('#sec-sessions').replaceChildren(...s.sessions.map(x => {
      const d = document.createElement('div'); d.className = 'dim';
      d.textContent = `${x.current ? 'THIS DEVICE · ' : ''}${x.ip} · ${when(x.last)} · ${(x.ua.match(/(Firefox|Edg|Chrome|Safari)[^ ]*/) || [x.ua.slice(0, 40)])[0]}`;
      return d;
    }));
  }

  function open() {
    for (const i of ['#sec-cur', '#sec-new', '#sec-new2', '#sec-code', '#sec-newname', '#sec-name-pw', '#sec-u-name', '#sec-u-pw']) $(i).value = '';
    for (const m of ['#sec-pw-msg', '#sec-2fa-msg', '#sec-name-msg', '#sec-u-msg']) say(m, '');
    setting = false; $('#sec-recovery').hidden = true;
    showTab(tab); $('#sec-back').hidden = false; $('#sec-dlg').show(); $('#sec-dlg').focus({ preventScroll: true }); refresh().catch(e => say('#sec-2fa-msg', e.message, true));
  }

  async function changeName() {
    try { const r = await api('/api/auth/username', { new: $('#sec-newname').value, current: $('#sec-name-pw').value }); $('#sec-newname').value = ''; $('#sec-name-pw').value = ''; say('#sec-name-msg', `Your username is now ${r.username}.`); refresh(); }
    catch (e) { say('#sec-name-msg', e.message, true); }
  }
  async function addUser() {
    try { const r = await api('/api/auth/users', { username: $('#sec-u-name').value, password: $('#sec-u-pw').value }); $('#sec-u-name').value = ''; $('#sec-u-pw').value = ''; say('#sec-u-msg', `Added ${r.username}. They can sign in now, and should set up 2FA in SETTINGS.`); refresh(); }
    catch (e) { say('#sec-u-msg', e.message, true); }
  }
  async function removeUser(name) {
    if (!confirm(`Remove ${name}? They are signed out immediately.`)) return;
    try { await fetch('/api/auth/users?username=' + encodeURIComponent(name), { method: 'DELETE' }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `error ${r.status}`); }); say('#sec-u-msg', `Removed ${name}.`); refresh(); }
    catch (e) { say('#sec-u-msg', e.message, true); }
  }

  async function changePw() {
    const cur = $('#sec-cur').value, n = $('#sec-new').value;
    if (n !== $('#sec-new2').value) return say('#sec-pw-msg', 'The new passwords do not match.', true);
    try { await api('/api/auth/password', { current: cur, new: n }); for (const i of ['#sec-cur', '#sec-new', '#sec-new2']) $(i).value = ''; say('#sec-pw-msg', 'Changed. Other devices were signed out.'); refresh(); }
    catch (e) { say('#sec-pw-msg', e.message, true); }
  }

  async function twoFa() {
    try {
      if (on) { await api('/api/auth/totp/disable', { code: $('#sec-code').value || prompt('Enter a 6-digit code from your authenticator app to turn 2FA off') || '' }); say('#sec-2fa-msg', '2FA is off.'); $('#sec-recovery').hidden = true; }
      else if (!setting) {
        const j = await api('/api/auth/totp/begin', {}); setting = true; $('#sec-secret').textContent = j.secret; $('#sec-open').href = j.uri; $('#sec-code').value = ''; say('#sec-2fa-msg', '');
      } else {
        const j = await api('/api/auth/totp/confirm', { code: $('#sec-code').value });
        setting = false; $('#sec-rc').textContent = j.recovery.join('\n'); $('#sec-recovery').hidden = false; say('#sec-2fa-msg', '2FA is on.');
      }
      await refresh();
    } catch (e) { say('#sec-2fa-msg', e.message, true); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#btn-settings').onclick = open;
    for (const b of document.querySelectorAll('#sec-tabs [data-tab]')) b.onclick = () => showTab(b.dataset.tab);
    $('#sec-tabs').addEventListener('keydown', ev => {
      const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key]; if (!d) return;
      const bs = [...document.querySelectorAll('#sec-tabs [data-tab]')].filter(b => !b.hidden), i = bs.findIndex(b => b.dataset.tab === tab);
      const n = bs[(i + d + bs.length) % bs.length]; showTab(n.dataset.tab); n.focus(); ev.preventDefault();
    });
    if (new URLSearchParams(location.search).has('settings')) { history.replaceState(null, '', '/'); tab = 'security'; setTimeout(open, 600); }   // right after choosing a password: offer 2FA
    $('#side-settings').onclick = () => { document.body.classList.remove('side-open'); open(); };
    const shut = () => { $('#sec-dlg').close(); $('#sec-back').hidden = true; $('#sec-rc').textContent = ''; };
    $('#sec-close').onclick = shut; $('#sec-back').onclick = shut;
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && $('#sec-dlg').open) shut(); });
    $('#sec-nameform').addEventListener('submit', ev => { ev.preventDefault(); changeName(); });
    $('#sec-adduser').addEventListener('submit', ev => { ev.preventDefault(); addUser(); });
    $('#sec-pwform').addEventListener('submit', ev => { ev.preventDefault(); changePw(); });
    $('#sec-2faform').addEventListener('submit', ev => { ev.preventDefault(); twoFa(); });
    $('#sec-copy').onclick = async () => {
      const text = $('#sec-secret').textContent, btn = $('#sec-copy'), was = btn.textContent;
      let done = false;
      try { await navigator.clipboard.writeText(text); done = true; } catch {}
      if (!done) {   // plain http (no clipboard API): copy through a temporary text box
        const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        $('#sec-dlg').appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        try { done = document.execCommand('copy'); } catch {}
        ta.remove();
      }
      if (!done) { const r = document.createRange(); r.selectNodeContents($('#sec-secret')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }   // last resort: leave it selected
      btn.textContent = done ? 'COPIED' : 'SELECTED: PRESS COPY';
      setTimeout(() => { btn.textContent = was; }, 2500);
    };
    $('#sec-others').onclick = async () => { try { await api('/api/auth/logout-others', {}); refresh(); } catch (e) { say('#sec-2fa-msg', e.message, true); } };
    const signOut = async () => { try { await api('/api/auth/logout', {}); } catch {} location.href = '/login'; };
    $('#sec-out').onclick = signOut; $('#btn-logout').onclick = signOut; $('#side-logout').onclick = signOut;
  });
})();
