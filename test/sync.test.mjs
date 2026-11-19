// Sync between computers (src/lib/sync.js), in plain Node: two fake browsers whose chrome.storage.local
// is their own and whose chrome.storage.sync is one shared area that enforces Chrome's quotas, so sync
// arrives at once. Each "computer" runs its pass with globalThis.chrome pointing at its own storage.
//   node test/sync.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (f) => import(pathToFileURL(path.join(root, 'src/lib', f)).href);

let fails = 0;
const ok = (c, m, extra) => { console.log((c ? 'OK:   ' : 'FAIL: ') + m + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!c) fails++; };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function area(limits) {
  const data = {};
  const a = {
    data, writes: 0,
    async get(keys) {
      if (keys == null) return clone(data);
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items) {
      a.writes++;
      if (limits) {
        const next = { ...data, ...clone(items) };
        const size = (k, v) => k.length + JSON.stringify(v).length;
        for (const [k, v] of Object.entries(items)) if (size(k, v) > 8192) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
        if (Object.entries(next).reduce((n, [k, v]) => n + size(k, v), 0) > 102400) throw new Error('QUOTA_BYTES quota exceeded');
        if (Object.keys(next).length > 512) throw new Error('MAX_ITEMS quota exceeded');
      }
      Object.assign(data, clone(items));
    },
    async remove(keys) { a.writes++; for (const k of [].concat(keys)) delete data[k]; },
    async clear() { for (const k of Object.keys(data)) delete data[k]; }
  };
  return a;
}

const cloud = area(true);
const computer = () => ({ storage: { local: area(false), sync: cloud } });
const A = computer(), B = computer();
const on = (c) => { globalThis.chrome = c; };

const storage = await lib('storage.js');
const { sync } = await lib('sync.js');
const { updateWatch, putWatch, deleteWatch, getWatches, getSettings, setSettings, recordObservation } = storage;

const H = 3_600_000, T0 = Date.now() - 30 * 24 * H;
const watch = (id, url, extra = {}) => ({
  id, url, title: 'Product ' + id, createdAt: T0, watchType: 'both', intervalMin: 360, targetPrice: null, selector: null,
  paused: false, fetchMode: 'auto', history: [], lastCheckedAt: T0, lastStatus: 'ok', lastPrice: null, lastAvailability: null, currency: 'EUR', ...extra
});
const observe = (id, t, price, availability = 'InStock') => updateWatch(id, (w) => { recordObservation(w, { t, price, currency: 'EUR', availability }); return w; });

// --- A: a computer from before sync (watches without specAt, its own settings) ---
on(A);
await A.storage.local.set({
  watches: {
    a1: { ...watch('a1', 'https://shop.example/lamp'), history: [{ t: T0, price: 100, availability: 'InStock' }], lastPrice: 100 },
    a2: { ...watch('a2', 'https://shop.example/desk', { createdAt: T0 + H }), history: [{ t: T0 + H, price: 250, availability: 'InStock' }], lastPrice: 250 }
  },
  settings: { defaultIntervalMin: 180, recipeHosts: ['a.example'], recipeDeclined: ['x.example'] }
});
let st = await sync();
ok(cloud.data['w:a1'] && cloud.data['w:a2'] && cloud.data['o:a1']?.p === 100, 'A\'s first pass shares its watches and their last points');
ok(!('history' in cloud.data['w:a1']) && !('fetchMode' in cloud.data['w:a1']), 'what is shared is the setup, not the history or per-computer state');
ok(cloud.data.settings?.defaultIntervalMin === 180 && !('workerToken' in cloud.data.settings), 'shared settings go up, the worker token doesn\'t');
ok(!!(await getWatches()).a1.specAt && st.shared === 2 && !st.error, 'A\'s watches get a setup stamp; state counts 2 shared', st);

