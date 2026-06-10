import { getSettings, getWatches, putWatch, deleteWatch } from './lib/storage.js';
import { priceChartSVG } from './lib/chart.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const hintEl = document.getElementById('hint');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? '—' : Number.isInteger(n) ? n : n.toFixed(2));

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
  return `<div class="card" data-id="${w.id}">
    <div class="top">
      <div class="title"><a href="${esc(w.url)}" data-act="open">${esc(w.title || w.url)}</a></div>
      <div class="price"><div class="now">${fmt(w.lastPrice)} <span class="muted" style="font-size:11px">${esc(cur)}</span></div>${deltaHtml(w.history)}</div>
    </div>
    <div class="meta">
      ${statusBadge(w)}
      ${availBadge(w)}
      ${modeBadge(w)}
      ${w.selector ? '<span class="badge" title="Semantic area watch">area</span>' : ''}
      <span>checks every</span>
      <select data-act="interval">${opts}</select>
      <label>≤ <input class="target" type="number" step="0.01" placeholder="target" value="${w.targetPrice ?? ''}" data-act="target"></label>
      <span style="margin-left:auto"></span>
      <button class="linkbtn" data-act="check">check now</button>
      <button class="linkbtn" data-act="pause">${w.paused ? 'resume' : 'pause'}</button>
      <button class="linkbtn" data-act="delete">delete</button>
    </div>
    <div class="chart">${priceChartSVG(w.history, { currency: cur, width: 358, height: 110 })}</div>
    ${w.lastSummary ? `<div class="summary">“${esc(w.lastSummary)}”</div>` : ''}
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

document.getElementById('addArea').addEventListener('click', () => {
  // Fire-and-forget: the picker runs in the page; close the popup so the user can click.
  chrome.runtime.sendMessage({ type: 'addAreaFromTab' }).catch(() => {});
  window.close();
});

document.getElementById('checkAll').addEventListener('click', () =>
  busy(() => chrome.runtime.sendMessage({ type: 'checkAll' })));

document.getElementById('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('click', async (e) => {
  if (e.target.id === 'toOpts') { e.preventDefault(); chrome.runtime.openOptionsPage(); return; }
  const act = e.target.dataset?.act;
  const card = e.target.closest('.card');
  if (!act || !card) return;
  const id = card.dataset.id;
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
