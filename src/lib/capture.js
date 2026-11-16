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

  // ---- Where on the page is THIS product? (used by the buy-box scan and the DOM price scan) ----
  // A product page shows many products: the cart panel in the header lists the shopper's own cart,
  // ad tiles and rails show neighbours, comparison tables show rivals. On an amazon.it listing with no
  // featured offer, a "brand in this category" ad tile 18px tall beat the product's own 12px variant
  // swatch prices, and 59,99 € went into the watch as the product's price. Font size alone cannot
  // tell them apart; structure and layout can, without any store- or language-specific knowledge.
  //
  // Anchor: the visible <h1> whose words best match the document / og:title — the product's own name.
  // (Amazon also renders an <h1> "Subtotale" inside the header cart panel.) No match → no anchor, and
  // every filter below that needs one stands down, falling back to the page-wide behaviour.
  // KEEP IN SYNC with buildSnapshot / applyRecipe in recipe.js (injected functions can't share code).
  const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const titleWords = new Set([...words(document.title), ...words(document.querySelector('meta[property="og:title"]')?.content)]);
  let anchor = null;
  {
    let best = 0;
    for (const h of document.querySelectorAll('h1')) {
      if (!h.getClientRects().length) continue;
      const w = words(h.innerText);
      const score = w.length ? w.filter((x) => titleWords.has(x)).length / w.length : 0;
      if (score > best) { best = score; anchor = h; }
    }
    if (best < 0.5) anchor = null;
  }
  // Recommendation / sponsored rails, by their class or id. A rail is a region that does NOT contain the
  // product's heading, so with an anchor the walk runs all the way up to the first ancestor shared with
  // it (Amazon nests ad tiles 15+ levels inside #sims-simsContainer…, past the old 14-level cut-off) and
  // a page-level wrapper class above that can never disqualify the product itself.
  const RAIL = /carousel|sponsored|\bsp_|similar|\bsims|related|also[-_ ]?(viewed|bought)|recommend|upsell|cross[-_]?sell|recently[-_ ]?viewed|bought[-_ ]?together|p13n/i;
  const inRail = (el) => {
    for (let p = el, i = 0; p && p !== document.body; p = p.parentElement, i++) {
      if (anchor ? p.contains(anchor) : i >= 14) return false;
      if (RAIL.test(String(p.id || '')) || RAIL.test(String(p.className || ''))) return true;
    }
    return false;
  };
  // Site chrome — header (Amazon's cart flyout: the shopper's own cart items and subtotal), navigation,
  // footer — is never the product. A <header>/<footer> nested in article/main/section is the content's
  // own header, and whatever contains the product heading is content by definition.
  const isChrome = (el) => {
    const c = el.closest('header, footer, nav, [role=banner], [role=navigation], [role=contentinfo]');
    if (!c || (anchor && c.contains(anchor))) return false;
    return !(/^(HEADER|FOOTER)$/.test(c.tagName) && !c.getAttribute('role') && c.parentElement?.closest('article, main, section, aside, [role=main]'));
  };
  // A price inside an UNSELECTED option is a sibling variant's (Amazon's style swatches, a subscription
  // radio). Selection state is standard ARIA / form state, so this needs no store-specific knowledge.
  // The option is the nearest list item / label / ARIA option around the price — Amazon's swatch <li>
  // sits 13 levels above its price text — and never one that holds the product's title (that is the
  // product's container, and an unticked "choose a size" radio inside it says nothing about the price).
  const OPT_STATE = 'input[type=radio], [aria-checked]:not([role=checkbox]):not([role=switch]):not([type=checkbox]), [aria-selected]';
  const isOn = (c) => c.checked === true || c.getAttribute('aria-checked') === 'true' || c.getAttribute('aria-selected') === 'true';
  const unselectedOption = (el) => {
    for (let p = el, i = 0; p && i < 16 && !(anchor && p.contains(anchor)); p = p.parentElement, i++) {
      if (!p.matches('li, label, option, [role=option], [role=radio], [role=tab]')) continue;
      const ctl = p.matches(OPT_STATE) ? [p] : [...p.querySelectorAll(OPT_STATE)];
      if (ctl.length) return !ctl.some(isOn);
    }
    return false;
  };
  // The product's own price and buy button sit within about a screen of its title. Comparison tables,
  // ad tiles and rails whose class names say nothing are further down. Rects are viewport-relative on
  // both sides, so a page the user had scrolled when adding the watch measures the same.
  const aRect = anchor ? anchor.getBoundingClientRect() : null;
  const REACH = Math.max(window.innerHeight || 0, 1200);
  // The product's own block: the smallest ancestor of the title (up to 8 levels, never <body>, at most
  // a few screens tall) that also holds a rendered buy control. A long option picker can push the price
  // and the add-to-cart button well over a screen below the title (eu.magbak.com's phone cases: 1,700px
  // down), and they are still the product's own. Outside that block the distance rule stands.
  let block = null;
  if (anchor) {
    const BUY_CTL = /add to (cart|bag|basket)|buy now|aggiungi al carrello|in den warenkorb|do koszyka|kup teraz|ajouter au panier|añadir a la cesta/i;
    for (let p = anchor.parentElement, i = 0; p && p !== document.body && i < 8 && !block; p = p.parentElement, i++) {
      if (p.getBoundingClientRect().height > 4 * REACH) break;
      for (const b of p.querySelectorAll('button, input[type=submit], [role=button]')) {
        const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
        if (label.length <= 40 && BUY_CTL.test(label) && b.getClientRects().length) { block = p; break; }
      }
    }
  }
  const nearAnchor = (el) => {
    if (!aRect) return true;
    const r = el.getBoundingClientRect();
    if (r.bottom <= aRect.top - REACH / 2) return false;
    return r.top < aRect.bottom + REACH || (!!block && block.contains(el));
  };
  // Everything a price or a buy button must pass to speak for this product. Cheap tests first; the rect
  // tests force layout. getClientRects (not offsetParent) so a position:fixed sticky buy bar counts.
  const aboutProduct = (el) => !isChrome(el) && !inRail(el) && el.getClientRects().length > 0 && nearAnchor(el);

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
        // A control the shopper cannot see says nothing about stock — and a hidden one still answers
        // getAttribute('aria-label'). Amazon ships a permanent, hidden "Dodaj do koszyka" button in
        // its global keyboard-shortcut menu, on every page, sold out or not. Nor does one that belongs
        // to another product: a rail tile's or comparison column's "Aggiungi al carrello" would mark an
        // unavailable listing in stock. Tested after the cheap label filters because it forces layout.
        if (!aboutProduct(el)) continue;
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
  // JSON-LD or the Shopify .js data. Pick the most prominent (largest-font) live amount; on ties the
  // one nearest the product's title, then document order ("cheapest wins" manufactured a price drop
  // whenever the product itself had no price).
  // Only amounts that speak for THIS product compete (aboutProduct, unselectedOption above): never the
  // header cart panel, a rail / ad tile, a hidden element, a sibling variant's swatch, or anything a
  // screen or more away from the title. On an unavailable listing the neighbours' are the ONLY prices
  // on the page, so this correctly finds none. Tagged priceSource:'dom' so the caller treats it as a guess.
  if (!product || product.price == null) {
    const curOf = (s) => /€|\bEUR\b/i.test(s) ? 'EUR' : /\$|\bUSD\b/i.test(s) ? 'USD' : /£|\bGBP\b/i.test(s) ? 'GBP' : /zł|\bPLN\b/i.test(s) ? 'PLN' : /\bCHF\b/i.test(s) ? 'CHF' : null;
    // An amount is matched WHOLE: either separator-grouped thousands, or a plain run of digits, then
    // optional cents (optional so whole-number prices — $29, 199 — are not missed). The previous
    // pattern let the thousands separator itself be optional, which truncated any amount that didn't
    // use one: amazon.pl renders "1945,21zł" and it was read as 194 zł, and "$1,299.00" as 1.29.
    const NUM = /(?:\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:[.,]\d{1,2})?/g;
    const CUR_TOK = /€|\$|£|zł|CHF|EUR|USD|GBP|PLN/gi;
    // A short price label can still hold a second number ("-5% 233,06 zł", "2 x 99,00 zł"); the
    // amount with the most digits is the price, and a stable sort keeps the first one on a tie.
    const amountOf = (s) => (s.match(NUM) || []).sort((a, b) => b.replace(/\D/g, '').length - a.replace(/\D/g, '').length)[0] || null;
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
      const amt = amountOf(own);
      if (!amt) continue;
      const val = pickPrice(amt);
      if (val == null || val <= 0) continue;
      if (!aboutProduct(el) || unselectedOption(el)) continue;
      let fs = 0; try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch { /* noop */ }
      const dist = aRect ? Math.abs(el.getBoundingClientRect().top - aRect.top) : 0;
      cands.push({ val, cur, struck: isStruck(el), fs, dist });
    }
    const live = cands.filter((c) => !c.struck);
    const pick = (live.length ? live : cands).sort((a, b) => (b.fs - a.fs) || (a.dist - b.dist))[0]; // stable: DOM order last
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
