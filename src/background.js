import { extractFromHtml, detectBlock, fnv1a } from './lib/extract.js';
import { capturePage } from './lib/capture.js';
import { pickArea } from './lib/picker.js';
import { buildSnapshot, applyRecipe, getRecipe, putRecipe, deriveRecipe, sanitizeRecipe, recipeServiceFor, recipeOfferFor, recipeHost } from './lib/recipe.js';
import {
  getSettings, setSettings, dropRetiredSettings, getWatches, getWatch, putWatch, updateWatch, newId, recordObservation, availState, trustedPrice, lastKnownPrice, priceMove,
  SERVICE_URL, SPEC_FIELDS, keepFreshPoints
} from './lib/storage.js';
import { syncSoon, syncRelevant } from './lib/sync.js';
import { normGtin, cheapest, joinGroup, cleanLink, sameLink } from './lib/groups.js';
import { productJsUrl, readProductJs } from './lib/shopify.js';
import { storeless, searchQuery } from './lib/titles.js';
import { installErrorReporting, reportError, isBug, sendFeedback } from './lib/report.js';
import { sendable } from './lib/consent.js';

// Error reports go out only while the user has them on in Settings (off by default): uncaught errors
// here, and caught ones that are bugs in our own code rather than a store or the network failing.
installErrorReporting('background');
const reportBug = (e) => { if (isBug(e)) reportError(e, 'background'); };

const TICK_MIN = 15;
const RECIPE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // re-derive a stuck per-site recipe at most weekly

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'bt-price', title: 'BuyTracker: monitor price changes', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'bt-avail', title: 'BuyTracker: monitor availability (restock)', contexts: ['page', 'link'] });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create('tick', { periodInMinutes: TICK_MIN, delayInMinutes: 1 });
  setupMenus();
  // First install only: error reports start on (the welcome page says so, with the switch to turn them
  // off), and a one-screen welcome tab opens. Installs from before keep the setting they had.
  if (details.reason === 'install') {
    setSettings({ sendErrorReports: true })
      .finally(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') }));
  }
  if (details.reason === 'update') dropRetiredSettings().catch((e) => console.warn('settings cleanup', e));
  syncSoon();
});
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('tick', { periodInMinutes: TICK_MIN }); setupMenus(); syncSoon(); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'tick') return;
  syncSoon(); // also heals a change an earlier pass couldn't write (e.g. the sync rate limit)
  checkDue().catch((e) => { console.warn('tick', e); reportBug(e); });
});

// The user's other computers changed the shared watch list, or this one did (from here or the popup):
// bring the two in line (lib/sync.js). Registered at the top level so a change wakes the worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' || (area === 'local' && syncRelevant(changes))) syncSoon();
});

chrome.notifications.onClicked.addListener(async (id) => {
  const [tag, wid] = id.split('|');
  if (tag !== 'bt' || wid === '_') { chrome.notifications.clear(id); return; }
  const w = await getWatch(wid);
  if (w) chrome.tabs.create({ url: w.url });
  chrome.notifications.clear(id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const watchType = info.menuItemId === 'bt-avail' ? 'availability' : info.menuItemId === 'bt-price' ? 'price' : null;
  if (!watchType) return;
  contextAdd(info, tab, watchType).catch((e) => toast('BuyTracker', 'Could not add watch: ' + (e.message || e)));
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'addCurrentTab') return sendResponse({ ok: true, watch: await addByTab((await activeTab()), 'both') });
      if (msg.type === 'addAreaFromTab') {
        // Ack right away so the popup can close — it MUST close for the user to click the page.
        // Awaiting the full pick would keep the popup (and the message channel) open until the
        // click, which never comes because the popup is covering the page. The picker runs detached.
        addAreaFromTab().catch((e) => { console.warn('area', e); reportBug(e); });
        return sendResponse({ ok: true });
      }
      if (msg.type === 'checkNow') return sendResponse({ ok: true, watch: await checkWatch(await getWatch(msg.id)) });
      if (msg.type === 'checkAll') { await checkDue(true); return sendResponse({ ok: true }); }
      if (msg.type === 'reportWrong') return sendResponse({ ok: true, ...(await reportWrong(msg.id, msg.feedback, !!msg.send)) });
      if (msg.type === 'findElsewhere') { await findElsewhere(msg.id); return sendResponse({ ok: true }); }
      // From src/search.js, in a Google results tab: what it may do there is decided here, by the tab.
      if (msg.type === 'searchTab') return sendResponse(await searchTabInfo(_s.tab?.id));
      if (msg.type === 'searchAdd') return sendResponse({ ok: true, ...(await searchAdd(_s.tab?.id, msg.url, !!msg.force)) });
      if (msg.type === 'searchStop') { await forgetSearchTab(_s.tab?.id); return sendResponse({ ok: true }); }
      sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) { reportBug(e); sendResponse({ ok: false, error: String(e && e.message || e) }); }
  })();
  return true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a product page first.');
  return tab;
}

function langFor(url) {
  try {
    const h = new URL(url).hostname;
    if (h.endsWith('.it')) return 'it-IT,it;q=0.9,en;q=0.8';
    if (h.endsWith('.pl')) return 'pl-PL,pl;q=0.9,en;q=0.8';
    if (h.endsWith('.de')) return 'de-DE,de;q=0.9,en;q=0.8';
  } catch { /* noop */ }
  return 'en-US,en;q=0.9';
}

