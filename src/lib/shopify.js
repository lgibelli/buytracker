// Shopify's /products/<handle>.js: per-variant price (in cents) and `available`, readable without a page
// load or a bot wall. Pure helpers; background.js tryShopify does the fetch.

// The endpoint for a product page. A Shopify Markets store serves each market under a path prefix
// (/pl-pl/, /en-gb/, /fr/) and the endpoint answers in that market's prices only under the same prefix:
// without it, the shop's base ones. (jowua-life.com/pl-pl: /products/<h>.js gave 49.95 for a variant
// the page sells at €54.95, since that is its USD price.) A /collections/<c>/ segment is dropped.
export function productJsUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/^(.*?)(?:\/collections\/[^/]+)?(\/products\/[^/]+)/);
  return m ? u.origin + m[1] + m[2] + '.js' : null;
}

// The variant the page at `url` shows, read from the endpoint's JSON: the ?variant= one, else Shopify's
// default (the first in stock, else the first), as the page itself picks it. The product-level `price`
// is the cheapest variant's, which the page may not show at all. Null when `p` isn't that JSON.
export function readProductJs(p, url) {
  if (!p || typeof p.available !== 'boolean' || !Array.isArray(p.variants) || !p.variants.length) return null;
  let vid = null;
  try { vid = new URL(url).searchParams.get('variant'); } catch { /* noop */ }
  const picked = vid ? p.variants.find((x) => String(x.id) === String(vid)) || null : null;
  const shown = picked || p.variants.find((x) => x.available) || p.variants[0];
  // The variant's barcode is its EAN/UPC when the store filled it in. Without a ?variant= only a
  // single-variant product has one that is the product's.
  const own = vid ? picked : (p.variants.length === 1 ? p.variants[0] : null);
  return {
    title: p.title || null,
    price: shown.price != null ? shown.price / 100 : null,
    availability: shown.available ? 'InStock' : 'OutOfStock',
    gtin: own?.barcode || null
  };
}
