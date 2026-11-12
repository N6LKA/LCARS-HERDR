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
  let on = false, setting = false;

  async function refresh() {
    const s = await api('/api/auth/status');
    on = s.totp;
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
    for (const i of ['#sec-cur', '#sec-new', '#sec-new2', '#sec-code']) $(i).value = '';
    for (const m of ['#sec-pw-msg', '#sec-2fa-msg']) say(m, '');
    setting = false; $('#sec-recovery').hidden = true;
    $('#sec-back').hidden = false; $('#sec-dlg').show(); $('#sec-cur').focus(); refresh().catch(e => say('#sec-2fa-msg', e.message, true));
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
    if (new URLSearchParams(location.search).has('settings')) { history.replaceState(null, '', '/'); setTimeout(open, 600); }   // right after choosing a password: offer 2FA
    $('#side-settings').onclick = () => { document.body.classList.remove('side-open'); open(); };
    const shut = () => { $('#sec-dlg').close(); $('#sec-back').hidden = true; $('#sec-rc').textContent = ''; };
    $('#sec-close').onclick = shut; $('#sec-back').onclick = shut;
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && $('#sec-dlg').open) shut(); });
    $('#sec-pwform').addEventListener('submit', ev => { ev.preventDefault(); changePw(); });
    $('#sec-2faform').addEventListener('submit', ev => { ev.preventDefault(); twoFa(); });
    $('#sec-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#sec-secret').textContent); say('#sec-2fa-msg', 'Copied.'); } catch { say('#sec-2fa-msg', 'Copy needs https. Select the key and copy it by hand.', true); } };
    $('#sec-others').onclick = async () => { try { await api('/api/auth/logout-others', {}); refresh(); } catch (e) { say('#sec-2fa-msg', e.message, true); } };
    $('#sec-out').onclick = async () => { try { await api('/api/auth/logout', {}); } catch {} location.href = '/login'; };
  });
})();