// --- acquisition strategies, cheapest/most-reliable first ---

// Shopify exposes /products/<handle>.js with a per-variant `available` boolean and price (cents).
// Deterministic, free, no bot wall — the gold-standard signal for the huge Shopify ecosystem.
async function tryShopify(url) {
  const endpoint = productJsUrl(url);
  if (!endpoint) return null;
  let res;
  try { res = await fetch(endpoint, { credentials: 'include', headers: { Accept: 'application/json' } }); } catch { return null; }
  if (!res.ok) return null;
  let p;
  try { p = await res.json(); } catch { return null; }
  const v = readProductJs(p, url);
  if (!v) return null;
  return {
    status: 'ok', title: v.title, price: v.price, currency: null,
    availability: v.availability, hasStructuredPrice: v.price != null, gtin: v.gtin,
    fullText: '', areaText: null, textHash: null, viaTab: false
  };
}

// Shopify's product endpoint gives no currency, and a price without one can't be compared with another
// store's (lib/groups.js cheapest). The page's own structured data names it: read it once, when the
// watch doesn't know it yet. Only the currency: the page's other fields may describe another variant.
async function withPageCurrency(ex, url, known) {
  if (!ex || ex.currency || known) return ex;
  const page = await fetchAndExtract(url).catch(() => null);
  if (page?.status === 'ok' && page.currency) ex.currency = page.currency;
  return ex;
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow', signal: ctrl.signal, headers: { 'Accept-Language': langFor(url) } });
    return { httpOk: res.ok, status: res.status, html: await res.text() };
  } finally { clearTimeout(timer); }
}

async function fetchAndExtract(url) {
  const { httpOk, status, html } = await fetchHtml(url);
  const ex = extractFromHtml(html, url);
  if (ex.status === 'blocked') return { status: 'blocked', title: ex.title, viaTab: false, httpStatus: status };
  return {
    status: 'ok', title: ex.title, price: ex.price, currency: ex.currency, availability: ex.availability,
    hasStructuredPrice: ex.hasStructuredPrice, gtin: ex.gtin, fullText: ex.text, areaText: null, textHash: ex.textHash, viaTab: false, httpOk, httpStatus: status
  };
}

function waitForComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeout);
  });
}

// Run an injected function in the page's MAIN world (so it can read window globals — recipes need
// this; capturePage stays in the default isolated world).
async function runInPage(tabId, func, args) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'MAIN' });
  return result;
}

// The worker enforces a hard daily derivation budget and answers 429 once it's spent. Park
// derivation until the quota resets (Retry-After, else next UTC midnight) and tell the user
// once per day; normal checks keep running, and derivation resumes by itself afterwards.
async function derivePausedUntil() {
  const { recipeBudget } = await chrome.storage.local.get('recipeBudget');
  return recipeBudget?.pausedUntil || 0;
}
async function pauseDerivation(retryAfterSec) {
  const DAY = 86_400_000;
  const ms = retryAfterSec > 0 ? retryAfterSec * 1000 : (Math.floor(Date.now() / DAY) + 1) * DAY - Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const { recipeBudget } = await chrome.storage.local.get('recipeBudget');
  await chrome.storage.local.set({ recipeBudget: { pausedUntil: Date.now() + ms, notifiedDay: day } });
  if (recipeBudget?.notifiedDay !== day) {
    toast('BuyTracker recipe creator', 'Today\'s limit is reached, so new store recipes wait until tomorrow. Checks keep running as usual.');
  }
}

