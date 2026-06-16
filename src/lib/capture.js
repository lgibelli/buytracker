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

  // Pin down the variant the user is viewing from the URL, so a multi-variant page reports the
  // chosen variant — not whichever offer is first in the JSON-LD (the cause of "shows in stock
  // when the selected variant is sold out").
  const url = location.href;
  const variantKeys = new Set();
  try { const u = new URL(url); for (const k of ['variant', 'variant_id', 'variantId', 'sku', 'pid']) { const v = u.searchParams.get(k); if (v) variantKeys.add(v); } } catch { /* noop */ }
  const flattenOffers = (o) => {
    if (!o) return [];
    const arr = Array.isArray(o) ? o : [o];
    const out = [];
    for (const x of arr) { if (x && Array.isArray(x.offers)) out.push(...x.offers); else if (x) out.push(x); } // unwrap AggregateOffer
    return out;
  };
  const refMatches = (ref) => {
    if (!ref) return false;
    try { const ru = new URL(ref, url); const rv = ru.searchParams.get('variant') || ru.searchParams.get('variant_id'); if (rv && variantKeys.has(rv)) return true; } catch { /* noop */ }
    for (const k of variantKeys) if (String(ref).includes(k)) return true;
    return false;
  };

  // Collect every offer as its own candidate — variants may be one Product's `offers` array or,
  // as on Shopify, split across many Product blocks. We then pick the candidate matching the URL.
  const cands = [];
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    let blocks;
    try { blocks = JSON.parse(el.textContent); } catch { continue; }
    const stack = Array.isArray(blocks) ? [...blocks] : [blocks];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { stack.push(...n); continue; }
      const offers = flattenOffers(n.offers);
      for (const off of (offers.length ? offers : [null])) {
        const price = pickPrice(off?.price ?? off?.lowPrice ?? n.price ?? n.lowPrice);
        const availability = String(off?.availability ?? n.availability ?? '').replace(/^https?:\/\/schema\.org\//i, '') || null;
        if (price == null && !availability) continue;
        cands.push({
          name: n.name || null,
          price: price ?? null,
          currency: (off?.priceCurrency ?? n.priceCurrency ?? '').toString().toUpperCase() || null,
          availability,
          ref: off?.url || off?.['@id'] || n.url || n['@id'] || null,
          sku: off?.sku ?? n.sku ?? null
        });
      }
      for (const k in n) stack.push(n[k]);
    }
  }

  let product = null;
  if (cands.length) {
    const strip = (c) => ({ name: c.name, price: c.price, currency: c.currency, availability: c.availability });
    let chosen = variantKeys.size
      ? cands.find((c) => (c.sku != null && variantKeys.has(String(c.sku))) || refMatches(c.ref))
      : null;
    if (!chosen) {
      const priced = cands.filter((c) => c.price != null);
      const pool = priced.length ? priced : cands;
      pool.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0));
      chosen = pool[0];
    }
    product = strip(chosen);
    if (!product.availability) { const a = cands.find((c) => c.availability); if (a) product.availability = a.availability; }
  }

  const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);

  // The rendered buy-box reflects the SELECTED variant on any storefront — the most reliable,
  // vendor-agnostic availability signal. Scope to the add-to-cart form so recommended-product
  // buttons elsewhere on the page don't pollute it. A confident "sold out" here overrides an
  // aggregate JSON-LD "in stock" (which describes the product, not the chosen variant).
  const OOS_RE = /sold\s?out|out of stock|notify me|email when available|currently unavailable|temporarily unavailable|esaurito|non disponibile|avvisami|ausverkauft|nicht verfügbar|benachrichtigen|wyprzedane|brak w magazynie|powiadom|rupture de stock|épuisé|indisponible/i;
  const BUY_RE = /add to (cart|bag|basket)|buy now|aggiungi al carrello|in den warenkorb|dodaj do koszyka|ajouter au panier/i;
  let buyBox = null;
  {
    const form = document.querySelector('form[action*="cart/add"], form[action*="/cart"]');
    const scope = form || document.body;
    let buy = false, buyEnabled = false, oos = false;
    if (scope) {
      for (const el of scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')) {
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length > 40) continue;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        if (OOS_RE.test(label)) oos = true;
        if (BUY_RE.test(label)) { buy = true; if (!disabled) buyEnabled = true; }
      }
    }
    if (oos || (buy && !buyEnabled)) buyBox = 'OutOfStock';
    else if (buyEnabled) buyBox = 'InStock';
  }

  // Whole-page text hint only as a last resort, when there's no recognizable buy-box at all.
  if (!buyBox) {
    const lc = pageText.toLowerCase();
    if (/\bsold out\b|out of stock|notify me when|email when available|currently unavailable|temporarily unavailable/.test(lc)) buyBox = 'OutOfStock';
    else if (/add to cart|add to bag|add to basket|buy now|in stock/.test(lc)) buyBox = 'InStock';
  }

  if (buyBox === 'OutOfStock') {
    if (product) product.availability = 'OutOfStock';
    else product = { name: document.title || null, price: null, currency: null, availability: 'OutOfStock' };
  } else if (buyBox === 'InStock') {
    if (product && !product.availability) product.availability = 'InStock';
    else if (!product) product = { name: document.title || null, price: null, currency: null, availability: 'InStock' };
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
