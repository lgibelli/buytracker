import { getSettings, getWatches, putWatch, deleteWatch } from './lib/storage.js';
import { priceChartSVG } from './lib/chart.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const hintEl = document.getElementById('hint');

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

function availBadge(w) {
  if (!w.lastAvailability) return '';
  const inStock = /instock|in stock|limited/i.test(w.lastAvailability);
  return `<span class="badge ${inStock ? 'ok' : 'no_data'}">${inStock ? 'in stock' : 'out of stock'}</span>`;
}

function modeBadge(w) {
  if (w.watchType === 'availability') return '<span class="badge" title="Availability / restock watch">restock</span>';
  if (w.watchType === 'price') return '<span class="badge" title="Price watch">price</span>';
  return '';
}

function card(w) {
  const cur = w.currency || '';
  const opts = INTERVALS.map(([v, l]) => `<option value="${v}" ${w.intervalMin === v ? 'selected' : ''}>${l}</option>`).join('');
  // Surface trouble in the collapsed row so a blocked/errored watch isn't hidden behind the fold.
  const problem = (w.lastStatus && w.lastStatus !== 'ok') ? statusBadge(w) : '';
  return `<div class="card${expanded.has(w.id) ? '' : ' collapsed'}" data-id="${w.id}">
    <div class="head" data-act="toggle">
      <button class="chev" data-act="toggle" title="Show details" aria-label="Show details">▾</button>
      <div class="head-main">
        <div class="title"><a href="${esc(w.url)}" data-act="open">${esc(w.title || w.url)}</a></div>
        <div class="sub">checked ${ago(w.lastCheckedAt)}${w.paused ? ' · paused' : ''} ${problem}</div>
      </div>
      <div class="price"><div class="now">${fmt(w.lastPrice)} <span class="muted" style="font-size:11px">${esc(cur)}</span></div>${deltaHtml(w.history)}</div>
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
        <button class="iconbtn danger" data-act="delete" title="Delete" aria-label="Delete">🗑</button>
      </div>
      <div class="chart">${priceChartSVG(w.history, { currency: cur, width: 358, height: 110 })}</div>
      ${w.lastSummary ? `<div class="summary">“${esc(w.lastSummary)}”</div>` : ''}
    </div>
  </div>`;
}

async function render() {
  const [settings, watches] = await Promise.all([getSettings(), getWatches()]);
  const arr = Object.values(watches).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  hintEl.classList.toggle('hidden', !!settings.apiKey);
  if (!settings.apiKey) hintEl.innerHTML = 'No Claude API key set — the smart offer-detection fallback is off. <a href="#" id="toOpts">Add one in settings →</a>';
  emptyEl.classList.toggle('hidden', arr.length > 0);
  listEl.innerHTML = arr.map(card).join('');
}

async function busy(fn) {
  try { await fn(); } catch (e) { alert(e.message || e); }
  await render();
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
  if (e.target.id === 'toOpts') { e.preventDefault(); chrome.runtime.openOptionsPage(); return; }
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

  const watches = await getWatches();
  const w = watches[id];
  if (!w) return;

  if (act === 'open') { e.preventDefault(); chrome.tabs.create({ url: w.url }); }
  else if (act === 'check') await busy(() => chrome.runtime.sendMessage({ type: 'checkNow', id }));
  else if (act === 'pause') { w.paused = !w.paused; await putWatch(w); await render(); }
  else if (act === 'delete') { if (confirm('Delete this watch and its history?')) { await deleteWatch(id); await render(); } }
});

document.addEventListener('change', async (e) => {
  const act = e.target.dataset?.act;
  const card = e.target.closest('.card');
  if (!act || !card) return;
  const w = (await getWatches())[card.dataset.id];
  if (!w) return;
  if (act === 'interval') { w.intervalMin = Number(e.target.value); await putWatch(w); }
  else if (act === 'target') { const v = parseFloat(e.target.value); w.targetPrice = isFinite(v) ? v : null; await putWatch(w); }
});

render();
