// Product groups (src/lib/groups.js) and the title helpers "Find in other stores" uses (titles.js), in
// plain Node with an in-memory chrome.storage.local.
//   node test/groups.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (f) => import(pathToFileURL(path.join(root, 'src/lib', f)).href);

let fails = 0;
const ok = (c, m, extra) => { console.log((c ? 'OK:   ' : 'FAIL: ') + m + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!c) fails++; };
const data = {};
globalThis.chrome = { storage: { local: {
  async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]); return out; },
  async set(items) { Object.assign(data, structuredClone(items)); }
} } };

const { normGtin, sameGtin, groupsOf, cheapest, joinGroup, leaveGroup, notSame, suggestedMatch, cleanLink, sameLink } = await lib('groups.js');
const { storeless, searchQuery } = await lib('titles.js');
const { putWatch, getWatches, specOf } = await lib('storage.js');

// --- EAN / UPC ---
ok(['4006381333931', '036000291452', '96385074', '00012345600012'].every((g) => normGtin(g) === g), 'valid EAN-13, UPC-A, EAN-8 and GTIN-14 are kept');
ok(normGtin(4006381333931) === '4006381333931' && normGtin(' 4006-381333931 ') === '4006381333931', 'a number, or one written with spaces and dashes, reads the same');
ok([null, '', '4006381333932', '0000000000000', 'ABC1234567890', '123456789', { gtin: 1 }].every((g) => normGtin(g) === null), 'a wrong check digit, all zeros, a SKU or another length is no EAN');
ok(sameGtin('036000291452', '0036000291452') && !sameGtin('4006381333931', null), 'a UPC-A is the same product as its EAN-13 with a leading zero');

// --- product names and the search ---
const NAMES = [
  ['Apple iPhone 15 (128 GB) - Nero : Amazon.it: Elettronica', 'https://www.amazon.it/dp/B0CHX', 'Apple iPhone 15 (128 GB) - Nero'],
  ['Roborock Qrevo Curv 2 Flow | Roborock IT', 'https://it.roborock.com/products/qrevo', 'Roborock Qrevo Curv 2 Flow'],
  ['MagBak Case for iPhone 16 Pro – MagBak EU', 'https://eu.magbak.com/products/case', 'MagBak Case for iPhone 16 Pro'],
  ['Kask Protone Icon - Black Matt', 'https://www.lordgunbicycles.com/kask', 'Kask Protone Icon - Black Matt'],
  ['Lampada da tavolo', 'not a url', 'Lampada da tavolo']
];
for (const [t, u, want] of NAMES) ok(storeless(t, u) === want, `store name dropped: ${JSON.stringify(t)} → ${JSON.stringify(storeless(t, u))}`);
ok(searchQuery({ title: 'Roborock Qrevo Curv 2 Flow Robot Aspirapolvere e Lavapavimenti, Aspirazione 20000Pa : Amazon.it', url: 'https://www.amazon.it/x' })
  === 'Roborock Qrevo Curv 2 Flow Robot Aspirapolvere e Lavapavimenti', 'a marketplace title is searched up to its feature list');
ok(searchQuery({ title: 'Lamp | Shop', url: 'https://shop.example/lamp', gtin: '4006381333931' }) === '4006381333931', 'with an EAN, the search is the EAN');

// --- links from search results ---
ok(cleanLink('https://shop.example/p?id=3&srsltid=AfmBO&utm_source=x&gclid=1#reviews') === 'https://shop.example/p?id=3', 'tracking parameters and the fragment go; the product id stays');
ok(sameLink('https://shop.example/p?variant=2&srsltid=z', 'https://shop.example/p?variant=2') && !sameLink('https://shop.example/p?variant=2', 'https://shop.example/p?variant=3'), 'a variant is a different page, tracking is not');

// --- groups ---
const T = Date.now() - 86_400_000;
const w = (id, extra) => ({ id, url: `https://${id}.example/p`, title: 'Robot ' + id, createdAt: T, watchType: 'both', selector: null, history: [],
  lastPrice: null, lastAvailability: 'InStock', currency: 'EUR', ...extra });