// --- B: another computer, already watching the same lamp (later, its own id) and something else ---
on(B);
await B.storage.local.set({
  watches: {
    b1: { ...watch('b1', 'https://shop.example/lamp', { createdAt: T0 + 2 * H, targetPrice: 80 }), history: [{ t: T0 + 2 * H, price: 95, availability: 'InStock' }], lastPrice: 95 },
    b2: { ...watch('b2', 'https://other.example/chair', { createdAt: T0 + 3 * H, selector: '#promo' }) }
  },
  settings: { recipeHosts: ['b.example'], recipeDeclined: ['a.example'] }
});
await sync();
let wb = await getWatches();
ok(!wb.b1 && wb.a1 && wb.a1.lastPrice === 95 && wb.a1.targetPrice === 80, 'B\'s lamp becomes the shared lamp (A\'s id), keeping its own newer price and its target', wb.a1);
ok(wb.a2 && wb.a2.lastPrice === 250 && wb.a2.lastCheckedAt === 0, 'A\'s desk arrives on B with its last price, due for a check here');
ok(cloud.data['w:b2']?.selector === '#promo', 'B\'s own area watch goes up');
const sb = await getSettings();
ok(sb.defaultIntervalMin === 180 && ['a.example', 'b.example'].every((h) => sb.recipeHosts.includes(h)) && !sb.recipeDeclined.includes('a.example'),
  'B\'s first pass: A\'s interval, both computers\' allowed stores (an allow beats a decline)', sb);

on(A);
await sync();
let wa = await getWatches();
ok(wa.b2 && wa.b2.selector === '#promo' && wa.b2.fetchMode === 'tab', 'B\'s area watch arrives on A, in tab mode as area watches need');
ok(wa.a1.targetPrice === 80 && wa.a1.lastPrice === 95, 'A gets the lamp\'s target and B\'s newer price', wa.a1);
ok((await getSettings()).recipeHosts.includes('b.example'), 'A gets the merged store list');
const writes = cloud.writes;
await sync(); on(B); await sync();
ok(cloud.writes === writes, 'passes with nothing new write nothing to sync storage', cloud.writes - writes);

// --- an edit on one computer reaches the other ---
on(B);
await updateWatch('a2', (w) => ({ ...w, targetPrice: 199, paused: true }));
await sync();
on(A);
await sync();
wa = await getWatches();
ok(wa.a2.targetPrice === 199 && wa.a2.paused === true, 'a target price and pause set on B show up on A', wa.a2);

// --- an alert on one computer isn't repeated by the other ---
await observe('a1', Date.now() - H, 70);
await sync();
on(B);
await sync();
wb = await getWatches();
const before = wb.a1.history.length;
const again = recordObservation(wb.a1, { t: Date.now(), price: 70, currency: 'EUR', availability: 'InStock' });
ok(wb.a1.lastPrice === 70 && again === null && wb.a1.history.length === before, 'B takes A\'s 70 € as its last point, so its own check at 70 € is no change (no second alert)');
ok(!(await getWatches()).a1.history.some((p, i, h) => i && p.t < h[i - 1].t), 'the merged history stays in time order');

// --- a check that doesn't change the setup can't undo an edit that arrived meanwhile ---
on(A);
const stale = (await getWatches()).a2;
on(B); await updateWatch('a2', (w) => ({ ...w, intervalMin: 1440 })); await sync();
on(A); await sync();
await updateWatch('a2', (fresh) => { for (const k of [...storage.SPEC_FIELDS, 'specAt']) stale[k] = fresh[k]; return { ...stale, lastCheckedAt: Date.now() }; });
await sync();
on(B); await sync();
ok((await getWatches()).a2.intervalMin === 1440, 'a check saved on A (saveChecked) keeps the interval B set during it');

