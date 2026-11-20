import { getWatches, updateWatch, deleteWatch, getSettings, setSettings, getUi, setUi, availState, SERVICE_URL } from './lib/storage.js';
import { recipeHost, recipeServiceFor, recipeOfferFor } from './lib/recipe.js';
import { priceChartSVG } from './lib/chart.js';
import { titleParts, storeless } from './lib/titles.js';
import { groupsOf, cheapest, groupable, joinGroup, leaveGroup, notSame, suggestedMatch } from './lib/groups.js';
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

// Which cards and product groups are expanded — kept in memory so a re-render (e.g. after "check now")
// doesn't re-collapse what the user opened. Resets to all-collapsed when the popup reopens.
const expanded = new Set();
const expandedGroups = new Set();

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5l-4.6-4.6"/></svg>';
const nameOf = (w) => storeless(w.title || w.url, w.url);
const storeOf = (w) => recipeHost(w.url) || w.url;
// A group's name: its oldest watch's product name.
const groupName = (members) => nameOf([...members].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0]);

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
// `localOnly`: the watch isn't synced to the user's other computers, because sync storage is full (lib/sync.js).
// `ctx`: what grouping needs (every watch, the groups). `member`: the card is one store of a product
// group, so it is titled by its store, and `cheapest` when it is that group's cheapest.
function card(w, tp, settings, localOnly, ctx, member = null) {
  const host = recipeHost(w.url);
  const match = member ? null : suggestedMatch(w, ctx.all, ctx.groups);
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
        <div class="title"><a href="${esc(w.url)}" data-act="open" title="${esc(w.title || w.url)}">${member
          ? `<span class="t-store">${esc(storeOf(w))}</span><span class="t-rest">${esc(nameOf(w))}</span>`
          : `<span class="t-head">${esc(tp.head)}</span>${tp.tail ? `<span class="t-tail">${esc(tp.tail)}</span>` : ''}`}</a></div>
        <div class="sub">${member ? (member.cheapest ? '<span class="cheap">cheapest</span>· ' : '') : `<span class="store">${esc(storeOf(w))}</span>· `}checked ${ago(w.lastCheckedAt)}${w.paused ? ' · paused' : ''} ${problem}</div>
      </div>
      <div class="price"><div class="now${stockState(w) === 'out' && w.lastPrice != null ? ' oos' : ''}">${fmt(w.lastPrice)} <span class="muted" style="font-size:11px">${esc(cur)}</span></div>${stockState(w) === 'out' ? '<div class="oos-tag">out of stock</div>' : deltaHtml(w.history)}</div>
      <button class="iconbtn danger del" data-act="delete" title="Delete watch" aria-label="Delete watch">🗑</button>
    </div>
    ${offer ? offerHtml(host) : ''}
    ${match ? matchHtml(match, ctx) : ''}
    <div class="detail">
      <div class="meta">
        ${statusBadge(w)}
        ${availBadge(w)}
        ${modeBadge(w)}
        ${w.selector ? '<span class="badge" title="Semantic area watch">area</span>' : ''}
        ${localOnly ? '<span class="badge no_data" title="Sync space is full, so this watch isn’t on your other computers. Deleting watches you no longer need makes room.">this computer only</span>' : ''}
        <span>checks every</span>
        <select data-act="interval">${opts}</select>
        <label>≤ <input class="target" type="number" step="0.01" placeholder="target" value="${esc(w.targetPrice ?? '')}" data-act="target"></label>
        <span style="margin-left:auto"></span>
        <button class="iconbtn" data-act="check" title="Check now" aria-label="Check now">↻</button>
        <button class="iconbtn" data-act="pause" title="${w.paused ? 'Resume' : 'Pause'}" aria-label="${w.paused ? 'Resume' : 'Pause'}">${w.paused ? '▶' : '⏸'}</button>
      </div>
      <div class="chart">${priceChartSVG(w.history, { currency: cur, width: member ? 316 : 338, height: 110 })}</div>
      ${groupable(w) ? groupingHtml(w, ctx, !!member) : ''}
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

// Two watches whose pages state the same EAN: ask whether they're one product. Under the head, so a
// collapsed card shows it too.
function matchHtml(o, ctx) {
  const n = o.group && ctx.groups.has(o.group) ? ctx.groups.get(o.group).length : 0;
  const where = n ? `${esc(groupName(ctx.groups.get(o.group)))} (${n} stores)` : `${esc(nameOf(o))} at ${esc(storeOf(o))}`;
  return `<div class="offer match">
      <p>Same EAN as ${where}. The same product?</p>
      <div class="offer-row">
        <button class="primary" data-act="same" data-other="${esc(o.id)}" type="button">Group them</button>
        <button class="offer-no" data-act="notsame" data-other="${esc(o.id)}" type="button">No</button>
      </div>
    </div>`;
}

// Finding the product in other stores, and grouping it with a watch of another store by hand. A group's
// stores search from the group's head instead, and each can leave it.
function groupingHtml(w, ctx, member) {
  if (member) return '<div class="grouping"><button class="linkbtn" data-act="ungroup" type="button">Not the same product? Take it out of this group</button></div>';
  const opts = [];
  for (const ms of ctx.groups.values()) opts.push(`<option value="${esc(ms[0].id)}">${esc(groupName(ms))} (${ms.length} stores)</option>`);
  for (const o of ctx.all) {
    if (o.id === w.id || !groupable(o) || (o.group && ctx.groups.has(o.group))) continue;
    opts.push(`<option value="${esc(o.id)}">${esc(nameOf(o))} · ${esc(storeOf(o))}</option>`);
  }
  return `<div class="grouping">
      <button data-act="find" type="button" title="Search Google for this product, and add other stores from the results">${SEARCH_ICON} Find in other stores</button>
      ${opts.length ? `<select data-act="group" aria-label="Group with another watch of the same product"><option value="">Same product as…</option>${opts.join('')}</select>` : ''}
    </div>`;
}

// A product watched at several stores: one card with the cheapest price you can buy at now, and the
// stores inside, cheapest first.
function groupCard(gid, members, tp, settings, localOnly, ctx) {
  const best = cheapest(members);
  // The search starts from a store whose page gave the EAN (it finds the exact product), else the oldest.
  const from = members.find((m) => m.gtin) || [...members].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  // No price to compare (restock watches, or nothing read yet): say where it can be bought, if anywhere.
  const inStock = members.find((m) => stockState(m) === 'in');
  const sub = `${members.length} stores · ` + (best ? `cheapest at ${esc(storeOf(best))}`
    : inStock ? `in stock at ${esc(storeOf(inStock))}`
    : members.every((m) => stockState(m) === 'out') ? 'none available now' : 'no price yet');
  // A store whose check fails says so on the collapsed group too, as a lone watch's card does.
  const failing = members.filter((m) => m.lastStatus && m.lastStatus !== 'ok');
  const problem = failing.length === 1 ? statusBadge(failing[0]).replace('title="', `title="${esc(storeOf(failing[0]))}: `)
    : failing.length ? `<span class="badge error" title="${esc(failing.map(storeOf).join(', '))}">${failing.length} stores: check failed</span>` : '';
  return `<div class="group${expandedGroups.has(gid) ? '' : ' collapsed'}" data-group="${esc(gid)}">
    <div class="head" data-act="gtoggle">
      <button class="chev" data-act="gtoggle" title="Show stores" aria-label="Show stores">▾</button>
      <div class="head-main">
        <div class="title"><span class="t-head">${esc(tp.head)}</span>${tp.tail ? `<span class="t-tail">${esc(tp.tail)}</span>` : ''}</div>
        <div class="sub">${problem ? problem + ' ' : ''}${sub}</div>
      </div>
      <div class="price"><div class="now">${best ? fmt(best.lastPrice) : '—'} <span class="muted" style="font-size:11px">${esc(best?.currency || '')}</span></div><div class="delta muted">best price</div></div>
      <button class="iconbtn find" data-act="find" data-id="${esc(from.id)}" title="Find in other stores" aria-label="Find in other stores">${SEARCH_ICON}</button>
    </div>
    <div class="members">${members.map((m) => card(m, null, settings, localOnly.has(m.id), ctx, { cheapest: m === best })).join('')}</div>
  </div>`;
}

async function render() {
  // As the checks see them: in Firefox, stores allowed before it was asked show their offer again.
  const [watches, settings, ui, { syncState }] = await Promise.all([getWatches(), getSettings().then(sendable), getUi(), chrome.storage.local.get('syncState')]);
  const localOnly = new Set(settings.syncWatches !== false ? syncState?.localOnly || [] : []);
  const all = Object.values(watches);
  emptyEl.classList.toggle('hidden', all.length > 0);
  // A product group is one item, placed by its newest store; every other watch is one of its own.
  const groups = groupsOf(watches);
  const items = [...groups].map(([gid, members]) => ({ gid, members }));
  for (const w of all) if (!(w.group && groups.has(w.group))) items.push({ w });
  const newest = (it) => (it.w ? it.w.createdAt || 0 : Math.max(...it.members.map((m) => m.createdAt || 0)));
  items.sort((a, b) => newest(b) - newest(a));
  // Cards are titled by product, without the store's name (it is on the line below). Sibling listings
  // (e.g. the 256 GB and 512 GB of one product) get the words that tell them apart pinned after their
  // shared, ellipsized start.
  const parts = titleParts(items.map((it) => (it.w ? nameOf(it.w) : groupName(it.members))));
  const ctx = { all, groups };
  // Every value card() puts in this HTML goes through esc(), or is a number the extension computed;
  // the chart filters the page-supplied currency itself (chart.js). MV3's page CSP blocks inline script.
  listEl.innerHTML = items.map((it, i) => (it.w
    ? card(it.w, parts[i], settings, localOnly.has(it.w.id), ctx)
    : groupCard(it.gid, it.members, parts[i], settings, localOnly, ctx))).join('');
  maybeShowTour(ui);
}

// First popup open: a tour of the toolbar (lib/tour.js). Ending it any way but closing the popup counts
// as seen. Its last step continues on the Settings page (options.js), through ui.settingsTour.
let touring = false;
function maybeShowTour(ui) {
  if (ui.seenTour || touring) return;
  touring = true;
  const $ = (id) => document.getElementById(id);
  const firstCard = () => listEl.querySelector(':scope > .card, :scope > .group');
  startTour([
    { target: () => $('add'), title: 'Watch a product',
      text: 'On a product page, press <b>Watch this page</b>. BuyTracker keeps checking its price and stock, and notifies you when the price drops or it’s back in stock.' },
    { target: () => $('addArea'), title: 'Or just one part of a page',
      text: 'Press <b>Area</b>, then click a price, a coupon or a banner: you’re notified when that part changes. Right-clicking a page or a link works too.' },
    ...(firstCard() ? [{ target: firstCard, title: 'Your watches',
      text: 'Click a watch to see its price history, set a target price, change how often it’s checked, find it in other stores, or report a wrong price.' }] : []),
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
  if (!actEl) return;
  const act = actEl.dataset.act;

  if (act === 'gtoggle') {
    const g = actEl.closest('.group');
    g.classList.toggle('collapsed');
    if (g.classList.contains('collapsed')) expandedGroups.delete(g.dataset.group); else expandedGroups.add(g.dataset.group);
    return;
  }
  // Opens a Google search in a new tab, which closes the popup; the service worker sets the tab up.
  if (act === 'find') {
    const fid = actEl.dataset.id || card?.dataset.id;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'findElsewhere', id: fid });
      if (r && !r.ok) throw new Error(r.error || 'could not open the search');
    } catch (err) { toast(err.message || String(err)); }
    return;
  }
  if (!card) return;
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

  if (act === 'same') { await busy(() => joinGroup(id, actEl.dataset.other)); return; }
  if (act === 'notsame') { await busy(() => notSame(id, actEl.dataset.other)); return; }
  if (act === 'ungroup') { await busy(() => leaveGroup(id)); return; }

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
  else if (act === 'group' && e.target.value) {
    // The group opens, so the watch is seen to land in it.
    const gid = await joinGroup(id, e.target.value).catch((err) => { toast(err.message || String(err)); return null; });
    if (gid) expandedGroups.add(gid);
    await render();
  }
});

render();