// opts: { recipe, derive, need:{price,avail}, settings } — all optional.
// A cached per-site recipe is applied on every tab check (deterministic, free). When `derive` is set
// and a needed signal is still missing, we snapshot the page and ask the worker for a recipe ONCE,
// cache it, and apply it — all within this single tab so we never open a second one to derive.
async function extractViaTab(url, selector, opts = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForComplete(tab.id, 35000);
    await sleep(2500);
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage, args: [selector || null] });
    if (!result) return { status: 'error', viaTab: true };
    const full = result.pageText || '';
    const area = result.areaText || null;
    if (detectBlock(full, result.title)) return { status: 'blocked', title: result.title, viaTab: true };

    let price = result.product?.price ?? null;
    let currency = result.product?.currency ?? null;
    let availability = result.product?.availability ?? null;
    // Where the price came from: 'jsonld' (schema.org) and 'recipe' (site-specific) are deterministic;
    // 'dom' is capturePage's rendered-text guess — the most prominent currency amount on the page.
    let priceSource = price != null ? (result.product?.priceSource || 'dom') : null;
    let recipeUsed = false, recipeDerived = false, recipeError = null, recipeOffer = false;

    // A site-specific recipe is authoritative over the generic heuristic — it was derived precisely
    // because the heuristic got this site wrong. It only ever sets a field it actually resolves.
    const apply = (rec) => {
      if (!rec) return;
      recipeUsed = true;
      if (rec.price != null) { price = rec.price; priceSource = 'recipe'; }
      if (rec.currency) currency = rec.currency;
      // A recipe's OUT-of-stock signal is authoritative — catching one the generic heuristic misses
      // is usually why the recipe exists. Its IN-stock signal is not: it only says "a selector that
      // looks purchasable matched", which amazon.pl's hidden keyboard-shortcut "Dodaj do koszyka"
      // entry satisfied on every page, holding a listing whose own text read "Chwilowo niedostępne"
      // at "in stock" — which in turn let a carousel price pass as the product's. So an in-stock
      // recipe signal may FILL a missing availability, never overturn one the page itself stated.
      if (rec.availability && (rec.availability === 'OutOfStock' || availState(availability) !== 'out')) {
        availability = rec.availability;
      }
    };

    // Recipes describe the main product; skip them for area watches (which monitor a sub-region).
    const recipesAllowed = !selector;
    const cached = recipesAllowed ? (opts.recipe ?? await getRecipe(url)) : null;
    // Non-fatal: a throwing recipe (e.g. bad selector, tab navigated) must not abort the check — fall
    // through to the generic result, same as the derivation path below.
    if (cached) { try { apply(await runInPage(tab.id, applyRecipe, [cached])); } catch (e) { recipeError = 'recipe: ' + String(e.message || e); } }

    const need = opts.need || { price: true, avail: true };
    const stillMissing = (need.price && price == null) || (need.avail && !availability);
    const s = opts.settings;
    // Derive when no recipe exists yet; only RE-derive a cached one once it's gone stale — otherwise a
    // legitimately-absent signal (e.g. price hidden while out of stock) would re-derive every check.
    // Nothing about a store leaves the browser until the user allowed the recipe service for it (or runs
    // their own): until then the watch just carries the offer, shown on its card.
    const stale = cached && Date.now() - (cached.cachedAt || 0) > RECIPE_STALE_MS;
    const svc = s ? recipeServiceFor(s, url, SERVICE_URL) : null;
    if (recipesAllowed && opts.derive && stillMissing && !svc && s && recipeOfferFor(s, url)) recipeOffer = true;
    if (recipesAllowed && opts.derive && stillMissing && svc && (!cached || stale)) {
      if (Date.now() < await derivePausedUntil()) {
        recipeError = 'recipe: the recipe creator reached today\'s limit — retrying automatically tomorrow';
      } else {
        try {
          const snapshot = await runInPage(tab.id, buildSnapshot, [selector || null]);
          const fresh = sanitizeRecipe(await deriveRecipe({ workerUrl: svc.url, token: svc.token, url, snapshot, force: !!cached }));
          if (fresh) { await putRecipe(url, fresh); recipeDerived = true; apply(await runInPage(tab.id, applyRecipe, [fresh])); }
        } catch (e) {
          if (e.status === 429) {
            await pauseDerivation(e.retryAfterSec);
            recipeError = 'recipe: the recipe creator reached today\'s limit — retrying automatically tomorrow';
          } else {
            recipeError = 'recipe: ' + String(e.message || e);
          }
        }
      }
    }

    return {
      // A DOM-scan guess is NOT structured: on a product with no price of its own (unavailable) it is
      // some bystander's price — computeFrom drops it then.
      status: 'ok', title: result.title, price, currency, availability, priceSource,
      hasStructuredPrice: price != null && priceSource !== 'dom', gtin: result.product?.gtin ?? null,
      fullText: full, areaText: area, textHash: fnv1a((area || full).slice(0, 20000)),
      viaTab: true, recipeUsed, recipeDerived, recipeError, recipeOffer
    };
  } finally { try { await chrome.tabs.remove(tab.id); } catch { /* gone */ } }
}

// User-reported wrong result. With the user's own recipe worker, it is fixed: see rederiveFor. With
// `send` (the user ticked "send to the developer", or has no worker and pressed "Send to the
// developer"), the report also goes to the developer, with what the re-check read, so stores BuyTracker
// misreads get fixed for everyone. Resolves to { watch, sent }.
async function reportWrong(id, feedback, send) {
  const watch = await getWatch(id);
  if (!watch) throw new Error('Watch not found');
  if (watch.selector) throw new Error('Reporting a wrong result works on whole-page watches, not area watches.');
  const settings = await sendable(await getSettings());
  const recipe = await getRecipe(watch.url).catch(() => null); // the recipe that read it wrong
  const share = (outcome, after) => sendFeedback({ watch, recipe, feedback, outcome, after });
  // The popup allows the store before asking for a fix (submitting the form is the consent).
  const svc = recipeServiceFor(settings, watch.url, SERVICE_URL);
  if (!svc) {
    if (!send) throw new Error('Turn on the free recipe creator in Settings first — that’s what re-derives the fix.');
    await share('not_attempted', null);
    return { watch, sent: true };
  }
  let after;
  try { after = await rederiveFor(watch, feedback, svc); }
  catch (e) { if (send) await share('error', null).catch(() => {}); throw e; }
  const sent = send ? await share(fixOutcome(feedback, after), after).then(() => true, () => false) : false;
  return { watch: after, sent };
}