// --- deleting ---
on(B);
await deleteWatch('a2');
await sync();
ok(cloud.data['x:a2'] && !cloud.data['w:a2'] && !cloud.data['o:a2'], 'a watch deleted on B leaves a tombstone and its keys go');
ok(Object.keys((await B.storage.local.get('syncDeleted')).syncDeleted || {}).length === 0, 'B forgets the deletion once the tombstone is up');
on(A);
await sync();
ok(!(await getWatches()).a2, 'A deletes it too');

// --- an emptied sync area never empties a computer ---
await cloud.clear();
await sync();
wa = await getWatches();
ok(wa.a1 && wa.b2 && cloud.data['w:a1'] && cloud.data['w:b2'], 'after sync storage is wiped, A keeps its watches and shares them again');
on(B);
await sync();
ok(Object.keys(await getWatches()).sort().join() === 'a1,b2', 'B keeps the same two');

// --- the same page shared twice at once: everyone keeps the older ---
await cloud.set({
  'w:z1': { url: 'https://shop.example/rug', title: 'Rug', createdAt: T0 + 9 * H, u: Date.now() },
  'o:z1': { t: T0 + 9 * H, p: 40, a: 'InStock', c: 'EUR' },
  'w:z2': { url: 'https://shop.example/rug', title: 'Rug', createdAt: T0 + 8 * H, u: Date.now() },
  'o:z2': { t: T0 + 8 * H, p: 45, a: 'InStock', c: 'EUR' }
});
on(B); await sync();
on(A); await sync();
wa = await getWatches();
ok(wa.z2 && !wa.z1 && cloud.data['x:z1'] && !cloud.data['w:z1'], 'two shares of one page: the older one (z2) stays, the other gets a tombstone');
on(B);
wb = await getWatches();
ok(wb.z2 && !wb.z1 && wb.z2.history.length === 2 && wb.z2.lastPrice === 40, 'B merged z1\'s history into z2 (45 then 40)', wb.z2?.history);

// --- turned off on a computer: that computer leaves sync storage alone ---
on(A);
await setSettings({ syncWatches: false });
await putWatch(watch('a9', 'https://shop.example/private'));
st = await sync();
ok(st.off && !cloud.data['w:a9'], 'with sync off, a new watch stays on A');
await deleteWatch('b2');
await setSettings({ syncWatches: true });
await sync();
ok(!!cloud.data['w:a9'], 'turned back on, it\'s shared');
ok(cloud.data['w:b2'] && !cloud.data['x:b2'] && (await getWatches()).b2, 'a watch deleted while sync was off comes back instead of being deleted everywhere');

// --- a new computer with nothing yet doesn't override the shared settings ---
const C = computer();
on(C);
const saved = clone(cloud.data);
await cloud.clear(); // as if C ran before its browser had downloaded anything
await sync();
ok(cloud.data.settings?.u === 0, 'an untouched install shares its default settings as the oldest possible');
Object.assign(cloud.data, saved); cloud.data.settings = { ...cloud.data.settings }; // the real settings arrive
on(A); await sync();
on(C); await sync();
ok((await getSettings()).defaultIntervalMin === 180 && Object.keys(await getWatches()).length >= 4, 'and then takes A\'s settings and every shared watch');

// --- full sync storage: what doesn't fit stays on its computer, said so ---
const D = computer();
D.storage.sync = area(true);
on(D);
const many = {};
for (let i = 0; i < 300; i++) many['d' + i] = watch('d' + i, `https://shop.example/item-${i}?${'q'.repeat(300)}`, { createdAt: T0 + i });
await D.storage.local.set({ watches: many });
st = await sync();
const used = Object.entries(D.storage.sync.data).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
ok(!st.error && st.full && st.localOnly.length > 0 && st.localOnly.length < 300, `sync storage full: ${300 - st.localOnly.length} shared, ${st.localOnly.length} stay on this computer`, st);
ok(used <= 102400 && st.localOnly.includes('d299') && !st.localOnly.includes('d0'), 'the oldest go first, within the 100 KB quota');
ok(Object.keys(await getWatches()).length === 300, 'none of them is lost locally');

