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
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, ''); // dot-only thousands: "1.299" → 1299
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

  // The rendered buy-box is a vendor-agnostic availability hint. Scope to the add-to-cart form so
  // recommended-product buttons elsewhere on the page don't pollute it. It's a FALLBACK only: it
  // fills availability when the structured JSON-LD carried none, and must NOT override an explicit
  // schema.org value (multilingual keyword matching can't reliably beat one — that's how a live
  // `OnlineOnly` got flipped to "out of stock"). Genuinely-wrong structured data is corrected by a
  // learned per-site recipe (applied later) or the user's "report wrong", not by this heuristic.
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

  if (!product) {
    if (buyBox) product = { name: document.title || null, price: null, currency: null, availability: buyBox };
  } else if (!product.availability && buyBox) {
    product.availability = buyBox; // fill only — never override a structured schema.org enum
  }

  // Price fallback for stores that render the price client-side with NO JSON-LD (the offer lives only
  // in DOM text — e.g. LordGun). The SELLING price is a currency-tagged amount that is NOT struck
  // through; list/old prices carry a <del>/<s>/<strike>, a line-through style, or an *-old/was/
  // compare/listino class. Runs only when the structured path found no price, so it never overrides
  // JSON-LD or the Shopify .js data. Pick the most prominent (largest-font) live amount; cheapest ties.
  if (!product || product.price == null) {
    const curOf = (s) => /€|\bEUR\b/i.test(s) ? 'EUR' : /\$|\bUSD\b/i.test(s) ? 'USD' : /£|\bGBP\b/i.test(s) ? 'GBP' : /zł|\bPLN\b/i.test(s) ? 'PLN' : /\bCHF\b/i.test(s) ? 'CHF' : null;
    // Cents optional so whole-number prices ($29, 199, 1,299) are not missed.
    const NUM = /(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2})?)/;
    const CUR_TOK = /€|\$|£|zł|CHF|EUR|USD|GBP|PLN/gi;
    const STRUCK = /\b(old|was|strike|compare|regular|original|listino|previous|vecchio|barrat|precedente)\b/i;
    const isStruck = (el) => {
      for (let p = el, i = 0; p && i < 4; p = p.parentElement, i++) {
        if (p.tagName === 'DEL' || p.tagName === 'S' || p.tagName === 'STRIKE') return true;
        if (STRUCK.test(String(p.className || ''))) return true;
        try { if (getComputedStyle(p).textDecorationLine.includes('line-through')) return true; } catch { /* noop */ }
      }
      return false;
    };
    const cands = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = tw.nextNode())) {
      // textContent (not just direct text nodes) so split currency/amount spans read as one price.
      const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!own || own.length > 24) continue;     // a bare price label, not a sentence that mentions a number
      const cur = curOf(own);
      if (!cur) continue;
      // Exactly one currency token — skip composite wrappers holding both current + struck price together.
      if ((own.match(CUR_TOK) || []).length !== 1) continue;
      const m = NUM.exec(own);
      if (!m) continue;
      const val = pickPrice(m[1]);
      if (val == null || val <= 0) continue;
      let fs = 0; try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch { /* noop */ }
      cands.push({ val, cur, struck: isStruck(el), fs });
    }
    const live = cands.filter((c) => !c.struck);
    const pick = (live.length ? live : cands).sort((a, b) => b.fs - a.fs || a.val - b.val)[0];
    if (pick) {
      if (!product) product = { name: document.title || null, price: null, currency: null, availability: null };
      product.price = pick.val;
      if (!product.currency) product.currency = pick.cur;
    }
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
