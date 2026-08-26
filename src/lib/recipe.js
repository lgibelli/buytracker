// Per-site parse recipes. The deterministic extractors (JSON-LD, Shopify .js, rendered-DOM
// price/buy-box in capture.js) handle most stores. For the long tail that they get wrong or can't
// read, the worker (../../worker) derives a reusable recipe ONCE per host from a reduced snapshot;
// we cache it locally and run it deterministically — in the page's MAIN world — on every check.
//
// buildSnapshot() and applyRecipe() are INJECTED via chrome.scripting.executeScript({world:'MAIN'}),
// so they must be fully self-contained: no imports, no references to module scope. MAIN world (not
// the default isolated world) is required so they can read page globals like window.dataLayer.

// ---- injected: reduce a rendered page to a small snapshot for the LLM ----
export function buildSnapshot(selector) {
  const NUM = /(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2})?)/; // cents optional → whole-number prices too
  const CUR_TOK = /€|\$|£|zł|CHF|EUR|USD|GBP|PLN/gi;
  const curOf = (s) => /€|\bEUR\b/i.test(s) ? 'EUR' : /\$|\bUSD\b/i.test(s) ? 'USD' : /£|\bGBP\b/i.test(s) ? 'GBP' : /zł|\bPLN\b/i.test(s) ? 'PLN' : /\bCHF\b/i.test(s) ? 'CHF' : null;
  const STRUCK = /\b(old|was|strike|compare|regular|original|listino|previous|vecchio|barrat|precedente)\b/i;
  const isStruck = (el) => {
    for (let p = el, i = 0; p && i < 4; p = p.parentElement, i++) {
      if (p.tagName === 'DEL' || p.tagName === 'S' || p.tagName === 'STRIKE') return true;
      if (STRUCK.test(String(p.className || ''))) return true;
      try { if (getComputedStyle(p).textDecorationLine.includes('line-through')) return true; } catch { /* noop */ }
    }
    return false;
  };
  // A stable-ish CSS selector for an element: prefer #id, else a tag[:nth-of-type] chain (≤6 deep).
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node.tagName !== 'HTML' && parts.length < 6; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
    }
    return parts.join(' > ');
  };

  // Subtree text like textContent — split currency/amount spans still read as one price — but bails
  // after 300 raw chars (never a ≤24-char price label). el.textContent on every element serializes
  // each wrapper's whole subtree: seconds of pegged CPU on big pages, wasted on oversized text.
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

  // Currency-tagged short texts → price candidates (with a class hint, so the model can pick a
  // class-based selector that generalises across the site's products rather than a brittle nth path).
  const priceCandidates = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el, visited = 0;
  while ((el = tw.nextNode())) {
    if (priceCandidates.length >= 25 || ++visited > 30000) break;
    // One currency token only, to skip composite wrappers that hold both the current and struck price.
    const own = shortText(el);
    if (!own || own.length > 24) continue;
    if (!curOf(own) || !NUM.test(own) || (own.match(CUR_TOK) || []).length !== 1) continue;
    let fs = 0; try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch { /* noop */ }
    priceCandidates.push({ selector: cssPath(el), cls: String(el.className || '').slice(0, 60) || null, text: own, fontSize: fs, struck: isStruck(el) });
  }

  // Buy / out-of-stock looking controls.
  const OOS = /sold\s?out|out of stock|notify me|currently unavailable|temporarily unavailable|esaurito|non disponibile|avvisami|ausverkauft|nicht verfügbar|wyprzedane|brak w magazynie|niedostępn|rupture de stock|épuisé|indisponible|agotado|no disponible/i;
  const BUY = /add to (cart|bag|basket)|buy now|aggiungi al carrello|in den warenkorb|do koszyka|kup teraz|ajouter au panier|añadir a la cesta/i;
  const buttons = [];
  let seenBtns = 0;
  for (const b of document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a.button, a.btn')) {
    if (buttons.length >= 20 || ++seenBtns > 1000) break;
    const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) continue;
    if (!OOS.test(label) && !BUY.test(label)) continue;
    buttons.push({ selector: cssPath(b), cls: String(b.className || '').slice(0, 60) || null, text: label, disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true') });
  }

  // The snapshot leaves the page (→ the user's worker → Claude), so strip likely PII first: drop
  // object keys that name personal/cart/customer data and redact emails/phones in free text.
  const redactText = (s) => String(s || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\+?\d[\d\s().-]{8,}\d\b/g, '[phone]');
  const sanitize = (v, depth = 0) => {
    if (v == null || depth > 5) return null;
    if (typeof v === 'string') return redactText(v).slice(0, 300);
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 25).map((x) => sanitize(x, depth + 1));
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (/email|phone|tel|token|secret|password|passwd|addr|customer|user|account|session|auth/i.test(k)) continue;
      out[k] = sanitize(val, depth + 1);
    }
    return out;
  };

  // Whitelisted e-commerce globals (GTM dataLayer & friends), sanitised + JSON-trimmed.
  const globals = {};
  for (const k of ['dataLayer', 'ecomm_items', 'ecommerceData', 'gtag', 'productData', 'product', '__NEXT_DATA__']) {
    try {
      const v = window[k];
      if (v == null || typeof v === 'function') continue;
      globals[k] = sanitize(JSON.parse(JSON.stringify(v)));
    } catch { /* circular / not serialisable */ }
  }
  const globalsStr = JSON.stringify(globals).slice(0, 6000);

  const areaText = selector ? (() => { try { const e = document.querySelector(selector); return e ? redactText((e.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 2000) : null; } catch { return null; } })() : null;

  return {
    url: location.href,
    host: location.hostname,
    title: document.title || null,
    priceCandidates,
    buttons,
    globals: globalsStr,
    areaText,
    textSkeleton: redactText((document.body?.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 1500)
  };
}

// ---- injected: run a cached recipe against the rendered page (MAIN world) ----
// Returns { price, currency, availability } — any field null if the recipe didn't resolve it.
export function applyRecipe(recipe) {
  const out = { price: null, currency: null, availability: null };
  if (!recipe || typeof recipe !== 'object') return out;

  const pickPrice = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/[^\d.,]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // dot-only thousands: "1.299" → 1299
    const n = Number(s);
    return isFinite(n) ? n : null;
  };
  const text = (sel, attr) => { try { const e = document.querySelector(sel); if (!e) return null; return (attr ? e.getAttribute(attr) : e.textContent || '').trim(); } catch { return null; } };
  const exists = (sel) => { try { return !!sel && !!document.querySelector(sel); } catch { return false; } };
  const readGlobal = (path) => {
    try {
      let cur = window;
      for (const seg of String(path).split('.')) { if (cur == null) return null; cur = cur[seg]; }
      return cur;
    } catch { return null; }
  };

  // price
  if (recipe.price_global) out.price = pickPrice(readGlobal(recipe.price_global));
  if (out.price == null && recipe.price_selector) out.price = pickPrice(text(recipe.price_selector, recipe.price_attr));

  // currency
  if (recipe.currency_code) out.currency = String(recipe.currency_code).toUpperCase().slice(0, 3);
  if (!out.currency && recipe.currency_selector) {
    const t = text(recipe.currency_selector);
    if (t) out.currency = /€|\bEUR\b/i.test(t) ? 'EUR' : /\$|\bUSD\b/i.test(t) ? 'USD' : /£|\bGBP\b/i.test(t) ? 'GBP' : /zł|\bPLN\b/i.test(t) ? 'PLN' : /\bCHF\b/i.test(t) ? 'CHF' : null;
  }

  // availability — out-of-stock signals take priority over in-stock ones.
  if (recipe.out_of_stock_selector && exists(recipe.out_of_stock_selector)) out.availability = 'OutOfStock';
  else if (recipe.out_of_stock_text) {
    const body = (document.body?.innerText || '').toLowerCase();
    if (body.includes(String(recipe.out_of_stock_text).toLowerCase())) out.availability = 'OutOfStock';
  }
  if (out.availability == null && recipe.in_stock_selector && exists(recipe.in_stock_selector)) out.availability = 'InStock';

  return out;
}

