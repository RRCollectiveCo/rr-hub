// R&R Hub sign-in. Load order on every Hub page:
//   supabase-js  ->  hub-config.js  ->  hub-runtime.js  ->  hub-auth.js (data-namespace="pack")
// It sets up `window.claude.use(...)` right away, so the page's own start-up
// code can ask for 'db' / 'user' / ... immediately; those answers simply wait
// until the person has signed in with their work email (a one-time email link).
(function () {
  'use strict';
  const me = document.currentScript;
  const NAMESPACE = (me && me.dataset.namespace) || window.RR_HUB_NAMESPACE;
  const cfg = window.RR_HUB_CONFIG || {};

  let resolveRuntime, rejectRuntime;
  const ready = new Promise((res, rej) => { resolveRuntime = res; rejectRuntime = rej; });
  ready.catch(() => {});
  window.claude = { use: name => ready.then(rt => rt.use(name)) };

  // ------------------------------------------------------------ the sign-in card
  const CSS = `
  .rrh-veil{position:fixed;inset:0;z-index:1000;background:rgba(42,30,25,.55);display:flex;align-items:center;justify-content:center;padding:16px}
  .rrh-card{background:#FFFDFB;color:#64473B;border-radius:16px;max-width:420px;width:100%;padding:26px 24px;box-shadow:0 12px 40px rgba(0,0,0,.25);font:16px/1.5 "Lato","Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;gap:12px}
  .rrh-card h2{font:700 1.5rem "Playfair Display",Georgia,serif;margin:0}
  .rrh-card p{margin:0}
  .rrh-card .soft{color:#9A8378;font-size:.9rem}
  .rrh-card input{font:inherit;padding:12px 14px;border:2px solid #D9B199;border-radius:10px;background:#fff;color:#64473B}
  .rrh-card button{font:inherit;font-weight:700;background:#64473B;color:#F5E4D9;border:0;border-radius:10px;padding:12px;cursor:pointer}
  .rrh-card button:disabled{opacity:.5;cursor:default}
  .rrh-card .bad{color:#A4442F;font-weight:700}
  .rrh-who{position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:900;background:#FFFDFB;color:#9A8378;border:1px solid #F0E6DF;border-radius:999px;padding:4px 6px 4px 12px;font:12px "Lato",Arial,sans-serif;display:flex;gap:8px;align-items:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .rrh-who button{font:inherit;background:none;border:1px solid #E3D3C7;color:#64473B;border-radius:999px;padding:2px 10px;cursor:pointer}`;

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  let veil = null;
  function show(inner) {
    if (!document.getElementById('rrh-css')) { const s = document.createElement('style'); s.id = 'rrh-css'; s.textContent = CSS; document.head.appendChild(s); }
    if (!veil) { veil = el('<div class="rrh-veil" role="dialog" aria-modal="true" aria-labelledby="rrh-title"><div class="rrh-card"></div></div>'); document.body.appendChild(veil); }
    veil.firstChild.innerHTML = inner;
  }
  function hide() { if (veil) { veil.remove(); veil = null; } }

  function askEmail(sb, msg) {
    const last = (() => { try { return localStorage.getItem('rr-hub-email') || ''; } catch (e) { return ''; } })();
    show(`<h2 id="rrh-title">Sign in to the R&amp;R Hub</h2>
      <p>Enter your R&amp;R work email. We’ll send you a sign-in link.</p>
      ${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
      <form class="rrh-form" style="display:flex;flex-direction:column;gap:10px">
        <input type="email" required autocomplete="email" placeholder="you@rr-collective.com" aria-label="Work email" value="${esc(last)}">
        <button type="submit">Email me a sign-in link</button>
      </form>
      <p class="soft">You’ll stay signed in on this device.</p>`);
    const form = veil.querySelector('form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = form.querySelector('input').value.trim().toLowerCase();
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Sending…';
      try { localStorage.setItem('rr-hub-email', email); } catch (err) {}
      const { error } = await sb.auth.signInWithOtp({
        email, options: { emailRedirectTo: location.href.split('#')[0] },
      });
      if (error) { askEmail(sb, 'That didn’t send: ' + error.message); return; }
      askCode(sb, email);
    });
  }

  // The email has a link AND a code. The link only works in the browser that
  // asked for it; a Dock web app or a phone home-screen app keeps its own
  // sign-in, so there the code is typed in instead.
  function askCode(sb, email, msg) {
    show(`<h2 id="rrh-title">Check your email</h2>
      <p>We sent a sign-in email to <strong>${esc(email)}</strong>.</p>
      <p>Click the link in it, <strong>or</strong> type the code from the email here:</p>
      ${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
      <form class="rrh-code" style="display:flex;flex-direction:column;gap:10px">
        <input type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,12}" required
          placeholder="Code from the email" aria-label="Sign-in code" style="font-size:1.4rem;letter-spacing:.2em;text-align:center">
        <button type="submit">Sign in</button>
      </form>
      <p class="soft">Nothing after a few minutes? Check spam, or <a href="#" class="rrh-again">send a new email</a>.</p>`);
    veil.querySelector('.rrh-again').addEventListener('click', ev => { ev.preventDefault(); askEmail(sb); });
    const form = veil.querySelector('form');
    form.querySelector('input').focus();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const token = form.querySelector('input').value.replace(/\D/g, '');
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Signing in…';
      const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error || !data || !data.session) {
        askCode(sb, email, 'That code didn’t work. Check it, or send a new email (codes expire after an hour).');
        return;
      }
      start(sb, data.session);
    });
  }

  function badge(sb, staff) {
    document.querySelectorAll('.rrh-who').forEach(n => n.remove());
    const b = el(`<div class="rrh-who"><span>${esc(staff.name)}</span><button type="button">Sign out</button></div>`);
    b.querySelector('button').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
    document.body.appendChild(b);
  }

  // ------------------------------------------------------------ start
  let started = false;
  async function start(sb, session) {
    if (started || !session) return;
    const email = (session.user && session.user.email || '').toLowerCase();
    const { data, error } = await sb.from('hub_staff').select('email,name,role,active').eq('email', email).maybeSingle();
    if (error || !data || !data.active) {
      await sb.auth.signOut();
      askEmail(sb, error ? 'Couldn’t check the team list. Try again in a minute.'
        : `${email} isn’t on the R&R team list. Ask Hollie to add you.`);
      return;
    }
    started = true;
    hide();
    badge(sb, data);
    // Clean the sign-in code out of the address bar
    if (/[#&?](access_token|code|error)=/.test(location.href)) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]code=[^&]*/, ''));
    resolveRuntime(window.RRHubRuntime.createRuntime(sb, data, {
      namespace: NAMESPACE,
      onError: e => console.error('[R&R Hub]', e),
    }));
  }

  function boot() {
    if (!NAMESPACE) { rejectRuntime(new Error('hub-auth.js needs data-namespace')); return; }
    if (!window.supabase || !window.RRHubRuntime || !cfg.supabaseUrl) {
      show('<h2 id="rrh-title">The Hub couldn’t load</h2><p>Check your internet connection and reload the page.</p>');
      rejectRuntime(new Error('Hub scripts missing'));
      return;
    }
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    });
    sb.auth.onAuthStateChange((event, session) => { if (session) start(sb, session); });
    sb.auth.getSession().then(({ data }) => {
      if (data && data.session) start(sb, data.session);
      else if (!/[?&#](code|access_token)=/.test(location.href)) askEmail(sb);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
