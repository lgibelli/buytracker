// Injected into a tab via chrome.scripting.executeScript — at "watch this page" time and on
// every tab-mode re-check. Runs in the page's rendered DOM with the user's logged-in session,
// so it sees the real, region-correct, member price and JS-hydrated content. Self-contained.

export function capturePage(selector) {
  const pickPrice = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/[^\d.,]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.includes(',')) {
      s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    }
    const n = Number(s);
    return isFinite(n) ? n : null;
  };

  let product = null;
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    let blocks;
    try { blocks = JSON.parse(el.textContent); } catch { continue; }
    const stack = Array.isArray(blocks) ? [...blocks] : [blocks];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { stack.push(...n); continue; }
      const off = Array.isArray(n.offers) ? n.offers[0] : n.offers;
      const price = pickPrice(n.price ?? off?.price ?? off?.lowPrice ?? n.lowPrice);
      const availability = String(n.availability ?? off?.availability ?? '').replace(/^https?:\/\/schema\.org\//i, '') || null;
      if ((price != null || availability) && !product) {
        product = {
          name: n.name || null,
          price: price ?? null,
          currency: (n.priceCurrency ?? off?.priceCurrency ?? '').toString().toUpperCase() || null,
          availability
        };
      }
      for (const k in n) stack.push(n[k]);
    }
  }

  const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);

  // DOM fallback for availability when structured data doesn't carry it.
  const lc = pageText.toLowerCase();
  let hint = null;
  if (/\bsold out\b|out of stock|notify me when|email when available|currently unavailable|temporarily unavailable/.test(lc)) hint = 'OutOfStock';
  else if (/add to cart|add to bag|add to basket|buy now|in stock/.test(lc)) hint = 'InStock';
  if (hint) {
    if (product && !product.availability) product.availability = hint;
    else if (!product) product = { name: document.title || null, price: null, currency: null, availability: hint };
  }

  let areaText = null;
  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) areaText = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch { /* bad/stale selector */ }
  }

  return {
    url: location.href,
    title: (product && product.name) || document.title || location.href,
    product,
    pageText,
    areaText,
    selector: selector || null
  };
}
