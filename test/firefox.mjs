// Runtime test of the Firefox build (node scripts/build-firefox.js first) in the real Firefox: headless,
// temporary profile. A local server plays a store BuyTracker can't read and a self-hosted recipe worker,
// so Firefox's consent gate is checked by counting what reaches the "worker", without touching the
// production service. One real store (MagBak, Shopify) checks the background fetch.
//
//   mkdir -p /tmp/bt-fftest && cd /tmp/bt-fftest && npm i puppeteer-core   # once
//   node /path/to/buytracker/test/firefox.mjs                              # from that directory
// FIREFOX=/path/to/firefox overrides the macOS default.
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const puppeteer = createRequire(path.join(process.cwd(), '/'))('puppeteer-core');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/firefox');
const ID = 'buytracker@salamacchine.it';
const UUID = '6b1d3c2e-0f4a-4b7e-9c1d-2a3b4c5d6e7f';
const BASE = `moz-extension://${UUID}/src`;

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK:   ' : 'FAIL: ') + m); if (!c) fails++; };

// --- the fake store + fake worker ---
const recipeCalls = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/lamp')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><title>Test Lamp 3000</title></head><body>
      <h1>Test Lamp 3000</h1><p>A very good lamp. Warm light, brass finish.</p>
      <button id="buy">Add to cart</button>
      <script>window.__lampInfo = { amount: 19.99 };</script></body></html>`);
    return;
  }
  if (req.url.startsWith('/recipe') && req.method === 'POST') {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      recipeCalls.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ recipe: { price_global: '__lampInfo.amount', currency_code: 'EUR', in_stock_selector: '#buy' } }));
    });
    return;
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' }); res.end(); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX || '/Applications/Firefox.app/Contents/MacOS/firefox',
  headless: true,
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [ID]: UUID }),
    // Grants optional-permission requests without the doorhanger, which headless can't click.
    'extensions.webextOptionalPermissionPrompts': false,
  },
});

const errors = [];
const watchPage = (p, name) => {
  // Extension pages only: a store's own console noise (cookie warnings and so on) isn't ours.
  if (!/\.html$/.test(name)) return;
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const href = (p) => p.evaluate(() => location.href).catch(() => '');
// Puppeteer can't follow a navigation into a moz-extension page (it waits forever and keeps reporting
// about:blank), but evaluating in one works. So extension pages are opened by the extension itself
// (tabs.create) and found by asking each tab where it is.
async function findExt(file) {
  for (let i = 0; i < 60; i++) {
    for (const p of await browser.pages()) if ((await href(p)).startsWith(`${BASE}/${file}`)) return p;
    await sleep(250);
  }
  throw new Error('no tab for ' + file);
}
async function openExt(from, file) {
  await from.evaluate((u) => chrome.tabs.create({ url: u }), `${BASE}/${file}`);
  const p = await findExt(file); watchPage(p, file);
  await sleep(800);
  return p;
}

try {
  const extId = await browser.installExtension(EXT);
  ok(extId === ID, `installed as ${extId}`);

  const welcome = await findExt('welcome.html');
  ok(!!welcome, 'onInstalled opened the welcome tab');
  const popup = await openExt(welcome, 'popup.html');
  const env = await popup.evaluate(async () => ({
    all: await browser.permissions.getAll(),
    page: await browser.permissions.contains({ data_collection: ['websiteContent', 'browsingActivity'] }),
    alarms: (await chrome.alarms.getAll()).map((a) => a.name),
    empty: !document.getElementById('empty').classList.contains('hidden'),
  }));
  ok(Array.isArray(env.all.data_collection), `data_collection permissions known to Firefox: ${JSON.stringify(env.all.data_collection)}`);
  ok(env.page === false, 'page data not granted at install');
  ok(env.alarms.includes('tick'), `background ran onInstalled (alarms: ${env.alarms})`);
  ok(env.empty, 'popup renders the empty state');

  // 1. Shopify store, through the popup's own "Watch this page" path.
  const prod = await browser.newPage(); watchPage(prod, 'magbak');
  await prod.goto('https://eu.magbak.com/products/magbak-phone-mount-and-charger-for-tesla-25w', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const truth = await prod.evaluate(() => fetch(location.pathname + '.js').then((r) => r.json())
    // No ?variant= in the URL: BuyTracker reports the product-level price, which Shopify sets to the lowest variant's.
    .then((j) => ({ price: j.price / 100, inStock: !!j.available }))).catch(() => null);
  await prod.bringToFront();
  const add = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'addCurrentTab' }));
  ok(add?.ok, `addCurrentTab: ${add?.ok ? add.watch.title?.slice(0, 40) : JSON.stringify(add)}`);
  if (add?.ok) {
    const p0 = add.watch.history?.[0] || {};
    ok(truth && p0.price === truth.price, `captured price ${p0.price} ${add.watch.currency} (store says ${truth?.price})`);
    const chk = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'checkNow', id }), add.watch.id);
    ok(chk?.ok && chk.watch.lastStatus === 'ok' && chk.watch.lastPrice === truth?.price,
      `background check: status=${chk?.watch?.lastStatus} price=${chk?.watch?.lastPrice} avail=${chk?.watch?.lastAvailability} mode=${chk?.watch?.fetchMode}`);
  }

  // 2. A store nothing generic can read, with a self-hosted worker set but Firefox consent NOT given.
  await popup.evaluate(async (w) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), workerUrl: w } });
  }, ORIGIN);
  const lamp = await browser.newPage(); watchPage(lamp, 'lamp');
  await lamp.goto(`${ORIGIN}/lamp`);
  await lamp.bringToFront();
  const addL = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'addCurrentTab' }));
  ok(addL?.ok, `lamp watch added (price=${addL?.watch?.lastPrice})`);
  const t0 = Date.now();
  const c1 = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'checkNow', id }), addL.watch.id);
  ok(c1?.ok, `lamp check without consent ran in ${((Date.now() - t0) / 1000).toFixed(1)}s: status=${c1?.watch?.lastStatus} price=${c1?.watch?.lastPrice} mode=${c1?.watch?.fetchMode}`);
  ok(recipeCalls.length === 0, `nothing reached the worker without consent (${recipeCalls.length} calls)`);
  ok(c1?.watch?.recipeOffer === true, `card offers the recipe service instead (recipeOffer=${c1?.watch?.recipeOffer})`);

  // A wrong-result report to the developer is refused before any network, too.
  const rep = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'reportWrong', id, feedback: { note: 'test', correct_price: 19.99 }, send: true }), addL.watch.id);
  ok(rep && !rep.ok, `report without consent refused: ${rep?.error}`);

  // 3. Consent through the options page's Save (a real click, so Firefox counts it as user input).
  const opts = await openExt(popup, 'options.html');
  ok(await opts.$eval('#workerUrl', (e) => e.value) === ORIGIN, 'options shows the stored worker URL');
  ok(await opts.$eval('#sendErrorReports', (e) => e.checked) === false, 'error reports off by default');
  await opts.click('#save');
  await new Promise((r) => setTimeout(r, 800));
  const granted = await opts.evaluate(() => browser.permissions.contains({ data_collection: ['websiteContent', 'browsingActivity'] }));
  ok(granted, `Save asked Firefox and it granted page data (status: "${await opts.$eval('#status', (e) => e.textContent)}")`);

  const c2 = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'checkNow', id }), addL.watch.id);
  ok(recipeCalls.length === 1, `with consent the check asked the worker once (${recipeCalls.length})`);
  if (recipeCalls[0]) ok(recipeCalls[0].snapshot && recipeCalls[0].host === '127.0.0.1', `worker got host=${recipeCalls[0].host}, snapshot keys: ${Object.keys(recipeCalls[0].snapshot || {}).slice(0, 6)}`);
  ok(c2?.watch?.lastPrice === 19.99 && c2?.watch?.currency === 'EUR', `MAIN-world recipe read the page global: price=${c2?.watch?.lastPrice} ${c2?.watch?.currency}, error=${c2?.watch?.lastError}`);

  // 4. Error-report switch: Firefox's own permission, on and off.
  await opts.click('#sendErrorReports');
  await new Promise((r) => setTimeout(r, 500));
  const errOn = await opts.evaluate(() => browser.permissions.contains({ data_collection: ['technicalAndInteraction'] }));
  ok(errOn && await opts.$eval('#sendErrorReports', (e) => e.checked), 'error-report switch grants Firefox permission');
  await opts.click('#sendErrorReports');
  await new Promise((r) => setTimeout(r, 500));
  const errOff = await opts.evaluate(() => browser.permissions.contains({ data_collection: ['technicalAndInteraction'] }));
  ok(!errOff, 'and gives it back when switched off');

  // 4b. The popup's own "Allow for <store>", on a store never read before (localhost: another host),
  // after the user took page-data consent back in about:addons.
  await opts.evaluate(() => browser.permissions.remove({ data_collection: ['websiteContent', 'browsingActivity'] }));
  const lamp2 = await browser.newPage();
  await lamp2.goto(ORIGIN.replace('127.0.0.1', 'localhost') + '/lamp');
  await lamp2.bringToFront();
  const addL2 = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'addCurrentTab' }));
  const c3 = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'checkNow', id }), addL2.watch.id);
  ok(c3?.watch?.recipeOffer === true && recipeCalls.length === 1, `consent revoked: new store gets the offer, nothing sent (calls ${recipeCalls.length})`);
  await popup.bringToFront();
  await popup.evaluate(() => location.reload());
  await sleep(1200);
  if (await popup.$eval('#tour', (t) => !t.classList.contains('hidden'))) { await popup.click('#tourGo'); await sleep(300); }
  const offers = await popup.$$eval('[data-act="offer-allow"]', (b) => b.map((x) => x.textContent));
  ok(offers.length === 1 && offers[0] === 'Allow for localhost', `popup shows ${JSON.stringify(offers)}`);
  if (offers.length) {
    await popup.click('[data-act="offer-allow"]');
    for (let i = 0; i < 60 && recipeCalls.length < 2; i++) await sleep(250);
    await sleep(1500);
    const g = await popup.evaluate(() => browser.permissions.contains({ data_collection: ['websiteContent', 'browsingActivity'] }));
    const w2 = await popup.evaluate(async (id) => (await chrome.storage.local.get('watches')).watches[id], addL2.watch.id);
    ok(g && recipeCalls.length === 2 && recipeCalls[1].host === 'localhost', `Allow asked Firefox (granted=${g}), then went to the worker (calls ${recipeCalls.length}, host ${recipeCalls[1]?.host})`);
    ok(w2?.lastPrice === 19.99 && !w2?.recipeOffer, `and the store is read now: price=${w2?.lastPrice}, offer=${w2?.recipeOffer}`);
  }

  // 5. Popup: delete is two clicks (no confirm() in a Firefox popup). A fresh popup tab: puppeteer can't
  // see a reload inside an extension page, so the reloaded one's handles are stale.
  const pop = await openExt(popup, 'popup.html');
  await pop.bringToFront();
  if (await pop.$eval('#tour', (t) => !t.classList.contains('hidden'))) { await pop.click('#tourGo'); await sleep(300); }
  const before = await pop.$$eval('.card', (c) => c.length);
  await pop.click('.card .del');
  await sleep(300);
  const armed = await pop.$eval('.card .del', (b) => b.classList.contains('armed') && b.textContent);
  await pop.click('.card .del');
  await sleep(600);
  const after = await pop.$$eval('.card', (c) => c.length);
  ok(before === 3 && armed === 'Delete?' && after === 2, `delete: ${before} cards, armed="${armed}", then ${after}`);
  // And an error shows in the popup's toast, not alert(): "Watch this page" on a tab that isn't a product page.
  await pop.click('#add');
  await sleep(800);
  const toast = await pop.$eval('#toast', (t) => (t.classList.contains('hidden') ? null : t.textContent));
  ok(!!toast, `error toast: "${toast}"`);

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  ok(false, 'exception: ' + (e.stack || e));
} finally {
  await browser.close();
  server.close();
  console.log(fails ? `--- FIREFOX: ${fails} FAILED ---` : '--- FIREFOX: ALL PASS ---');
  process.exit(fails ? 1 : 0);
}
