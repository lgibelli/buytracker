import { extractFromHtml, detectBlock, fnv1a } from './lib/extract.js';
import { detectOffer } from './lib/llm.js';
import { capturePage } from './lib/capture.js';
import { pickArea } from './lib/picker.js';
import { buildSnapshot, applyRecipe, getRecipe, putRecipe, deriveRecipe, sanitizeRecipe } from './lib/recipe.js';
import {
  getSettings, getWatches, getWatch, putWatch, updateWatch, newId, recordObservation, availState, trustedPrice
} from './lib/storage.js';

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
  // First install only: open a one-screen welcome tab. Skip it on updates/reloads.
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
});
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('tick', { periodInMinutes: TICK_MIN }); setupMenus(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') checkDue().catch((e) => console.warn('tick', e)); });

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
        addAreaFromTab().catch((e) => console.warn('area', e));
        return sendResponse({ ok: true });
      }
      if (msg.type === 'checkNow') return sendResponse({ ok: true, watch: await checkWatch(await getWatch(msg.id)) });
      if (msg.type === 'checkAll') { await checkDue(true); return sendResponse({ ok: true }); }
      if (msg.type === 'reportWrong') return sendResponse({ ok: true, watch: await reportWrong(msg.id, msg.feedback) });
      sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
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
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/\/products\/[^/]+/);
  if (!m) return null;
  let res;
  try { res = await fetch(u.origin + m[0] + '.js', { credentials: 'include', headers: { Accept: 'application/json' } }); } catch { return null; }
  if (!res.ok) return null;
  let p;
  try { p = await res.json(); } catch { return null; }
  if (typeof p.available !== 'boolean' || !Array.isArray(p.variants)) return null;
  let price = p.price, available = p.available;
  const vid = u.searchParams.get('variant');
  if (vid) { const v = p.variants.find((x) => String(x.id) === String(vid)); if (v) { price = v.price; available = v.available; } }
  return {
    status: 'ok', title: p.title || null, price: price != null ? price / 100 : null, currency: null,
    availability: available ? 'InStock' : 'OutOfStock', hasStructuredPrice: price != null,
    fullText: '', areaText: null, textHash: null, viaTab: false
  };
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
    hasStructuredPrice: ex.hasStructuredPrice, fullText: ex.text, areaText: null, textHash: ex.textHash, viaTab: false, httpOk, httpStatus: status
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
    toast('💸 Daily LLM budget reached', 'Recipe derivation is paused until the quota resets. Checks keep running; derivation retries automatically tomorrow.');
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
    let recipeUsed = false, recipeDerived = false, recipeError = null;

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
    // through to the generic result + LLM fallback, same as the derivation path below.
    if (cached) { try { apply(await runInPage(tab.id, applyRecipe, [cached])); } catch (e) { recipeError = 'recipe: ' + String(e.message || e); } }

    const need = opts.need || { price: true, avail: true };
    const stillMissing = (need.price && price == null) || (need.avail && !availability);
    const s = opts.settings;
    // Derive when no recipe exists yet; only RE-derive a cached one once it's gone stale — otherwise a
    // legitimately-absent signal (e.g. price hidden while out of stock) would re-derive every check.
    const stale = cached && Date.now() - (cached.cachedAt || 0) > RECIPE_STALE_MS;
    if (recipesAllowed && opts.derive && stillMissing && s?.workerUrl && s?.workerToken && (!cached || stale)) {
      if (Date.now() < await derivePausedUntil()) {
        recipeError = 'recipe: daily LLM budget reached — retrying automatically tomorrow';
      } else {
        try {
          const snapshot = await runInPage(tab.id, buildSnapshot, [selector || null]);
          const fresh = sanitizeRecipe(await deriveRecipe({ workerUrl: s.workerUrl, token: s.workerToken, url, snapshot, force: !!cached }));
          if (fresh) { await putRecipe(url, fresh); recipeDerived = true; apply(await runInPage(tab.id, applyRecipe, [fresh])); }
        } catch (e) {
          if (e.status === 429) {
            await pauseDerivation(e.retryAfterSec);
            recipeError = 'recipe: daily LLM budget reached — retrying automatically tomorrow';
          } else {
            recipeError = 'recipe: ' + String(e.message || e);
          }
        }
      }
    }

    return {
      // A DOM-scan guess is NOT structured: on a product with no price of its own (unavailable) it is
      // some bystander's price — computeFrom holds it back so the LLM can rule on the page first.
      status: 'ok', title: result.title, price, currency, availability, priceSource,
      hasStructuredPrice: price != null && priceSource !== 'dom',
      fullText: full, areaText: area, textHash: fnv1a((area || full).slice(0, 20000)),
      viaTab: true, recipeUsed, recipeDerived, recipeError
    };
  } finally { try { await chrome.tabs.remove(tab.id); } catch { /* gone */ } }
}