// ---- service-worker side: local recipe cache (keyed by normalised host) ----
export function recipeHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// One storage key per host — never a shared map — so concurrent checks of different watches can't
// clobber each other's recipe via read-modify-write of a single object.
const recipeKey = (host) => 'recipe:' + host;

export async function getRecipe(url) {
  const host = recipeHost(url);
  if (!host) return null;
  const key = recipeKey(host);
  const got = await chrome.storage.local.get(key);
  return got[key] || null;
}

export async function putRecipe(url, recipe) {
  const host = recipeHost(url);
  if (!host || !recipe) return;
  await chrome.storage.local.set({ [recipeKey(host)]: { ...recipe, host, cachedAt: Date.now() } });
}

// ---- service-worker side: ask the worker to derive (or return the cached) recipe ----
// On failure throws an Error carrying .status (HTTP) and, for 429 (daily budget exhausted),
// .retryAfterSec — background.js uses these to park derivation until the quota resets.
export async function deriveRecipe({ workerUrl, token, url, snapshot, force, feedback }) {
  if (!workerUrl || !token) return null;
  const endpoint = workerUrl.replace(/\/+$/, '') + '/recipe';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000); // the worker aborts its Anthropic call at 25s
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ host: recipeHost(url), url, snapshot, force: !!force, feedback: feedback || null }),
      signal: ctrl.signal
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'recipe worker HTTP ' + res.status);
    err.status = res.status;
    err.retryAfterSec = Number(res.headers.get('retry-after')) || Number(body.retry_after) || 0;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  return data.recipe || null;
}
