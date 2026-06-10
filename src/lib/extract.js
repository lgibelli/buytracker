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

// Walk JSON-LD blocks for the best Product/Offer. Returns {name, price, currency, availability} or null.
// NOTE: availability is captured even when there is NO price — many shops drop the price when a
// product goes out of stock, and restock detection depends on still seeing the availability flip.
export function productFromJsonLd(blocks) {
  const cands = [];
  const consider = (node) => {
    const off = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    const price = parsePrice(node.price ?? off?.price ?? off?.lowPrice ?? node.lowPrice);
    const currency = (node.priceCurrency ?? off?.priceCurrency ?? '').toString().toUpperCase() || null;
    const availability = AVAIL(node.availability ?? off?.availability) || null;
    if (price == null && !availability) return;
    cands.push({ name: node.name || null, price, currency, availability });
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

  // Prefer a priced candidate, and among those one that carries a product name.
  const priced = cands.filter((c) => c.price != null);
  const pool = priced.length ? priced : cands;
  pool.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0));
  const best = { ...pool[0] };
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

// One-stop deterministic extraction from raw HTML.
export function extractFromHtml(html) {
  const title = titleFromHtml(html);
  if (detectBlock(html, title)) return { status: 'blocked', title };
  const product = productFromJsonLd(parseJsonLd(html));
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