// Whether the re-check now reads what the user said the page shows.
function fixOutcome(fb, w) {
  const ok = [];
  if (fb.correct_availability) ok.push(availState(w.lastAvailability) === fb.correct_availability);
  if (fb.correct_price != null) ok.push(w.lastPrice != null && Math.abs(w.lastPrice - fb.correct_price) < 0.005);
  return !ok.length ? 'rederived' : ok.every(Boolean) ? 'fixed' : 'still_wrong';
}

// Force-re-derive this host's recipe, feeding the user's correction to the worker LLM as a trusted
// hint, then re-check the watch so the fix shows immediately. Whole-page watches only (a recipe
// describes the main product, not an area sub-region). Bypasses the weekly staleness cap on purpose —
// the user just told us the cached recipe is wrong — but still respects the worker's hard daily
// budget (429 → park until the quota resets, same as the auto-derive path).
async function rederiveFor(watch, feedback, svc) {
  const id = watch.id;
  const limitMsg = 'The recipe creator reached today’s limit. Try again tomorrow.';
  if (Date.now() < await derivePausedUntil()) throw new Error(limitMsg);

  const tab = await chrome.tabs.create({ url: watch.url, active: false });
  try {
    await waitForComplete(tab.id, 35000);
    await sleep(2500);
    const snapshot = await runInPage(tab.id, buildSnapshot, [null]);
    const fresh = await deriveRecipe({ workerUrl: svc.url, token: svc.token, url: watch.url, snapshot, force: true, feedback });
    if (fresh) await putRecipe(watch.url, fresh);
  } catch (e) {
    if (e.status === 429) { await pauseDerivation(e.retryAfterSec); throw new Error(limitMsg); }
    throw e;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch { /* gone */ }
  }

  // This site needed a recipe correction, so pin it to the recipe-applying tab path and re-check
  // now — checkWatch will re-read the recipe we just cached and apply it. A check already running on
  // this watch started before that recipe existed: let it finish rather than join it, then re-check
  // from the stored watch so its result isn't overwritten with this pre-derivation copy.
  await inFlight.get(id)?.catch(() => {});
  const fresh = await getWatch(id);
  if (!fresh) throw new Error('Watch not found');
  fresh.fetchMode = 'tab';
  return checkWatch(fresh);
}

// Price and stock as the page itself states them. Structured prices (JSON-LD / Shopify .js / site
// recipe) are taken as-is. A rendered-DOM guess (priceSource 'dom': the most prominent currency amount
// on the page) is dropped when the product is known to be unpurchasable: such a listing usually shows
// no price of its own, and every amount on it belongs to a neighbour — on an unavailable amazon.pl
// listing it was a sponsored carousel item, and it went out as a "price drop" (see trustedPrice).
function computeFrom(ex, watch) {
  const availability = ex.availability || null;
  return {
    price: trustedPrice(ex.price ?? null, { structured: ex.hasStructuredPrice, availability }),
    currency: ex.currency || watch.currency || null,
    availability
  };
}

// --- watch creation ---

async function saveNewWatch({ cap, selector, fetchMode, baseline, watchType = 'both' }) {
  const settings = await getSettings();
  const now = Date.now();
  const watch = {
    id: newId(), url: cap.url, title: cap.title, createdAt: now, watchType,
    currency: cap.product?.currency || null, intervalMin: settings.defaultIntervalMin, targetPrice: null,
    selector: selector || null, fetchMode,
    // What the watched area read when it was picked: a check that reads something else alerts.
    lastAreaHash: selector ? fnv1a((baseline || '').slice(0, 20000)) : null,
    paused: false, history: [], lastCheckedAt: now, lastStatus: 'ok', lastError: null, lastSummary: null,
    lastAvailability: cap.product?.availability || null,
    // The product's EAN, when the page states one: it finds the product in other stores and suggests
    // grouping watches of the same product (lib/groups.js). Learned again at every check.
    gtin: selector ? null : normGtin(cap.product?.gtin)
  };
  // Same rule as a re-check (computeFrom): a rendered-DOM guess is only the product's price when the
  // product can be bought. Adding a watch on an already-unavailable listing must not seed the series
  // with a carousel neighbour's price — that first point is what every later check is compared to.
  if (cap.product?.price != null || cap.product?.availability) {
    const seeded = trustedPrice(cap.product.price ?? null, {
      structured: cap.product.priceSource ? cap.product.priceSource !== 'dom' : false,
      availability: cap.product.availability
    });
    recordObservation(watch, { t: now, price: seeded, currency: cap.product.currency, availability: cap.product.availability });
  }
  await putWatch(watch);
  return watch;
}