await putWatch(w('w_a', { createdAt: T, lastPrice: 449, gtin: '4006381333931' }));
await putWatch(w('w_b', { createdAt: T + 1, lastPrice: 429 }));
await putWatch(w('w_c', { createdAt: T + 2, lastPrice: 439, gtin: '4006381333931' }));
await putWatch(w('w_d', { createdAt: T + 3, lastPrice: 399, lastAvailability: 'OutOfStock' }));
await putWatch(w('w_e', { createdAt: T + 4, selector: '#promo' }));

let ws = await getWatches();
ok(groupsOf(ws).size === 0, 'no groups yet');
const g = await joinGroup('w_b', 'w_a');
ws = await getWatches();
ok(/^g_/.test(g) && ws.w_a.group === g && ws.w_b.group === g, 'joining starts a group with both in it', [ws.w_a.group, ws.w_b.group]);
ok(specOf(ws.w_a).group === g && ws.w_a.specAt > 0, 'the group is part of the shared setup');
await joinGroup('w_d', 'w_b');
ws = await getWatches();
let groups = groupsOf(ws);
const members = groups.get(g);
ok(members.map((m) => m.id).join() === 'w_b,w_a,w_d', 'members: cheapest available first, the out-of-stock one last', members.map((m) => m.id));
ok(cheapest(members).id === 'w_b', 'the cheapest is the cheapest that can be bought (399 is out of stock)');
ok(cheapest([w('x', { lastPrice: 10, currency: 'PLN' }), w('y', { lastPrice: 30 }), w('z', { lastPrice: 20 })]).id === 'z', 'prices in another currency don\'t compete');
ok(suggestedMatch(ws.w_c, Object.values(ws), groups)?.id === 'w_a', 'same EAN as a grouped watch: the lone one is asked to join');
ok(suggestedMatch(ws.w_a, Object.values(ws), groups) === null, 'and the grouped one isn\'t asked');
await notSame('w_c', 'w_a');
ws = await getWatches();
ok(suggestedMatch(ws.w_c, Object.values(ws), groupsOf(ws)) === null && !specOf(ws.w_c).notSame, 'after "No" it stops asking (kept on this computer)');
await putWatch(w('w_g', { createdAt: T + 6, lastPrice: 459, gtin: '4006381333931' }));
await joinGroup('w_g', 'w_a');
ws = await getWatches();
ok(groupsOf(ws).get(g).some((m) => m.id === 'w_g') && suggestedMatch(ws.w_c, Object.values(ws), groupsOf(ws)) === null,
  'a "No" to a group holds when another of its stores has the same EAN');
await leaveGroup('w_g');
await joinGroup('w_e', 'w_a').catch(() => {});
ok(!groupsOf(await getWatches()).get(g).some((m) => m.id === 'w_e'), 'an area watch is never shown in a group');
await leaveGroup('w_d');
await leaveGroup('w_b');
ws = await getWatches();
ok(groupsOf(ws).size === 0 && ws.w_a.group === g, 'a group left with one watch shows as a plain watch again');
await joinGroup('w_c', 'w_a');
ok(groupsOf(await getWatches()).get(g)?.length === 2, 'and joining it again reuses its group');
// A watch that left a group, grouped with another store: a new group, not back into the old one.
await joinGroup('w_b', 'w_a');
await leaveGroup('w_a');
await putWatch(w('w_f', { createdAt: T + 5, lastPrice: 500 }));
const g2 = await joinGroup('w_f', 'w_a');
ws = await getWatches();
groups = groupsOf(ws);
ok(g2 !== g && groups.get(g2)?.map((m) => m.id).sort().join() === 'w_a,w_f' && groups.get(g)?.map((m) => m.id).sort().join() === 'w_b,w_c',
  'a watch that left its group starts a new one with the next store, leaving the old group as it was', [...groups].map(([k, v]) => [k, v.map((m) => m.id)]));

console.log(fails ? `--- GROUPS TEST: ${fails} FAILURE(S) ---` : '--- GROUPS TEST: ALL PASS ---');
process.exit(fails ? 1 : 0);
