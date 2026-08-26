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
    if (product.price != null) product.priceSource = 'jsonld';
    if (!product.availability) { const a = cands.find((c) => c.availability); if (a) product.availability = a.availability; }
  }

  const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);

  // The rendered buy-box is a vendor-agnostic availability hint. Scope to the add-to-cart form so
  // recommended-product buttons elsewhere on the page don't pollute it. It's a FALLBACK only: it
  // fills availability when the structured JSON-LD carried none, and must NOT override an explicit
  // schema.org value (multilingual keyword matching can't reliably beat one — that's how a live
  // `OnlineOnly` got flipped to "out of stock"). Genuinely-wrong structured data is corrected by a
  // learned per-site recipe (applied later) or the user's "report wrong", not by this heuristic.
  const OOS_RE = /sold\s?out|out of stock|notify me|email when available|currently unavailable|temporarily unavailable|esaurito|non disponibile|avvisami|ausverkauft|nicht verfügbar|benachrichtigen|wyprzedane|brak w magazynie|niedostępn|powiadom|rupture de stock|épuisé|indisponible|agotado|no disponible/i;
  const BUY_RE = /add to (cart|bag|basket)|buy now|aggiungi al carrello|in den warenkorb|do koszyka|kup teraz|ajouter au panier|añadir a la cesta/i;
  let buyBox = null;
  {
    const form = document.querySelector('form[action*="cart/add"], form[action*="/cart"]');
    const scope = form || document.body;
    let buy = false, buyEnabled = false, oos = false;
    if (scope) {
      let seen = 0;
      for (const el of scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')) {
        if (++seen > 1000) break; // some pages tag thousands of divs role=button — the buy box isn't there
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length > 40) continue;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        if (OOS_RE.test(label)) { oos = true; break; } // OOS decides the verdict below regardless of later finds
        if (BUY_RE.test(label)) { buy = true; if (!disabled) buyEnabled = true; }
      }
    }
    if (oos || (buy && !buyEnabled)) buyBox = 'OutOfStock';
    else if (buyEnabled) buyBox = 'InStock';
  }

  // Whole-page text hint only as a last resort, when there's no recognizable buy-box at all. Amazon
  // renders "unavailable" as plain text with NO button at all (so the scan above finds nothing), in
  // the store's own language — an English-only list left amazon.pl's "Chwilowo niedostępne." as
  // availability=null, which let a carousel price pass for the product's and fire a "price drop".
  // Multi-word phrases only: this runs over the whole page, where a bare "niedostępne"/"unavailable"
  // shows up in unrelated copy (footer, feature blurbs).
  if (!buyBox) {
    const lc = pageText.toLowerCase();
    const OOS_TEXT = /\bsold out\b|out of stock|notify me when|email when available|currently unavailable|temporarily unavailable|chwilowo niedostępn|obecnie niedostępn|produkt niedostępn|derzeit nicht verfügbar|zurzeit nicht verfügbar|actuellement indisponible|attualmente non disponibile|momentaneamente non disponibile|temporalmente sin stock|no disponible temporalmente/;
    const BUY_TEXT = /add to cart|add to bag|add to basket|buy now|in stock|dodaj do koszyka|in den warenkorb|ajouter au panier|aggiungi al carrello|añadir a la cesta/;
    if (OOS_TEXT.test(lc)) buyBox = 'OutOfStock';
    else if (BUY_TEXT.test(lc)) buyBox = 'InStock';
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
  // JSON-LD or the Shopify .js data. Pick the most prominent (largest-font) live amount; first in
  // document order on ties (the main offer precedes the recommendation rails, and "cheapest wins"
  // manufactured a price drop whenever the product itself had no price).
  // Amounts inside recommendation / sponsored / "also viewed" rails are never the main product's —
  // on an unavailable listing they are the ONLY prices on the page, and one of them was reported as
  // the product's own. The result is tagged priceSource:'dom' so the caller treats it as a guess.
  if (!product || product.price == null) {
    const RAIL = /carousel|sponsored|\bsp_|similar|related|also[-_ ]?(viewed|bought)|recommend|upsell|cross[-_]?sell|recently[-_ ]?viewed|bought[-_ ]?together/i;
    const inRail = (el) => {
      for (let p = el, i = 0; p && i < 14; p = p.parentElement, i++) {
        if (RAIL.test(String(p.id || '')) || RAIL.test(String(p.className || ''))) return true;
      }
      return false;
    };
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
    // Subtree text like textContent — split currency/amount spans still read as one price — but
    // bails after 300 raw chars, which could never collapse to a ≤24-char price label. Reading
    // el.textContent on EVERY element serializes each wrapper's whole subtree (O(page text × depth)):
    // seconds of pegged CPU on big store pages, all spent discovering the text is too long to use.
    const shortText = (el) => {
      let s = '';
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) {
        s += t.nodeValue;
        if (s.length > 300) return null;
      }
      return s.replace(/\s+/g, ' ').trim();
    };
    const cands = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el, visited = 0;
    while ((el = tw.nextNode())) {
      // Hard ceilings so a pathological DOM bounds the scan; the main price sits well inside both.
      if (++visited > 30000 || cands.length >= 60) break;
      const own = shortText(el);
      if (!own || own.length > 24) continue;     // a bare price label, not a sentence that mentions a number
      const cur = curOf(own);
      if (!cur) continue;
      // Exactly one currency token — skip composite wrappers holding both current + struck price together.
      if ((own.match(CUR_TOK) || []).length !== 1) continue;
      const m = NUM.exec(own);
      if (!m) continue;
      const val = pickPrice(m[1]);
      if (val == null || val <= 0) continue;
      if (inRail(el)) continue;
      let fs = 0; try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch { /* noop */ }
      cands.push({ val, cur, struck: isStruck(el), fs });
    }
    const live = cands.filter((c) => !c.struck);
    const pick = (live.length ? live : cands).sort((a, b) => b.fs - a.fs)[0]; // stable sort: DOM order on ties
    if (pick) {
      if (!product) product = { name: document.title || null, price: null, currency: null, availability: null };
      product.price = pick.val;
      product.priceSource = 'dom';
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