async function addByTab(tab, watchType) {
  if (!/^https?:/.test(tab.url || '')) throw new Error('Not a web page.');
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage, args: [null] });
  if (!result) throw new Error('Could not read the page.');
  // Keep the address-bar URL so a Shopify ?variant= selection is preserved in the watch.
  result.url = tab.url || result.url;
  // capturePage reads the page's JSON-LD, whose offers are per-variant — it takes the FIRST one,
  // so a multi-variant product reads "in stock" even when the selected variant is sold out.
  // The /products/<handle>.js endpoint reports the exact selected variant — prefer it when present.
  const sh = await tryShopify(result.url).catch(() => null);
  if (sh && sh.status === 'ok') {
    result.product = {
      name: result.product?.name || result.title || null,
      price: sh.price ?? result.product?.price ?? null,
      currency: sh.currency || result.product?.currency || null,
      availability: sh.availability || result.product?.availability || null,
      // Shopify names the selected variant exactly; with no barcode there, the page's GTIN may be a sibling's.
      gtin: sh.gtin || null,
      // Keep where the price came from: the variant endpoint is structured, otherwise it is whatever
      // capturePage tagged it (jsonld / dom) — saveNewWatch trusts a 'dom' guess only when in stock.
      priceSource: sh.price != null ? 'shopify' : (result.product?.priceSource || null)
    };
  }
  return saveNewWatch({ cap: result, selector: null, fetchMode: 'auto', baseline: result.pageText, watchType });
}

// A page we only have the address of (a link, a search result), read the way a check reads it: the
// Shopify endpoint, else a plain fetch, and a background tab when that is walled off or finds neither a
// structured price nor stock (a page that renders them with JS). The tab result is taken when it read
// more. A cached recipe for the store applies in the tab, as at a check; none is derived here.
async function readLink(url) {
  let ex = await withPageCurrency(await tryShopify(url).catch(() => null), url, null);
  if (!ex) ex = await fetchAndExtract(url).catch(() => null);
  if (!ex || ex.status !== 'ok' || (!ex.hasStructuredPrice && !ex.availability)) {
    const ex2 = await extractViaTab(url, null).catch(() => null);
    if (ex2?.status === 'ok' && (!ex || ex.status !== 'ok' || ex2.price != null || ex2.availability)) ex = ex2;
    else if (!ex) ex = ex2;
  }
  return ex;
}

async function saveRead(url, ex, watchType) {
  const cap = {
    url, title: ex.title || url,
    product: (ex.price != null || ex.availability)
      ? {
        name: ex.title, price: ex.price ?? null, currency: ex.currency ?? null, availability: ex.availability ?? null,
        priceSource: ex.priceSource || (ex.hasStructuredPrice ? 'jsonld' : 'dom'), gtin: ex.gtin ?? null
      }
      : null,
    pageText: ex.fullText || ''
  };
  return saveNewWatch({ cap, selector: null, fetchMode: ex.viaTab ? 'tab' : 'auto', baseline: cap.pageText, watchType });
}

async function addByUrl(url, watchType) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be watched.');
  const ex = await readLink(url);
  if (!ex || ex.status !== 'ok') throw new Error('Could not read that link.');
  return saveRead(url, ex, watchType);
}

async function addAreaFromTab() {
  let tab;
  try {
    tab = await activeTab();
  } catch (e) {
    // The popup is already closed by now, so a thrown error would vanish — toast instead.
    toast('BuyTracker', (e.message || String(e)) + ' Area watching only works on a normal product page.');
    throw e;
  }
  try {
    const [{ result: pick } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pickArea });
    if (!pick) return null; // user pressed Esc or it timed out — stay quiet, not an error
    const [{ result: cap } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage, args: [pick.selector] });
    const watch = await saveNewWatch({ cap: cap || { url: tab.url, title: tab.title }, selector: pick.selector, fetchMode: 'tab', baseline: pick.areaText || cap?.areaText || cap?.pageText, watchType: 'both' });
    toast('👀 Watching area', `${watch.title} — watching the region you selected.`);
    return watch;
  } catch (e) {
    toast('BuyTracker', 'Could not start the area picker here: ' + (e.message || e));
    throw e;
  }
}

async function contextAdd(info, tab, watchType) {
  const watch = info.linkUrl ? await addByUrl(info.linkUrl, watchType) : await addByTab(tab, watchType);
  const what = watchType === 'availability' ? 'availability' : watchType === 'price' ? 'price' : 'price & availability';
  toast('👀 Watching', `${watch.title} — for ${what}.`);
}

// --- finding the product in other stores ---

// "Find in other stores" opens a Google search for the product in a new tab. While at least one such
// tab is open, src/search.js is registered on Google's results pages. It asks here first, and adds its
// "+ BuyTracker" buttons only in a tab opened for a watch: searchTabs (tab id → watch id), in session
// storage, which ends with the browser session as the tabs do. The user's own searches get nothing,
// and no listener wakes the service worker at every tab change.
const SEARCH_SCRIPT = {
  id: 'bt-search', matches: ['https://www.google.com/search*'], js: ['src/search.js'], runAt: 'document_idle',
  persistAcrossSessions: false
};
const searchTabs = async () => (await chrome.storage.session.get('searchTabs')).searchTabs || {};
const setSearchTabs = (tabs) => chrome.storage.session.set({ searchTabs: tabs });
// Linking a tab and registering the script, against dropping links and unregistering it: one at a time,
// or a results page of the user's own, finding no link yet, could unregister the script a new search
// tab is about to need.
const searchLock = (fn) => (globalThis.navigator?.locks?.request ? navigator.locks.request('buytracker-search', fn) : fn());
const unregisterSearch = () => chrome.scripting.unregisterContentScripts({ ids: [SEARCH_SCRIPT.id] }).catch(() => {});

