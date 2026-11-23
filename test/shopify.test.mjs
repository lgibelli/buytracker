// The Shopify product endpoint helpers (src/lib/shopify.js), in plain Node.
//   node test/shopify.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { productJsUrl, readProductJs } = await import(pathToFileURL(path.join(root, 'src/lib/shopify.js')).href);

let fails = 0;
const ok = (c, m, extra) => { console.log((c ? 'OK:   ' : 'FAIL: ') + m + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!c) fails++; };

// --- the endpoint keeps the market's path prefix ---
const P = 'https://www.jowua-life.com/pl-pl/products/magsafe-air-vent-car-mount-with-active-cooling';
ok(productJsUrl(P + '?variant=48524278923491') === P + '.js', 'a Markets subfolder (/pl-pl/) stays in the endpoint, the query goes', productJsUrl(P + '?variant=48524278923491'));
ok(productJsUrl('https://eu.magbak.com/products/case') === 'https://eu.magbak.com/products/case.js', 'a plain /products/ page');
ok(productJsUrl('https://shop.example/collections/mounts/products/case') === 'https://shop.example/products/case.js', 'a /collections/<c>/ segment is dropped');
ok(productJsUrl('https://shop.example/en-gb/collections/mounts/products/case#reviews') === 'https://shop.example/en-gb/products/case.js', 'prefix kept, collection and fragment dropped');
ok(productJsUrl('https://shop.example/blog/post') === null && productJsUrl('not a url') === null, 'no /products/ page, no endpoint');

// --- which variant's price and stock ---
// The /pl-pl/ endpoint's JSON for the product above (2026-11-23): `price` is the cheapest variant's.
const jowua = {
  title: 'Active Cooling MagSafe Car Mount for Air Vents (Model 3 Highland & Model Y Juniper)', price: 5495, available: true,
  variants: [
    { id: 48524278923491, title: 'Active Cooling Qi2 Wireless Charging', price: 6995, available: true, barcode: '4711064605471' },
    { id: 48524278956259, title: 'Non-Charging (No Active Cooling)', price: 5495, available: true, barcode: '4711064605846' }
  ]
};
let r = readProductJs(jowua, P + '?variant=48524278956259');
ok(r.price === 54.95 && r.availability === 'InStock' && r.gtin === '4711064605846', 'the ?variant= one', r);
r = readProductJs(jowua, P);
ok(r.price === 69.95 && r.gtin === null, "no ?variant=: the page's default (first) variant, not the cheapest; no EAN for a multi-variant product", r);
const firstOut = structuredClone(jowua); firstOut.variants[0].available = false;
r = readProductJs(firstOut, P);
ok(r.price === 54.95 && r.availability === 'InStock', 'no ?variant=, first variant sold out: the first one in stock, as the page shows it', r);
const allOut = structuredClone(jowua); allOut.available = false; for (const v of allOut.variants) v.available = false;
r = readProductJs(allOut, P);
ok(r.price === 69.95 && r.availability === 'OutOfStock', 'all sold out: the first variant, out of stock', r);
r = readProductJs(firstOut, P + '?variant=48524278923491');
ok(r.price === 69.95 && r.availability === 'OutOfStock' && r.gtin === '4711064605471', 'a sold-out ?variant= reads out of stock even when a sibling is in stock', r);
r = readProductJs(jowua, P + '?variant=1');
ok(r.price === 69.95 && r.availability === 'InStock' && r.gtin === null, 'an unknown ?variant=: the default variant, no EAN', r);
const single = { title: 'Case', price: 3900, available: true, variants: [{ id: 7, price: 3900, available: true, barcode: '4006381333931' }] };
r = readProductJs(single, 'https://eu.magbak.com/products/case');
ok(r.price === 39 && r.gtin === '4006381333931', "a single-variant product's barcode is the product's", r);
ok([null, {}, { available: true }, { available: true, variants: [] }, { variants: [{ id: 1 }] }].every((p) => readProductJs(p, P) === null), 'not product JSON: null');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