// --- deleting from a full sync area makes room for watches left out (removals before the writes) ---
on(D);
for (let i = 0; i < 5; i++) await deleteWatch('d' + i);
const leftOut = st.localOnly.length;
st = await sync();
ok(!st.error && st.localOnly.length < leftOut, `deleting 5 from a full area lets ${leftOut - st.localOnly.length} left-out watches in`, st);
ok(['d0', 'd1', 'd2', 'd3', 'd4'].every((id) => D.storage.sync.data['x:' + id] && !D.storage.sync.data['w:' + id]), 'and the 5 got tombstones');

// --- a price watch and a restock watch of the same page are two watches, not twins ---
const E = computer();
E.storage.sync = area(true);
on(E);
await E.storage.local.set({ watches: {
  e1: watch('e1', 'https://shop.example/bike', { watchType: 'price' }),
  e2: watch('e2', 'https://shop.example/bike', { watchType: 'availability', createdAt: T0 + H })
} });
await sync(); await sync();
const we = await getWatches();
ok(we.e1?.watchType === 'price' && we.e2?.watchType === 'availability' && !E.storage.sync.data['x:e2'], 'price and restock watches of one page both survive');

// --- a watch deleted while a pass is running keeps its deletion record ---
await putWatch(watch('e3', 'https://shop.example/bell'));
await sync();
await deleteWatch('e1');
const realSet = E.storage.sync.set;
let raced = false;
E.storage.sync.set = async (items) => { if (!raced) { raced = true; await deleteWatch('e3'); } return realSet(items); };
await sync();
E.storage.sync.set = realSet;
const pending = Object.keys((await E.storage.local.get('syncDeleted')).syncDeleted || {});
ok(raced && pending.includes('e3') && !pending.includes('e1'), 'the pass forgets only the deletion it uploaded (e1), not one made meanwhile (e3)', pending);
await sync();
ok(E.storage.sync.data['x:e3'] && !E.storage.sync.data['w:e3'], 'and the next pass uploads it');

// --- a check that saves after sync brought in another computer's point (background.js saveChecked) ---
const { keepFreshPoints } = storage;
const NOW = Date.now(), P1 = { t: NOW - 9 * H, price: 100, availability: 'InStock' };
const checked = (price) => ({ history: [P1, { t: NOW, price, availability: 'InStock' }], lastCheckedAt: NOW, lastPrice: price, lastAvailability: 'InStock' });
for (const [label, tA] of [['before', NOW - 20_000], ['after', NOW + 20_000]]) {
  const w = checked(70);
  const sup = keepFreshPoints(w, { history: [P1, { t: tA, price: 70, availability: 'InStock' }] });
  ok(sup && w.history.length === 2 && w.lastPrice === 70, `same 70 € recorded elsewhere ${label} this check began: kept once, and this check doesn't alert`, w.history);
}
let w5 = checked(70);
let sup5 = keepFreshPoints(w5, { history: [P1, { t: NOW - 20_000, price: 75, availability: 'InStock' }] });
ok(!sup5 && w5.history.map((p) => p.price).join() === '100,75,70' && w5.lastPrice === 70, 'a different price recorded elsewhere is kept in order; this check\'s 70 € still alerts');
w5 = checked(70);
sup5 = keepFreshPoints(w5, { history: [P1, { t: NOW + 20_000, price: 75, availability: 'InStock' }] });
ok(!sup5 && w5.lastPrice === 75, 'a newer point from elsewhere becomes the current price');
w5 = checked(70);
ok(!keepFreshPoints(w5, { history: [P1] }) && w5.history.length === 2, 'nothing new elsewhere: the check saves as before');

console.log(fails ? `--- SYNC TEST: ${fails} FAILURE(S) ---` : '--- SYNC TEST: ALL PASS ---');
process.exitCode = fails ? 1 : 0;