async function findElsewhere(id) {
  const w = await getWatch(id);
  if (!w) throw new Error('Watch not found');
  // The tab is linked to the watch before it loads the results, so the script finds the link there.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await searchLock(async () => {
    await setSearchTabs({ ...(await searchTabs()), [tab.id]: id });
    if ((await chrome.scripting.getRegisteredContentScripts({ ids: [SEARCH_SCRIPT.id] })).length === 0) {
      await chrome.scripting.registerContentScripts([SEARCH_SCRIPT]);
    }
  });
  await chrome.tabs.update(tab.id, { url: 'https://www.google.com/search?q=' + encodeURIComponent(searchQuery(w)) });
}

// What src/search.js may do in this tab: { ok, name } in a tab opened for a watch, else { ok: false }.
// Links to closed tabs are dropped on the way; with none left, the script stops loading on Google.
function searchTabInfo(tabId) {
  return searchLock(() => searchTabCheck(tabId));
}
async function searchTabCheck(tabId) {
  const tabs = await searchTabs();
  let changed = false;
  for (const t of Object.keys(tabs)) {
    if (Number(t) === tabId) continue;
    try { await chrome.tabs.get(Number(t)); } catch { delete tabs[t]; changed = true; }
  }
  const w = tabs[tabId] ? await getWatch(tabs[tabId]) : null;
  if (tabs[tabId] && !w) { delete tabs[tabId]; changed = true; } // its watch was deleted
  if (changed) await setSearchTabs(tabs);
  if (!Object.keys(tabs).length) await unregisterSearch();
  return w ? { ok: true, name: storeless(w.title || w.url, w.url) } : { ok: false };
}

// The user closed the buttons in this tab (the × on src/search.js's note).
function forgetSearchTab(tabId) {
  return searchLock(async () => {
    const tabs = await searchTabs();
    if (!(tabId in tabs)) return;
    delete tabs[tabId];
    await setSearchTabs(tabs);
    if (!Object.keys(tabs).length) await unregisterSearch();
  });
}

// One result at a time: each may open a background tab, and a user ticking five results in a row must
// not start five at once.
let searchChain = Promise.resolve();
function searchAdd(tabId, url, force) {
  const run = searchChain.then(() => addFromSearch(tabId, url, force));
  searchChain = run.catch(() => {});
  return run;
}