// User-reported wrong result → force-re-derive this host's recipe, feeding the user's correction to
// the worker LLM as a trusted hint, then re-check the watch so the fix shows immediately. Whole-page
// watches only (a recipe describes the main product, not an area sub-region). Bypasses the weekly
// staleness cap on purpose — the user just told us the cached recipe is wrong — but still respects
// the worker's hard daily budget (429 → park until the quota resets, same as the auto-derive path).
async function reportWrong(id, feedback) {
  const watch = await getWatch(id);
  if (!watch) throw new Error('Watch not found');
  if (watch.selector) throw new Error('Reporting a wrong result works on whole-page watches, not area watches.');
  const settings = await getSettings();
  if (!settings.workerUrl || !settings.workerToken) {
    throw new Error('Set up the recipe worker in Settings first — that’s what re-derives the fix.');
  }
  if (Date.now() < await derivePausedUntil()) {
    throw new Error('Daily LLM budget reached — re-derivation retries automatically tomorrow.');
  }

  const tab = await chrome.tabs.create({ url: watch.url, active: false });
  try {
    await waitForComplete(tab.id, 35000);
    await sleep(2500);
    const snapshot = await runInPage(tab.id, buildSnapshot, [null]);
    const fresh = await deriveRecipe({ workerUrl: settings.workerUrl, token: settings.workerToken, url: watch.url, snapshot, force: true, feedback });
    if (fresh) await putRecipe(watch.url, fresh);
  } catch (e) {
    if (e.status === 429) { await pauseDerivation(e.retryAfterSec); throw new Error('Daily LLM budget reached — re-derivation retries automatically tomorrow.'); }
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

// Tier 2: cheap LLM. Runs only when there's no structured price, or a watched area changed — and,
// for whole-page watches, only when the page text actually changed since the last time we asked
// (forceLlm) so a page that will never have a structured price doesn't cost an LLM call every tick.
async function computeFrom(ex, watch, settings, forceLlm) {
  let currency = ex.currency || watch.currency || null;
  let availability = ex.availability || null;
  // Structured prices (JSON-LD / Shopify .js / site recipe) are taken as-is. A rendered-DOM guess
  // (priceSource 'dom': the most prominent currency amount on the page) is trusted only when the buy
  // box says the product is purchasable — then that amount is almost certainly its price. When it
  // isn't (unavailable, or unknown), the page may carry no price of its own and the guess is a
  // bystander's: on an unavailable amazon.pl listing it was a sponsored carousel item, and it went
  // out as a "price drop". Such a guess is held back so the LLM — told to ignore related items —
  // rules on the page first; it is used only when no LLM verdict is available at all.
  const guessOnly = ex.price != null && !ex.hasStructuredPrice && availState(availability) !== 'in';
  const guess = guessOnly ? ex.price : null;
  let price = guessOnly ? null : (ex.price ?? null);
  let newOffer = false, summary = null, llmError = null, offerChecked = false, reused = false;

  // An availability-only watch that already knows the stock state has nothing to ask the model: the
  // price it would fill is one the watch never uses, and the call was paid on every page change.
  const needsLlm = watch.selector ? true : (watch.watchType === 'availability' ? availability == null : price == null);
  const allowLlm = needsLlm && forceLlm;
  if (allowLlm && settings.useLlmFallback && settings.apiKey && (ex.fullText || ex.areaText)) {
    try {
      const r = await detectOffer({
        apiKey: settings.apiKey, model: settings.model, baselineText: watch.baselineText,
        currentText: ex.areaText || ex.fullText, lastPrice: watch.lastPrice ?? null, currency,
        // What the page itself said about stock. Told to the model so an unavailable listing reads
        // as "this product has no price right now" instead of "find me a number on this page".
        knownAvailability: availability
      });
      if (price == null) price = r.price ?? null;
      currency = r.currency || currency;
      // The LLM only FILLS a missing availability — it must never override a deterministic one. The
      // rendered buy box ("Add to cart" enabled / "sold out") reflects the selected variant far more
      // reliably than the model reading page text, which was flipping in-stock items to "out of stock".
      // Its "unknown" (the tool schema offers it) is no reading at all, not a stock state to record.
      if (availability == null) availability = availState(r.availability) ? r.availability : null;
      newOffer = !!r.new_offer;
      summary = r.summary || null;
      offerChecked = true;
    } catch (e) { llmError = 'llm: ' + String(e.message || e); }
  } else if (!watch.selector && needsLlm && !forceLlm) {
    // Page text is unchanged since the last time we asked the LLM — reuse what it told us then
    // instead of treating an unchanged, still-unstructured page as newly blank. "What it told us" is
    // the last history point, which may legitimately be no price at all (unavailable) — NOT lastPrice,
    // which is sticky for display and would resurrect the pre-outage price into the series.
    const last = (watch.history || [])[(watch.history || []).length - 1];
    price = last ? last.price : (watch.lastPrice ?? null);
    if (availability == null) availability = watch.lastAvailability || null;
    reused = true;
  }
  // No LLM verdict for this page state (not configured, no text, or the call failed) and nothing to
  // reuse: the heuristic guess is the best we have — better than recording a blank.
  if (price == null && !offerChecked && !reused) price = guess;
  // Last gate, and it covers the LLM too: a price we merely READ off the page belongs to the product
  // only if the product is purchasable (see trustedPrice). The model is asked for "the main product's
  // price" and tool_choice forces it to answer, so on an unavailable listing whose only amounts are
  // carousel neighbours' it hands back one of theirs — which then stuck as the watch's price.
  price = trustedPrice(price, { structured: ex.hasStructuredPrice, availability });
  return { price, currency, availability, newOffer, summary, llmError, offerChecked, reused };
}

// --- watch creation ---

async function saveNewWatch({ cap, selector, fetchMode, baseline, watchType = 'both' }) {
  const settings = await getSettings();
  const now = Date.now();
  const watch = {
    id: newId(), url: cap.url, title: cap.title, createdAt: now, watchType,
    currency: cap.product?.currency || null, intervalMin: settings.defaultIntervalMin, targetPrice: null,
    selector: selector || null, fetchMode, baselineText: baseline || '',
    // Seed the area hash from the baseline so the first re-check doesn't burn an LLM call.
    lastAreaHash: selector ? fnv1a((baseline || '').slice(0, 20000)) : null,
    // NOT seeded (unlike lastAreaHash): a whole-page watch should still get one LLM attempt on its
    // first real check even if the page hasn't changed since the baseline capture.
    lastLlmHash: null,
    paused: false, history: [], lastCheckedAt: now, lastStatus: 'ok', lastError: null, lastSummary: null,
    lastAvailability: cap.product?.availability || null, lastOfferActive: false
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
      // Keep where the price came from: the variant endpoint is structured, otherwise it is whatever
      // capturePage tagged it (jsonld / dom) — saveNewWatch trusts a 'dom' guess only when in stock.
      priceSource: sh.price != null ? 'shopify' : (result.product?.priceSource || null)
    };
  }
  return saveNewWatch({ cap: result, selector: null, fetchMode: 'auto', baseline: result.pageText, watchType });
}

async function addByUrl(url, watchType) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be watched.');
  let ex = await tryShopify(url).catch(() => null);
  if (!ex) ex = await fetchAndExtract(url).catch(() => null);
  if (!ex || ex.status !== 'ok') ex = await extractViaTab(url, null).catch(() => null);
  if (!ex || ex.status !== 'ok') throw new Error('Could not read that link.');
  const cap = {
    url, title: ex.title || url,
    product: (ex.price != null || ex.availability)
      ? {
        name: ex.title, price: ex.price ?? null, currency: ex.currency ?? null, availability: ex.availability ?? null,
        priceSource: ex.priceSource || (ex.hasStructuredPrice ? 'jsonld' : 'dom')
      }
      : null,
    pageText: ex.fullText || ''
  };
  return saveNewWatch({ cap, selector: null, fetchMode: ex.viaTab ? 'tab' : 'auto', baseline: cap.pageText, watchType });
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

// --- checking ---

// A check can take ~40s (tab + LLM). Re-read the watch at write time so we never resurrect a
// watch deleted mid-check, and never clobber user edits (interval/target/pause/type) made meanwhile.
async function saveChecked(watch) {
  const saved = await updateWatch(watch.id, (fresh) => {
    if (!fresh) return null;
    for (const k of ['intervalMin', 'targetPrice', 'paused', 'watchType']) watch[k] = fresh[k];
    return watch;
  });
  return !!saved;
}

// Should this check ask the LLM at all? Only when the relevant text (the watched area for an area
// watch, the whole page otherwise) differs from the hash we last evaluated it against — comparing
// against a fixed creation-time baseline would mean a page that never gets structured data pays for
// an LLM call on every single tick forever.
function forceLlmFor(watch, exResult, areaOk) {
  if (!areaOk || !exResult.textHash) return false;
  return watch.selector ? exResult.textHash !== watch.lastAreaHash : exResult.textHash !== watch.lastLlmHash;
}

// One check per watch at a time. "Check now" (or a report-wrong re-check) landing while the scheduled
// pass is on the same watch ran it twice concurrently: two tabs, two LLM calls, the same alert twice,
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
  const settings = await getSettings();
  const now = Date.now();
  const needPrice = watch.watchType !== 'availability';
  const needAvail = watch.watchType !== 'price';
  // Any tab we open auto-applies a cached per-site recipe and, when a signal this watch needs is
  // still missing and a worker is configured, derives one (once per host, then cached). Folded into
  // the tab calls so the long-tail fallback never costs an extra tab.
  const tabOpts = { derive: true, need: { price: needPrice, avail: needAvail }, settings };
  try {
    let ex = null;
    if (!watch.selector) ex = await tryShopify(watch.url).catch(() => null); // Shopify fast-path (not for area watches)
    if (!ex) ex = (watch.fetchMode === 'tab') ? await extractViaTab(watch.url, watch.selector, tabOpts) : await fetchAndExtract(watch.url);

    // A tab renders client-side price/stock (hydrated JSON-LD, the buy box, the DOM price, a per-site
    // recipe) that a raw fetch can't see — many stores expose nothing without JS. Tab failures are
    // non-fatal: the check falls back to what the static fetch read.
    const viaTab = () => extractViaTab(watch.url, watch.selector, tabOpts).catch((e) => ({ status: 'error', error: e }));
    // Deterministic before paid: when the static fetch is blocked or lacks a signal this watch needs,
    // render the page in a tab BEFORE the LLM reads anything. The old order asked the LLM to read the
    // static text first and opened the tab only if it came back empty — so a store with no JSON-LD
    // (Amazon) was priced by the LLM on every check, from raw text full of sponsored-item prices,
    // never by the deterministic page read; and a check that escalated anyway paid for two LLM calls.
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

    // A stale area selector must not force LLM diffs of the full page against the area baseline.
    const areaOk = !watch.selector || !!ex.areaText;
    let res = await computeFrom(ex, watch, settings, forceLlmFor(watch, ex, areaOk));

    // Still blocked, or still missing a needed signal after the static read + LLM, and the tab hasn't
    // been tried this check (sticky 'fetch' mode): give it one more chance. Sticky 'fetch' only meant
    // "don't open a tab when the fetch already yields what's needed" — it must not strand a watch
    // missing, say, availability on a page whose stock is rendered by JS.
    const missing = (needPrice && res.price == null) || (needAvail && res.availability == null);
    if ((ex.status === 'blocked' || missing) && !ex.viaTab && !triedTab) {
      const ex2 = await viaTab();
      if (ex2.status === 'ok') {
        const wasBlocked = ex.status === 'blocked';
        const areaOk2 = !watch.selector || !!ex2.areaText;
        const res2 = await computeFrom(ex2, watch, settings, forceLlmFor(watch, ex2, areaOk2));
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

    const areaOkFinal = !watch.selector || !!ex.areaText;
    if (watch.selector && areaOkFinal && ex.textHash) watch.lastAreaHash = ex.textHash;
    if (!watch.selector && ex.textHash) watch.lastLlmHash = ex.textHash;
    const change = recordObservation(watch, { t: now, price: res.price, currency: res.currency, availability: res.availability });
    // Edge-trigger like restock/oos: the LLM re-evaluates newOffer against the fixed creation-time
    // baseline every time it's asked, so a persistent promo would otherwise re-fire every time the
    // hash-gate above lets a check through. Only advance this on an actual fresh LLM read
    // (offerChecked) — a skipped check must not silently forget that the offer was already seen.
    const newOfferEdge = res.offerChecked && !!res.newOffer && !watch.lastOfferActive;
    if (res.offerChecked) watch.lastOfferActive = !!res.newOffer;
    watch.lastStatus = (res.price == null && !res.availability) ? 'no_data' : 'ok';
    watch.lastCheckedAt = now;
    // The summary is the LLM's account of what it read. Keep it only while it still describes the page:
    // replaced by a fresh LLM read, kept when the LLM was skipped because nothing changed (an unchanged
    // area, or reuse of its last verdict), dropped once a check is decided without it — the popup showed
    // "the page is blocked by a CAPTCHA" for weeks under a fresh JSON-LD price.
    if (res.offerChecked) watch.lastSummary = res.summary || null;
    else if (!res.reused && !watch.selector) watch.lastSummary = null;
    watch.lastError = res.llmError || ex.recipeError
      || (watch.selector && !areaOkFinal ? 'watched area not found (selector may be stale — re-create the area watch)' : null);

    const saved = await saveChecked(watch);
    // Availability as recorded (carried forward when this check couldn't read it), so a price move on a
    // listing last known to be unpurchasable stays quiet.
    if (saved) fireNotifications(watch, { change, price: res.price, currency: res.currency, availability: watch.lastAvailability, newOffer: newOfferEdge });
    return watch;
  } catch (e) {
    watch.lastStatus = 'error'; watch.lastError = String(e.message || e); watch.lastCheckedAt = now;
    await saveChecked(watch); return watch;
  }
}

function fireNotifications(watch, { change, price, currency, availability, newOffer }) {
  if (!change && !newOffer) return; // nothing actually changed — never repeat alerts (e.g. target-hit) every check
  const cur = currency || watch.currency || '';
  // A price on something that can't be bought right now isn't actionable — and while a product is
  // unavailable, whatever price got read is the least trustworthy (see computeFrom). Stock alerts still fire.
  const wantsPrice = watch.watchType !== 'availability' && availState(availability) !== 'out';
  const wantsAvail = watch.watchType !== 'price';
  const tgt = watch.targetPrice;
  if (wantsPrice && tgt != null && price != null && price <= tgt) notify(watch, '🎯 Target price hit', `${watch.title} is ${price} ${cur} (≤ ${tgt}).`);
  else if (wantsAvail && change === 'restock') notify(watch, '📦 Back in stock', `${watch.title} is available again.`);
  else if (wantsPrice && change === 'drop') notify(watch, '⬇️ Price dropped', `${watch.title} is now ${price} ${cur}.`);
  else if (wantsPrice && newOffer) notify(watch, '🏷️ New offer', `${watch.title}: ${watch.lastSummary || 'a new discount appeared.'}`);
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
  for (const w of Object.values(watches)) {
    if (w.paused) continue;
    if (force || now - (w.lastCheckedAt || 0) >= (w.intervalMin || 360) * 60000) {
      try { await checkWatch(w); } catch (e) { console.warn('check', w.id, e); }
    }
  }
}
