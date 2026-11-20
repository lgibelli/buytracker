// Registered by background.js as a content script on Google's results pages while a "Find in other
// stores" tab is open. It does nothing until the service worker says this tab was opened for a watch;
// then it puts a "+ BuyTracker" button under each result, which adds that page to the watch's product
// group (background.js addFromSearch). A classic script: content scripts can't be modules.
(() => {
  if (globalThis.__buytrackerSearch) return;
  globalThis.__buytrackerSearch = true;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const MARK = 'data-buytracker';
  const seen = new WeakSet();
  const unplaced = new Map(); // link → its button, for results not laid out yet (hidden)
  let observer = null, timer = null, stopped = false;

  send({ type: 'searchTab' }).then((info) => { if (info?.ok) start(info); }, () => {});

  function start(info) {
    pill(info.name);
    decorate();
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(decorate, 250); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    observer?.disconnect();
    for (const el of document.querySelectorAll(`[${MARK}]`)) el.remove();
    send({ type: 'searchStop' }).catch(() => {});
  }

  // Google's own pages and ad links are never a store's result, and following an ad link counts as a
  // click on the ad, so they get no button. A /url?q= redirect is unwrapped to the page it leads to.
  const GOOGLE = /(^|\.)(google\.[a-z.]+|googleadservices\.com|doubleclick\.net|googlesyndication\.com)$/i;
  function pageOf(a) {
    let u;
    try { u = new URL(a.href); } catch { return null; }
    if (GOOGLE.test(u.hostname) && u.pathname === '/url') {
      try { u = new URL(u.searchParams.get('q') || u.searchParams.get('url') || ''); } catch { return null; }
    }
    return /^https?:$/.test(u.protocol) && !GOOGLE.test(u.hostname) ? u.href : null;
  }

  // A result is a link around a heading: Google's markup has kept that shape for years, while its class
  // names change all the time. Sponsored results sit in their own containers.
  function decorate() {
    const root = document.getElementById('rso') || document.getElementById('search');
    if (!root || stopped) return;
    for (const [a, host] of unplaced) if (!a.isConnected || place(a, host)) unplaced.delete(a);
    for (const h of root.querySelectorAll('a h3')) {
      const a = h.closest('a');
      if (!a || seen.has(a)) continue;
      seen.add(a);
      if (a.closest('#tads, #tadsb, #bottomads')) continue;
      const url = pageOf(a);
      if (!url) continue;
      const host = button(url);
      if (!place(a, host)) unplaced.set(a, host);
    }
  }

  // Google lays some results out with CSS transforms: a container flipped upside down whose own
  // elements are flipped back, so the site's name shows above a title that comes first in the page.
  // A button added there would show upside down, above the result. It is flipped back as Google's own
  // elements are, and goes on the link's other side if it still shows above the title. False while
  // the result isn't laid out (hidden): it is placed again at the next pass.
  function place(a, host) {
    if (!host.isConnected) a.after(host);
    upright(host);
    const title = a.getBoundingClientRect();
    if (!title.height) return false;
    if (host.getBoundingClientRect().top < title.top - 1) { a.before(host); upright(host); }
    return true;
  }

  function upright(host) {
    let sx = 1, sy = 1;
    for (let e = host.parentElement; e; e = e.parentElement) {
      const m = /matrix(3d)?\(([^)]*)\)/.exec(getComputedStyle(e).transform);
      if (!m) continue;
      const v = m[2].split(',').map(Number);
      if (v[0] < 0) sx = -sx;
      if (v[m[1] ? 5 : 3] < 0) sy = -sy;
    }
    host.style.transform = sx < 0 || sy < 0 ? `scale(${sx}, ${sy})` : '';
  }

  const css = (rules) => { const s = document.createElement('style'); s.textContent = rules; return s; };
  const FONT = '500 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function button(url) {
    const host = document.createElement('div');
    host.setAttribute(MARK, '');
    host.style.cssText = 'margin: 6px 0 4px; width: fit-content;';
    const root = host.attachShadow({ mode: 'closed' });
    root.append(css(`
      button { font: ${FONT}; color: inherit; background: transparent; border: 1px solid rgba(128,128,128,.55);
        border-radius: 999px; padding: 3px 11px; cursor: pointer; }
      button:hover:not(:disabled), button.warn:hover, button.err:hover { border-color: #4493f8; color: #4493f8; }
      button:disabled { cursor: default; }
      .busy { opacity: .7; } .ok { border-color: #2da44e; color: #2da44e; }
      .warn { border-color: #d4a72c; color: #c4971c; } .err { border-color: #e5534b; color: #e5534b; }`));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '+ BuyTracker';
    btn.title = 'Watch this store’s price too, grouped with the product you searched for';
    root.append(btn);
    const show = (text, cls = '', disabled = false) => { btn.textContent = text; btn.className = cls; btn.disabled = disabled; };
    let force = false;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      show('Adding…', 'busy', true);
      try {
        const r = await send({ type: 'searchAdd', url, force });
        if (!r?.ok) throw new Error(r?.error || 'something went wrong');
        if (r.status === 'noproduct') { force = true; show('No price found here · Add anyway', 'warn'); return; }
        show(label(r), r.status === 'self' ? '' : 'ok', true);
      } catch (err) {
        show(`Couldn’t add: ${err.message || err} · Retry`, 'err');
      }
    });
    return host;
  }

  const amount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  function label(r) {
    if (r.status === 'self') return 'This is the page you watch';
    const what = r.stock === 'out' ? 'out of stock' : r.price != null ? `${amount(r.price)}${r.currency ? ' ' + r.currency : ''}` : '';
    return (r.status === 'exists' ? '✓ Already in this group' : '✓ Added') + (what ? ' · ' + what : '');
  }

  // Says what the buttons are for, and stops them.
  function pill(name) {
    const host = document.createElement('div');
    host.setAttribute(MARK, '');
    host.style.cssText = 'position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.append(css(`
      .pill { display: flex; align-items: flex-start; gap: 8px; max-width: 340px; padding: 10px 8px 10px 13px;
        border-radius: 12px; background: #11151a; color: #c9d3dc; border: 1px solid #2a3340;
        box-shadow: 0 6px 24px rgba(0,0,0,.28); font: ${FONT}; font-weight: 400; }
      b { color: #e6edf3; font-weight: 600; }
      .name { display: block; margin-top: 2px; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      button { flex: none; background: none; border: 0; color: #8b97a4; font: 18px/1 sans-serif; cursor: pointer; padding: 0 4px; }
      button:hover { color: #fff; }`));
    const box = document.createElement('div');
    box.className = 'pill';
    const text = document.createElement('div');
    text.style.minWidth = '0';
    text.innerHTML = '<b>BuyTracker</b>: press <b>+ BuyTracker</b> on a store to compare its price with';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    text.append(n);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Stop adding from this search';
    x.setAttribute('aria-label', x.title);
    x.addEventListener('click', stop);
    box.append(text, x);
    root.append(box);
    document.documentElement.append(host);
  }
})();
