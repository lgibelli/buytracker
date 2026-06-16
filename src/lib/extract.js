// Deterministic, DOM-free extraction. Runs in the service worker on raw HTML strings.

const LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function parseJsonLd(html) {
  const blocks = [];
  let m;
  LD_RE.lastIndex = 0;
  while ((m = LD_RE.exec(html)) !== null) {
    let txt = m[1].trim();
    try { blocks.push(JSON.parse(txt)); }
    catch {
      try { blocks.push(JSON.parse(txt.replace(/,\s*([}\]])/g, '$1'))); } catch { /* skip */ }
    }
  }
  return blocks;
}

const AVAIL = (v) => String(v || '').replace(/^https?:\/\/schema\.org\//i, '').trim();

// Parse a price that may be a number, "899", "198.03", "4.999,00", "1,299.00".
export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// schema.org offers can be a single Offer, an array of per-variant Offers, or an AggregateOffer
// that wraps a nested `offers` array. Flatten all shapes to a plain list of Offer nodes.
function flattenOffers(offersNode) {
  if (!offersNode) return [];
  const arr = Array.isArray(offersNode) ? offersNode : [offersNode];
  const out = [];
  for (const o of arr) {
    if (o && Array.isArray(o.offers)) out.push(...o.offers); // AggregateOffer wrapper
    else if (o) out.push(o);
  }
  return out;
}

// Identifiers that pin down "the selected variant" from the page URL — platform-agnostic.
export function variantKeysFromUrl(url) {
  const ks = new Set();
  if (!url) return ks;
  try {
    const u = new URL(url);
    for (const k of ['variant', 'variant_id', 'variantId', 'sku', 'pid']) {
      const v = u.searchParams.get(k);
      if (v) ks.add(v);
    }
  } catch { /* ignore */ }
  return ks;
}

// Does an offer reference (its url or @id) point at the selected variant?
function refMatches(ref, url, keys) {
  if (!ref) return false;
  try {
    const ru = new URL(ref, url);
    const rv = ru.searchParams.get('variant') || ru.searchParams.get('variant_id');
    if (rv && keys.has(rv)) return true;
  } catch { /* ignore */ }
  for (const k of keys) if (String(ref).includes(k)) return true;
  return false;
}

// Walk JSON-LD blocks for the best Product/Offer. Returns {name, price, currency, availability} or null.
// Each offer becomes its own candidate so per-variant offers — whether listed in one Product's
// `offers` array or split across many Product blocks (Shopify does the latter) — can be matched
// individually against the URL's variant.
// NOTE: availability is captured even when there is NO price — many shops drop the price when a
// product goes out of stock, and restock detection depends on still seeing the availability flip.
export function productFromJsonLd(blocks, url) {
  const keys = variantKeysFromUrl(url);
  const cands = [];
  const consider = (node) => {
    const offers = flattenOffers(node.offers);
    for (const off of (offers.length ? offers : [null])) {
      const price = parsePrice(off?.price ?? off?.lowPrice ?? node.price ?? node.lowPrice);
      const currency = (off?.priceCurrency ?? node.priceCurrency ?? '').toString().toUpperCase() || null;
      const availability = AVAIL(off?.availability ?? node.availability) || null;
      if (price == null && !availability) continue;
      const ref = off?.url || off?.['@id'] || node.url || node['@id'] || null;
      const sku = off?.sku ?? node.sku ?? null;
      cands.push({ name: node.name || null, price, currency, availability, ref, sku });
    }
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = JSON.stringify(n['@type'] || '');
    if (/Product/i.test(t) || n.offers || n.price || n.lowPrice) consider(n);
    for (const k in n) walk(n[k]);
  };
  blocks.forEach(walk);
  if (!cands.length) return null;

  const strip = (c) => ({ name: c.name, price: c.price, currency: c.currency, availability: c.availability });

  // Variant match wins: the candidate whose offer sku or url/@id matches the selected variant.
  if (keys.size) {
    const m = cands.find((c) => (c.sku != null && keys.has(String(c.sku))) || refMatches(c.ref, url, keys));
    if (m) return strip(m);
  }
  // Otherwise prefer a priced candidate that carries a product name.
  const priced = cands.filter((c) => c.price != null);
  const pool = priced.length ? priced : cands;
  pool.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0));
  const best = strip(pool[0]);
  if (!best.availability) { const a = cands.find((c) => c.availability); if (a) best.availability = a.availability; }
  return best;
}

// Strip a page to readable text for hashing + LLM input.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&euro;/gi, '€')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleFromHtml(html) {
  const m = /<title[^>]*>([^<]*)</i.exec(html);
  return m ? m[1].trim() : null;
}

// Detect hard bot walls so we report 'blocked' instead of 'no data'.
export function detectBlock(html, title) {
  const t = (title || '').toLowerCase();
  if (/access denied|forbidden|just a moment|attention required/.test(t)) return true;
  return /errors\.edgesuite\.net|px-captcha|datadome captcha|please verify you are a human|unusual traffic from your/i.test(html);
}

// FNV-1a 32-bit, sync — used as a cheap pre-filter before spending on the LLM.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// One-stop deterministic extraction from raw HTML. `url` lets variant-matching pick the right offer.
export function extractFromHtml(html, url) {
  const title = titleFromHtml(html);
  if (detectBlock(html, title)) return { status: 'blocked', title };
  const product = productFromJsonLd(parseJsonLd(html), url);
  const text = htmlToText(html);
  return {
    status: 'ok',
    title: product?.name || title,
    price: product?.price ?? null,
    currency: product?.currency ?? null,
    availability: product?.availability ?? null,
    hasStructuredPrice: product?.price != null,
    text,
    textHash: fnv1a(text.slice(0, 20000))
  };
}
