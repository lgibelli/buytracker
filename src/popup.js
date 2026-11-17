import { getWatches, updateWatch, deleteWatch, getSettings, setSettings, getUi, setUi, availState, SERVICE_URL } from './lib/storage.js';
import { recipeHost, recipeServiceFor, recipeOfferFor } from './lib/recipe.js';
import { priceChartSVG } from './lib/chart.js';
import { titleParts } from './lib/titles.js';
import { installErrorReporting } from './lib/report.js';
import { ask, sendable, PAGE_DATA } from './lib/consent.js';
import { startTour } from './lib/tour.js';

installErrorReporting('popup');

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const PRIVACY = SERVICE_URL + '/privacy#recipes';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? '—' : Number.isInteger(n) ? n : n.toFixed(2));

function ago(t) {
  if (!t) return 'never';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

// Which cards are expanded — kept in memory so a re-render (e.g. after "check now")
// doesn't re-collapse what the user opened. Resets to all-collapsed when the popup reopens.
const expanded = new Set();

const INTERVALS = [[60, '1h'], [180, '3h'], [360, '6h'], [720, '12h'], [1440, '1d'], [4320, '3d']];

function deltaHtml(history) {
  const h = (history || []).filter((p) => p.price != null);
  if (h.length < 2) return '<span class="delta muted">new</span>';
  const last = h[h.length - 1].price, prev = h[h.length - 2].price;
  if (last === prev) return '';
  const d = last - prev, pct = prev ? (d / prev) * 100 : 0;
  const cls = d < 0 ? 'down' : 'up';
  const arrow = d < 0 ? '▼' : '▲';
  return `<span class="delta ${cls}">${arrow} ${fmt(Math.abs(d))} (${Math.abs(pct).toFixed(0)}%)</span>`;
}

function statusBadge(w) {
  const s = w.lastStatus || 'ok';
  const label = { ok: 'ok', blocked: 'blocked', error: 'error', no_data: 'no price' }[s] || s;
  return `<span class="badge ${esc(s)}" title="${esc(w.lastError || '')}">${label}</span>`;
}

// 'in' | 'out' | null (unknown). Delegates to the canonical availState in storage.js so the popup
// can never diverge from how the history/notification layer classifies the same string — the exact
// bug where a schema.org `OnlineOnly` (in stock) was shown as "out of stock".
const stockState = (w) => availState(w.lastAvailability);

function availBadge(w) {
  const s = stockState(w);
  if (!s) return '';
  return `<span class="badge ${s === 'in' ? 'ok' : 'no_data'}">${s === 'in' ? 'in stock' : 'out of stock'}</span>`;
}

function modeBadge(w) {
  if (w.watchType === 'availability') return '<span class="badge" title="Availability / restock watch">restock</span>';
  if (w.watchType === 'price') return '<span class="badge" title="Price watch">price</span>';
  return '';
}

// The headline price is `lastPrice`, which is sticky across checks that read nothing — but it is
// cleared once a product is known unpurchasable with no price of its own (see recordObservation),
// so the card reads "—" rather than presenting a stale number as this product's current price.
// Card for a store BuyTracker can't read on its own: offer the free recipe service for that store.
// Nothing about the store is sent until the user presses Allow (see recipeServiceFor).
function offerHtml(host) {
  return `<div class="offer">
      <p>BuyTracker can't read this store on its own. The free recipe creator can work out how, once; after that, checks run in your browser.</p>
      <div class="offer-row">
        <button class="primary" data-act="offer-allow" type="button">Allow for ${esc(host)}</button>
        <button class="offer-no" data-act="offer-decline" type="button">No thanks</button>
        <span class="report-status"></span>
      </div>
      <p class="report-fine">Sends this page's address (without anything after “?”) and a short extract: its title, prices, buttons and opening text. Nothing about you. <a href="${PRIVACY}" data-act="link">Details</a></p>
    </div>`;
}

// `canFix`: a report can re-derive this store's recipe (the free service is on, or the user runs their
// own worker); without that it can only go to the developer. `ask`: submitting also allows the free
// service for this store, so the form says so.
function card(w, tp, settings) {
  const host = recipeHost(w.url);
  const canFix = !!settings.workerUrl || settings.recipeService !== false;
  const ask = canFix && !recipeServiceFor(settings, w.url, SERVICE_URL);
  const offer = w.recipeOffer && !w.selector && recipeOfferFor(settings, w.url);
  const cur = w.currency || '';
  const opts = INTERVALS.map(([v, l]) => `<option value="${v}" ${w.intervalMin === v ? 'selected' : ''}>${l}</option>`).join('');
  // Surface trouble in the collapsed row so a blocked/errored watch isn't hidden behind the fold.
  const problem = (w.lastStatus && w.lastStatus !== 'ok') ? statusBadge(w) : '';
  return `<div class="card${expanded.has(w.id) ? '' : ' collapsed'}" data-id="${esc(w.id)}">
    <div class="head" data-act="toggle">
      <button class="chev" data-act="toggle" title="Show details" aria-label="Show details">▾</button>
      <div class="head-main">
        <div class="title"><a href="${esc(w.url)}" data-act="open" title="${esc(w.title || w.url)}"><span class="t-head">${esc(tp.head)}</span>${tp.tail ? `<span class="t-tail">${esc(tp.tail)}</span>` : ''}</a></div>
        <div class="sub">checked ${ago(w.lastCheckedAt)}${w.paused ? ' · paused' : ''} ${problem}</div>
      </div>
      <div class="price"><div class="now${stockState(w) === 'out' && w.lastPrice != null ? ' oos' : ''}">${fmt(w.lastPrice)} <span class="muted" style="font-size:11px">${esc(cur)}</span></div>${stockState(w) === 'out' ? '<div class="oos-tag">out of stock</div>' : deltaHtml(w.history)}</div>
      <button class="iconbtn danger del" data-act="delete" title="Delete watch" aria-label="Delete watch">🗑</button>
    </div>
    ${offer ? offerHtml(host) : ''}
    <div class="detail">
      <div class="meta">
        ${statusBadge(w)}
        ${availBadge(w)}
        ${modeBadge(w)}
        ${w.selector ? '<span class="badge" title="Semantic area watch">area</span>' : ''}
        <span>checks every</span>
        <select data-act="interval">${opts}</select>
        <label>≤ <input class="target" type="number" step="0.01" placeholder="target" value="${esc(w.targetPrice ?? '')}" data-act="target"></label>
        <span style="margin-left:auto"></span>
        <button class="iconbtn" data-act="check" title="Check now" aria-label="Check now">↻</button>
        <button class="iconbtn" data-act="pause" title="${w.paused ? 'Resume' : 'Pause'}" aria-label="${w.paused ? 'Resume' : 'Pause'}">${w.paused ? '▶' : '⏸'}</button>
      </div>
      <div class="chart">${priceChartSVG(w.history, { currency: cur, width: 338, height: 110 })}</div>
      ${w.lastSummary ? `<div class="summary">“${esc(w.lastSummary)}”</div>` : ''}
      ${w.selector ? '' : `<div class="report">
        <button class="report-open" data-act="report-open" type="button">${canFix ? 'Wrong result? Report &amp; fix' : 'Wrong result? Report it'}</button>
        <div class="report-form hidden"${canFix ? ' data-fix="1"' : ''}${ask ? ' data-allow="1"' : ''}>
          <div class="seg">
            <button type="button" data-act="report-choice" data-fb="in">In stock</button>
            <button type="button" data-act="report-choice" data-fb="out">Out of stock</button>
            <button type="button" data-act="report-choice" data-fb="price">Wrong price</button>
          </div>
          <input class="report-price hidden" type="number" step="0.01" inputmode="decimal" placeholder="correct price">
          <input class="report-note" type="text" maxlength="300" placeholder="optional hint: where should it look? (e.g. the price on the right)">
          ${ask ? `<p class="report-fine">Submitting allows the free recipe creator for ${esc(host)}: it gets this page's address (without anything after “?”) and a short extract of it (title, prices, buttons, opening text), to work out the fix. <a href="${PRIVACY}" data-act="link">Details</a></p>` : ''}
          ${canFix ? '<label class="report-send"><input type="checkbox"> Also send this report to the developer</label>' : ''}
          <p class="report-fine">${canFix ? 'If ticked, BuyTracker' : 'BuyTracker'} sends the page address (without anything after “?”), what it read here, and your correction. No account, no ID.</p>
          <div class="report-row">
            <button class="report-submit primary" data-act="report-submit" type="button">${canFix ? 'Submit &amp; re-derive' : 'Send to the developer'}</button>
            <span class="report-status"></span>
          </div>
        </div>
      </div>`}
    </div>
  </div>`;
}

async function render() {
  // As the checks see them: in Firefox, stores allowed before it was asked show their offer again.
  const [watches, settings, ui] = await Promise.all([getWatches(), getSettings().then(sendable), getUi()]);
  const arr = Object.values(watches).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  emptyEl.classList.toggle('hidden', arr.length > 0);
  // Sibling listings (e.g. the 256 GB and 512 GB of one product) get the words that tell them apart
  // pinned after their shared, ellipsized start.
  const parts = titleParts(arr.map((w) => w.title || w.url));
  // Every value card() puts in this HTML goes through esc(), or is a number the extension computed;
  // the chart filters the page-supplied currency itself (chart.js). MV3's page CSP blocks inline script.
  listEl.innerHTML = arr.map((w, i) => card(w, parts[i], settings)).join('');
  maybeShowTour(ui);
}

// First popup open: a tour of the toolbar (lib/tour.js). Ending it any way but closing the popup counts
// as seen. Its last step continues on the Settings page (options.js), through ui.settingsTour.
let touring = false;
function maybeShowTour(ui) {
  if (ui.seenTour || touring) return;
  touring = true;
  const $ = (id) => document.getElementById(id);
  const firstCard = () => listEl.querySelector('.card');
  startTour([
    { target: () => $('add'), title: 'Watch a product',
      text: 'On a product page, press <b>Watch this page</b>. BuyTracker keeps checking its price and stock, and notifies you when the price drops or it’s back in stock.' },
    { target: () => $('addArea'), title: 'Or just one part of a page',
      text: 'Press <b>Area</b>, then click a price, a coupon or a banner: you’re notified when that part changes. Right-clicking a page or a link works too.' },
    ...(firstCard() ? [{ target: firstCard, title: 'Your watches',
      text: 'Click a watch to see its price history, set a target price, change how often it’s checked, or report a wrong price.' }] : []),
    { target: () => $('checkAll'), title: 'Check now',
      text: 'Watches are checked on their own while your browser is open. This checks them all right away.' },
    { target: () => $('opts'), title: 'Settings',
      text: 'Choose how often new watches are checked, and help fix bugs by sending error reports.',
      primary: { label: 'Show me', action: openSettingsTour } },
  ], { fitHeight: true, done: () => setUi({ seenTour: true }) });
}

async function openSettingsTour() {
  await setUi({ seenTour: true, settingsTour: true });
  await chrome.runtime.openOptionsPage();
  window.close();
}

// The user's answer for a store. Allowing takes it off the declined list too (they can change their mind
// in Settings, or by submitting a report).
async function answerFor(host, allow) {
  const s = await getSettings();
  const hosts = new Set(s.recipeHosts || []), declined = new Set(s.recipeDeclined || []);
  if (allow) { hosts.add(host); declined.delete(host); } else { declined.add(host); }
  await setSettings({ recipeHosts: [...hosts], recipeDeclined: [...declined] });
}

// A message along the bottom of the popup. Not alert(): Firefox can't show one in a popup.
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

async function busy(fn) {
  try { await fn(); } catch (e) { toast(e.message || String(e)); }
  await render();
}

const NOT_ALLOWED = 'Firefox didn’t allow sending page data, so nothing was sent.';

// What the report form says is wrong, or null (with a hint shown) when it says nothing yet.
function readFeedback(form) {
  const choice = form.dataset.choice || null;
  const note = form.querySelector('.report-note').value.trim();
  const feedback = { note: note || null };
  if (choice === 'in' || choice === 'out') feedback.correct_availability = choice;
  else if (choice === 'price') {
    const p = parseFloat(form.querySelector('.report-price').value);
    if (isFinite(p)) feedback.correct_price = p;
  }
  if (!feedback.correct_availability && feedback.correct_price == null && !feedback.note) {
    const statusEl = form.querySelector('.report-status');
    statusEl.className = 'report-status warn'; statusEl.textContent = 'Pick what’s wrong, or add a note.';
    return null;
  }
  return feedback;
}

// Send a user correction for a watch. With the user's own worker, its LLM re-derives the site's recipe
// and the watch is re-checked: ~40s (tab + LLM), and the SW finishes even if the popup closes. It also
// goes to the developer if the box is ticked. Without a worker, sending it to the developer is all
// Submit does: pressing "Send to the developer" is the consent.
// `consent` is Firefox's answer, asked in the click itself (see the click handler).
async function submitReport(card, id, host, feedback, consent) {
  const form = card.querySelector('.report-form');
  const canFix = !!form.dataset.fix;
  const send = canFix ? form.querySelector('.report-send input').checked : true;
  const statusEl = form.querySelector('.report-status');
  if (!(await consent)) { statusEl.className = 'report-status warn'; statusEl.textContent = NOT_ALLOWED; return; }
  const btn = form.querySelector('.report-submit');
  btn.disabled = true;
  statusEl.className = 'report-status'; statusEl.textContent = canFix ? 're-deriving… (you can close this)' : 'sending…';
  try {
    if (form.dataset.allow) await answerFor(host, true);
    const r = await chrome.runtime.sendMessage({ type: 'reportWrong', id, feedback, send });
    if (!r?.ok) throw new Error(r?.error || (canFix ? 'failed to re-derive' : 'failed to send'));
    if (canFix) { await render(); return; } // reflects the corrected check
    statusEl.className = 'report-status ok'; statusEl.textContent = 'Sent. Thanks, this helps fix this store.';
  } catch (e) {
    btn.disabled = false;
    statusEl.className = 'report-status err'; statusEl.textContent = e.message || String(e);
  }
}

document.getElementById('add').addEventListener('click', () =>
  busy(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'addCurrentTab' });
    if (!r?.ok) throw new Error(r?.error || 'failed to add');
  }));