// A result's page joins the product group of the watch the search was opened for, which starts the
// group if it had none. A page already watched joins as it is; a new one is read first and, unless
// `force`, added only when it shows a price or stock (a review or a forum thread shows neither).
// Resolves to { status: 'self' | 'exists' | 'joined' | 'added' | 'noproduct', price, currency, stock }.
async function addFromSearch(tabId, rawUrl, force) {
  const tabs = await searchTabs();
  const anchor = tabs[tabId] ? await getWatch(tabs[tabId]) : null;
  if (!anchor) throw new Error('This search isn’t linked to a watch any more.');
  if (!/^https?:\/\//i.test(String(rawUrl))) throw new Error('Only http(s) links can be watched.');
  const url = cleanLink(rawUrl);
  const brief = (w) => ({ price: w.lastPrice ?? null, currency: w.currency || null, stock: availState(w.lastAvailability) });
  const same = Object.values(await getWatches()).find((w) => !w.selector && sameLink(w.url, url));
  if (same?.id === anchor.id) return { status: 'self' };
  if (same) {
    const was = !!same.group && same.group === anchor.group;
    await joinGroup(same.id, anchor.id);
    return { status: was ? 'exists' : 'joined', ...brief(same) };
  }
  const ex = await readLink(url);
  if (!ex || ex.status !== 'ok') throw new Error(ex?.status === 'blocked' ? 'The store blocked reading that page.' : 'Could not read that page.');
  if (!force && ex.price == null && !ex.availability) return { status: 'noproduct' };
  const w = await saveRead(url, ex, anchor.watchType || 'both');
  await joinGroup(w.id, anchor.id); // the group of the watch searched from, which starts now if it had none
  return { status: 'added', ...brief(w) };
}

// --- checking ---

// A check can take ~40s (a background tab). Re-read the watch at write time so we never resurrect a
// watch deleted mid-check, and never clobber what the user set up (interval/target/pause/type), here
// or on another computer (lib/sync.js), meanwhile.
// Points another computer recorded meanwhile are kept too (storage.js keepFreshPoints). Resolves to null
// when the watch is gone, else { superseded }: true when another computer recorded this check's new price
// and stock during the check, and so has already alerted on it.
async function saveChecked(watch) {
  let superseded = false;
  const saved = await updateWatch(watch.id, (fresh) => {
    if (!fresh) return null;
    for (const k of [...SPEC_FIELDS, 'specAt']) watch[k] = fresh[k];
    superseded = keepFreshPoints(watch, fresh);
    return watch;
  });
  return saved ? { superseded } : null;
}

// One check per watch at a time. "Check now" (or a report-wrong re-check) landing while the scheduled
// pass is on the same watch ran it twice concurrently: two tabs, the same alert twice,
// and the later save overwriting the earlier one. A second request joins the one in flight.
const inFlight = new Map();
function checkWatch(watch) {
  if (!watch) return Promise.reject(new Error('Watch not found'));
  if (inFlight.has(watch.id)) return inFlight.get(watch.id);
  const run = runCheck(watch).finally(() => inFlight.delete(watch.id));
  inFlight.set(watch.id, run);
  return run;
}

async function runCheck(watch) {
  // What Firefox hasn't allowed to leave the browser is off for this check (lib/consent.js).
  const settings = await sendable(await getSettings());
  const now = Date.now();
  const needPrice = watch.watchType !== 'availability';
  const needAvail = watch.watchType !== 'price';
  // Any tab we open auto-applies a cached per-site recipe and, when a signal this watch needs is
  // still missing and a worker is configured, derives one (once per host, then cached). Folded into
  // the tab calls so the long-tail fallback never costs an extra tab.
  const tabOpts = { derive: true, need: { price: needPrice, avail: needAvail }, settings };
  try {
    let ex = null;
    if (!watch.selector) ex = await withPageCurrency(await tryShopify(watch.url).catch(() => null), watch.url, watch.currency); // Shopify fast-path (not for area watches)
    if (!ex) ex = (watch.fetchMode === 'tab') ? await extractViaTab(watch.url, watch.selector, tabOpts) : await fetchAndExtract(watch.url);

    // A tab renders client-side price/stock (hydrated JSON-LD, the buy box, the DOM price, a per-site
    // recipe) that a raw fetch can't see — many stores expose nothing without JS. Tab failures are
    // non-fatal: the check falls back to what the static fetch read.
    // Whether a tab read this check found the recipe service could help (see extractViaTab).
    let tabOffer = ex.viaTab ? !!ex.recipeOffer : null;
    const viaTab = () => extractViaTab(watch.url, watch.selector, tabOpts)
      .then((r) => { if (r.viaTab) tabOffer = !!r.recipeOffer; return r; })
      .catch((e) => ({ status: 'error', error: e }));
    // When the static fetch is blocked or lacks a signal this watch needs, render the page in a tab.
    // Sticky 'fetch' mode skips this step: the tab has already been shown to add nothing here.
    let triedTab = false;
    const staticLacks = ex.status === 'blocked' || (needPrice && !ex.hasStructuredPrice) || (needAvail && !ex.availability);
    if (!ex.viaTab && staticLacks && watch.fetchMode !== 'fetch') {
      triedTab = true;
      const ex2 = await viaTab();
      if (ex2.status === 'ok') {
        // Adopt the tab when it read a signal the static fetch could not — a price for a price watch,
        // any deterministic availability (it is what explains a missing price, and what the popup
        // shows) — or when the fetch was walled off. Otherwise the tab adds nothing on this site: keep
        // the static result and stop paying for a tab on every check.
        const gained = ex.status === 'blocked'
          || (needPrice && !ex.hasStructuredPrice && ex2.price != null)
          || (!ex.availability && !!ex2.availability);
        if (gained) { ex = ex2; watch.fetchMode = 'tab'; }
        else watch.fetchMode = 'fetch';
      }
    }

    let res = computeFrom(ex, watch);

    // Still blocked, or still missing a needed signal after the static read, and the tab hasn't
    // been tried this check (sticky 'fetch' mode): give it one more chance. Sticky 'fetch' only meant
    // "don't open a tab when the fetch already yields what's needed" — it must not strand a watch
    // missing, say, availability on a page whose stock is rendered by JS.
    const missing = (needPrice && res.price == null) || (needAvail && res.availability == null);
    if ((ex.status === 'blocked' || missing) && !ex.viaTab && !triedTab) {
      const ex2 = await viaTab();
      if (ex2.status === 'ok') {
        const wasBlocked = ex.status === 'blocked';
        const res2 = computeFrom(ex2, watch);
        // Adopt the tab only if it supplies a signal THIS watch needs that the static read lacked.
        const tabUseful = (needPrice && res.price == null && res2.price != null)
          || (needAvail && res.availability == null && res2.availability != null)
          || (res2.availability != null && res.availability == null);
        if (wasBlocked || tabUseful) { ex = ex2; res = res2; watch.fetchMode = 'tab'; }
      }
    }

    if (ex.status === 'blocked') {
      watch.lastStatus = 'blocked'; watch.lastError = 'blocked'; watch.lastCheckedAt = now;
      await saveChecked(watch); return watch;
    }

    // Offer the recipe service on the card only while this watch still lacks a signal it needs (a
    // price missing because the product is out of stock is not lacking) and only a tab read can tell.
    if (tabOffer != null) {
      const lacking = (needPrice && res.price == null && availState(res.availability) !== 'out') || (needAvail && res.availability == null);
      watch.recipeOffer = tabOffer && lacking;
    }
    // An area watch alerts when the region it watches reads differently from the last check. A stale
    // selector (the area is gone from the page) is an error to show, not a change.
    const areaOkFinal = !watch.selector || !!ex.areaText;
    const areaChanged = !!(watch.selector && areaOkFinal && ex.textHash && watch.lastAreaHash && ex.textHash !== watch.lastAreaHash);
    if (watch.selector && areaOkFinal && ex.textHash) watch.lastAreaHash = ex.textHash;
    if (areaChanged) watch.lastSummary = excerpt(ex.areaText);
    else if (!watch.selector) watch.lastSummary = null; // left over from the retired Claude fallback
    if (!watch.selector) { const gtin = normGtin(ex.gtin); if (gtin) watch.gtin = gtin; }
    const prevPrice = lastKnownPrice(watch.history);
    const change = recordObservation(watch, { t: now, price: res.price, currency: res.currency, availability: res.availability });
    watch.lastStatus = (res.price == null && !res.availability) ? 'no_data' : 'ok';
    watch.lastCheckedAt = now;
    watch.lastError = ex.recipeError
      || (watch.selector && !areaOkFinal ? 'watched area not found (selector may be stale — re-create the area watch)' : null);
    // Fields only the retired Claude fallback used.
    delete watch.lastLlmHash; delete watch.lastOfferActive; delete watch.baselineText;

    const saved = await saveChecked(watch);
    // Availability as recorded (carried forward when this check couldn't read it), so a price move on a
    // listing last known to be unpurchasable stays quiet.
    if (saved && !saved.superseded) {
      fireNotifications(watch, { change, price: res.price, prevPrice, currency: res.currency, availability: watch.lastAvailability, areaChanged })
        .catch((e) => { console.warn('notify', e); reportBug(e); });
    }
    return watch;
  } catch (e) {
    reportBug(e);
    watch.lastStatus = 'error'; watch.lastError = String(e.message || e); watch.lastCheckedAt = now;
    await saveChecked(watch); return watch;
  }
}

// The watched area's new text, short enough for a notification and the watch's card.
function excerpt(text) {
  const t = String(text || '').trim();
  return t.length > 140 ? t.slice(0, 139).trimEnd() + '…' : t;
}

async function fireNotifications(watch, { change, price, prevPrice, currency, availability, areaChanged }) {
  if (!change && !areaChanged) return; // nothing actually changed — never repeat alerts (e.g. target-hit) every check
  const cur = currency || watch.currency || '';
  // A price on something that can't be bought right now isn't actionable — and while a product is
  // unavailable, whatever price got read is the least trustworthy (see computeFrom). Stock alerts still fire.
  const wantsPrice = watch.watchType !== 'availability' && availState(availability) !== 'out';
  const wantsAvail = watch.watchType !== 'price';
  const tgt = watch.targetPrice;
  if (change && wantsPrice && tgt != null && price != null && price <= tgt) notify(watch, `🎯 Target price hit (≤ ${tgt})`, `${priceMove(prevPrice, price, cur)} · ${watch.title}`);
  else if (wantsAvail && change === 'restock') notify(watch, '📦 Back in stock', `${watch.title} is available again.`);
  else if (wantsPrice && change === 'drop') notify(watch, await dropTitle(watch, price), `${priceMove(prevPrice, price, cur)} · ${watch.title}`);
  else if (areaChanged) notify(watch, '👀 Watched area changed', `${watch.title}: ${watch.lastSummary || 'the area you watch changed.'}`);
}

// A drop that makes a store the cheapest of its product group says so: that is the one worth acting on.
// `price` is the one the alert shows: saving may have taken a newer point synced meanwhile.
async function dropTitle(watch, price) {
  if (!watch.group) return '⬇️ Price dropped';
  const members = Object.values(await getWatches()).filter((w) => w.group === watch.group && !w.selector)
    .map((w) => (w.id === watch.id ? { ...watch, lastPrice: price } : w));
  return members.length > 1 && cheapest(members)?.id === watch.id ? `⬇️ Now cheapest at ${recipeHost(watch.url)}` : '⬇️ Price dropped';
}

function notify(watch, title, message) {
  chrome.notifications.create(`bt|${watch.id}|${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 });
}
function toast(title, message) {
  chrome.notifications.create(`bt|_|${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 });
}

// One pass at a time. A pass can outlast the 15-min tick (each tab check is ~40s, and there may be
// many watches), and stacked passes snowball concurrent hidden tabs — sustained 100% CPU. A tick or
// "check all" landing mid-pass coalesces into a single follow-up pass, keeping the strongest force
// flag, so nothing is skipped but nothing ever runs concurrently either.
let passPromise = null;
let queuedForce = null; // null = no follow-up queued; else the force flag to run it with

function checkDue(force = false) {
  if (passPromise) {
    queuedForce = (queuedForce ?? false) || force;
    return passPromise;
  }
  passPromise = (async () => {
    try {
      await checkPass(force);
      while (queuedForce != null) {
        const f = queuedForce; queuedForce = null;
        await checkPass(f);
      }
    } finally { passPromise = null; }
  })();
  return passPromise;
}

async function checkPass(force) {
  const watches = await getWatches();
  const now = Date.now();
  for (const listed of Object.values(watches)) {
    // A pass can run for many minutes: check each watch as stored now, with whatever another computer
    // has synced since the pass began (a price it already alerted on is then no change here).
    const w = await getWatch(listed.id);
    if (!w || w.paused) continue;
    if (force || now - (w.lastCheckedAt || 0) >= (w.intervalMin || 360) * 60000) {
      try { await checkWatch(w); } catch (e) { console.warn('check', w.id, e); reportBug(e); }
    }
  }
}
