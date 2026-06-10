// Injected via executeScript. Lets the user click a region of the page to watch.
// Returns a Promise that resolves to { selector, areaText } on click, or null on Esc/timeout.
// executeScript awaits the returned Promise, so the SW gets the result when the user clicks.

export function pickArea() {
  return new Promise((resolve) => {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

    function cssPath(el) {
      if (el.id) return '#' + esc(el.id);
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.body && parts.length < 6) {
        if (el.id) { parts.unshift('#' + esc(el.id)); break; }
        let p = el.tagName.toLowerCase();
        const cls = [...el.classList].filter(
          (c) => /^[a-zA-Z][\w-]*$/.test(c) && c.length < 30 && !/[0-9a-f]{6,}/i.test(c)
        ).slice(0, 2);
        if (cls.length) {
          p += '.' + cls.map(esc).join('.');
        } else {
          const sibs = [...(el.parentNode?.children || [])].filter((s) => s.tagName === el.tagName);
          if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(el) + 1})`;
        }
        parts.unshift(p);
        el = el.parentElement;
      }
      return parts.join(' > ');
    }

    const Z = '2147483647';
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;z-index:${Z};border:2px solid #1f6feb;background:rgba(31,111,235,.12);pointer-events:none;border-radius:3px;left:0;top:0;width:0;height:0`;
    const bar = document.createElement('div');
    bar.textContent = 'BuyTracker — click the price/offer area to watch · Esc to cancel';
    bar.style.cssText = `position:fixed;z-index:${Z};left:0;right:0;top:0;background:#1f6feb;color:#fff;font:13px system-ui,sans-serif;padding:7px 12px;text-align:center;pointer-events:none`;
    document.body.append(box, bar);

    let cur = null;
    const to = setTimeout(() => finish(null), 60000);

    function move(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === cur) return;
      cur = el;
      const r = el.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    }
    function click(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
      const selector = cssPath(el);
      const areaText = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
      finish({ selector, areaText });
    }
    function key(e) { if (e.key === 'Escape') finish(null); }
    function finish(val) {
      clearTimeout(to);
      box.remove(); bar.remove();
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('keydown', key, true);
      resolve(val);
    }

    window.addEventListener('mousemove', move, true);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', key, true);
  });
}