document.getElementById('addArea').addEventListener('click', async () => {
  // Wait for the SW to acknowledge (and start the picker) BEFORE closing — closing immediately
  // tears down the popup's renderer and drops the message, so the picker never launches.
  try { await chrome.runtime.sendMessage({ type: 'addAreaFromTab' }); } catch { /* closing */ }
  window.close();
});

document.getElementById('checkAll').addEventListener('click', () =>
  busy(() => chrome.runtime.sendMessage({ type: 'checkAll' })));

document.getElementById('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('click', async (e) => {
  const actEl = e.target.closest('[data-act]');
  const card = e.target.closest('.card');
  if (!actEl || !card) return;
  const act = actEl.dataset.act;
  const id = card.dataset.id;

  if (act === 'toggle') {
    card.classList.toggle('collapsed');
    if (card.classList.contains('collapsed')) expanded.delete(id); else expanded.add(id);
    return;
  }

  // Report-wrong form is pure DOM until Submit — handle it before touching storage.
  if (act === 'report-open') {
    actEl.classList.add('hidden');
    card.querySelector('.report-form').classList.remove('hidden');
    return;
  }
  if (act === 'report-choice') {
    const form = card.querySelector('.report-form');
    form.dataset.choice = actEl.dataset.fb;
    form.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b === actEl));
    form.querySelector('.report-price').classList.toggle('hidden', actEl.dataset.fb !== 'price');
    return;
  }
  // Both of these send page data. Firefox opens its own consent prompt only for a request made inside
  // the click, before anything is awaited, so they ask here (lib/consent.js; in Chrome it's just yes).
  let consent = null, feedback = null;
  if (act === 'report-submit') {
    feedback = readFeedback(card.querySelector('.report-form'));
    if (!feedback) return;
    consent = ask(PAGE_DATA);
  }
  if (act === 'offer-allow') consent = ask(PAGE_DATA);

  const watches = await getWatches();
  const w = watches[id];
  if (!w) return;
  const host = recipeHost(w.url);

  if (act === 'report-submit') { await submitReport(card, id, host, feedback, consent); return; }
  if (act === 'link') { e.preventDefault(); chrome.tabs.create({ url: actEl.href }); return; }
  if (act === 'offer-allow') {
    // Allowed: re-check now, which derives this store's recipe (~10-40 s: tab + model). The service
    // worker finishes the check even if the popup closes.
    const offer = card.querySelector('.offer');
    offer.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const st = offer.querySelector('.report-status');
    if (!(await consent)) {
      offer.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      st.className = 'report-status warn'; st.textContent = NOT_ALLOWED;
      return;
    }
    st.className = 'report-status'; st.textContent = 'learning this store… (you can close this)';
    await answerFor(host, true);
    try {
      const r = await chrome.runtime.sendMessage({ type: 'checkNow', id });
      if (r && !r.ok) throw new Error(r.error || 'check failed');
      await render();
    } catch (err) { st.className = 'report-status err'; st.textContent = err.message || String(err); }
    return;
  }
  if (act === 'offer-decline') { await answerFor(host, false); await render(); return; }

  if (act === 'open') { e.preventDefault(); chrome.tabs.create({ url: w.url }); }
  else if (act === 'check') await busy(() => chrome.runtime.sendMessage({ type: 'checkNow', id }));
  else if (act === 'pause') { await updateWatch(id, (cur) => cur && { ...cur, paused: !cur.paused }); await render(); }
  else if (act === 'delete') {
    // The first click arms the button and a second one deletes. Not confirm(): Firefox can't show one
    // in a popup.
    if (actEl.classList.contains('armed')) { await deleteWatch(id); await render(); return; }
    actEl.classList.add('armed');
    actEl.textContent = 'Delete?';
    actEl.title = 'Click again to delete this watch and its history';
    setTimeout(() => { actEl.classList.remove('armed'); actEl.textContent = '🗑'; actEl.title = 'Delete watch'; }, 4000);
  }
});

document.addEventListener('change', async (e) => {
  const act = e.target.dataset?.act;
  const card = e.target.closest('.card');
  if (!act || !card) return;
  // Edit the stored watch, not the copy this popup rendered from: a check may have saved new results
  // since, and writing the rendered copy back would undo them.
  const id = card.dataset.id;
  if (act === 'interval') { const v = Number(e.target.value); await updateWatch(id, (cur) => cur && { ...cur, intervalMin: v }); }
  else if (act === 'target') { const v = parseFloat(e.target.value); await updateWatch(id, (cur) => cur && { ...cur, targetPrice: isFinite(v) ? v : null }); }
});

render();
