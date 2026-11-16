import { getWatches, updateWatch, deleteWatch, getSettings, getUi, setUi, availState } from './lib/storage.js';
import { priceChartSVG } from './lib/chart.js';
import { titleParts } from './lib/titles.js';
import { installErrorReporting } from './lib/report.js';

installErrorReporting('popup');

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const tipEl = document.getElementById('tip');

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
// `canFix`: the user has their own recipe worker, so a report re-derives the fix; without one, a report
// can only go to the developer.
function card(w, tp, canFix) {
  const cur = w.currency || '';
  const opts = INTERVALS.map(([v, l]) => `<option value="${v}" ${w.intervalMin === v ? 'selected' : ''}>${l}</option>`).join('');
  // Surface trouble in the collapsed row so a blocked/errored watch isn't hidden behind the fold.
  const problem = (w.lastStatus && w.lastStatus !== 'ok') ? statusBadge(w) : '';
  return `<div class="card${expanded.has(w.id) ? '' : ' collapsed'}" data-id="${w.id}">
    <div class="head" data-act="toggle">
      <button class="chev" data-act="toggle" title="Show details" aria-label="Show details">▾</button>
      <div class="head-main">
        <div class="title"><a href="${esc(w.url)}" data-act="open" title="${esc(w.title || w.url)}"><span class="t-head">${esc(tp.head)}</span>${tp.tail ? `<span class="t-tail">${esc(tp.tail)}</span>` : ''}</a></div>
        <div class="sub">checked ${ago(w.lastCheckedAt)}${w.paused ? ' · paused' : ''} ${problem}</div>
      </div>
      <div class="price"><div class="now${stockState(w) === 'out' && w.lastPrice != null ? ' oos' : ''}">${fmt(w.lastPrice)} <span class="muted" style="font-size:11px">${esc(cur)}</span></div>${stockState(w) === 'out' ? '<div class="oos-tag">out of stock</div>' : deltaHtml(w.history)}</div>
      <button class="iconbtn danger del" data-act="delete" title="Delete watch" aria-label="Delete watch">🗑</button>
    </div>
    <div class="detail">
      <div class="meta">
        ${statusBadge(w)}
        ${availBadge(w)}
        ${modeBadge(w)}
        ${w.selector ? '<span class="badge" title="Semantic area watch">area</span>' : ''}
        <span>checks every</span>
        <select data-act="interval">${opts}</select>
        <label>≤ <input class="target" type="number" step="0.01" placeholder="target" value="${w.targetPrice ?? ''}" data-act="target"></label>
        <span style="margin-left:auto"></span>
        <button class="iconbtn" data-act="check" title="Check now" aria-label="Check now">↻</button>
        <button class="iconbtn" data-act="pause" title="${w.paused ? 'Resume' : 'Pause'}" aria-label="${w.paused ? 'Resume' : 'Pause'}">${w.paused ? '▶' : '⏸'}</button>
      </div>
      <div class="chart">${priceChartSVG(w.history, { currency: cur, width: 338, height: 110 })}</div>
      ${w.lastSummary ? `<div class="summary">“${esc(w.lastSummary)}”</div>` : ''}
      ${w.selector ? '' : `<div class="report">
        <button class="report-open" data-act="report-open" type="button">${canFix ? 'Wrong result? Report &amp; fix' : 'Wrong result? Report it'}</button>
        <div class="report-form hidden"${canFix ? ' data-fix="1"' : ''}>
          <div class="seg">
            <button type="button" data-act="report-choice" data-fb="in">In stock</button>
            <button type="button" data-act="report-choice" data-fb="out">Out of stock</button>
            <button type="button" data-act="report-choice" data-fb="price">Wrong price</button>
          </div>
          <input class="report-price hidden" type="number" step="0.01" inputmode="decimal" placeholder="correct price">
          <input class="report-note" type="text" maxlength="300" placeholder="optional hint: where should it look? (e.g. the price on the right)">
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
  const [watches, settings, ui] = await Promise.all([getWatches(), getSettings(), getUi()]);
  const arr = Object.values(watches).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  emptyEl.classList.toggle('hidden', arr.length > 0);
  // Sibling listings (e.g. the 256 GB and 512 GB of one product) get the words that tell them apart
  // pinned after their shared, ellipsized start.
  const parts = titleParts(arr.map((w) => w.title || w.url));
  const canFix = !!(settings.workerUrl && settings.workerToken);
  listEl.innerHTML = arr.map((w, i) => card(w, parts[i], canFix)).join('');

  // Just-in-time hint: only once a real watch shows a store BuyTracker couldn't read on its own,
  // and only while neither fallback (worker or Claude key) is configured, and not yet dismissed.
  const configured = canFix || !!settings.apiKey;
  const hasUnreadable = arr.some((w) => w.lastStatus === 'no_data' || w.lastStatus === 'blocked');
  tipEl.classList.toggle('hidden', ui.dismissedWorkerHint || configured || !hasUnreadable);

  maybeShowTour(ui);
}

// First-ever popup open: show a one-time coachmark pointing at the toolbar.
function maybeShowTour(ui) {
  if (ui.seenTour) return;
  document.getElementById('tour').classList.remove('hidden');
}

document.getElementById('tourGo').addEventListener('click', async () => {
  document.getElementById('tour').classList.add('hidden');
  await setUi({ seenTour: true });
});

document.getElementById('tipSettings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('tipX').addEventListener('click', async () => {
  tipEl.classList.add('hidden');
  await setUi({ dismissedWorkerHint: true });
});

async function busy(fn) {
  try { await fn(); } catch (e) { alert(e.message || e); }
  await render();
}

// Send a user correction for a watch. With the user's own worker, its LLM re-derives the site's recipe
// and the watch is re-checked: ~40s (tab + LLM), and the SW finishes even if the popup closes. It also
// goes to the developer if the box is ticked. Without a worker, sending it to the developer is all
// Submit does: pressing "Send to the developer" is the consent.
async function submitReport(card, id) {
  const form = card.querySelector('.report-form');
  const canFix = !!form.dataset.fix;
  const send = canFix ? form.querySelector('.report-send input').checked : true;
  const statusEl = form.querySelector('.report-status');
  const choice = form.dataset.choice || null;
  const note = form.querySelector('.report-note').value.trim();
  const feedback = { note: note || null };
  if (choice === 'in' || choice === 'out') feedback.correct_availability = choice;
  else if (choice === 'price') {
    const p = parseFloat(form.querySelector('.report-price').value);
    if (isFinite(p)) feedback.correct_price = p;
  }
  if (!feedback.correct_availability && feedback.correct_price == null && !feedback.note) {
    statusEl.className = 'report-status warn'; statusEl.textContent = 'Pick what’s wrong, or add a note.';
    return;
  }
  const btn = form.querySelector('.report-submit');
  btn.disabled = true;
  statusEl.className = 'report-status'; statusEl.textContent = canFix ? 're-deriving… (you can close this)' : 'sending…';
  try {
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
  if (act === 'report-submit') { await submitReport(card, id); return; }

  const watches = await getWatches();
  const w = watches[id];
  if (!w) return;

  if (act === 'open') { e.preventDefault(); chrome.tabs.create({ url: w.url }); }
  else if (act === 'check') await busy(() => chrome.runtime.sendMessage({ type: 'checkNow', id }));
  else if (act === 'pause') { await updateWatch(id, (cur) => cur && { ...cur, paused: !cur.paused }); await render(); }
  else if (act === 'delete') { if (confirm('Delete this watch and its history?')) { await deleteWatch(id); await render(); } }
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
