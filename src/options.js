import { getSettings, setSettings } from './lib/storage.js';
import { installErrorReporting } from './lib/report.js';
import { browserAsks, granted, ask, revoke, PAGE_DATA, ERRORS } from './lib/consent.js';

installErrorReporting('options');

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

// Render a status chip (dot + label) into one of the .chip spans.
const chip = (el, cls, text) => {
  el.className = 'chip' + (cls ? ' ' + cls : '');
  el.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  el.append(dot, document.createTextNode(text));
};

// The stores the user answered for on a watch's card: allowed ones can be removed (nothing more is
// sent about them), declined ones asked again. Either way the answer is forgotten at once.
async function renderHosts() {
  const s = await getSettings();
  const rows = [...(s.recipeHosts || []).map((h) => [h, true]), ...(s.recipeDeclined || []).map((h) => [h, false])]
    .sort((a, b) => a[0].localeCompare(b[0]));
  const list = $('recipeHosts');
  list.textContent = '';
  for (const [host, allowed] of rows) {
    const li = document.createElement('li');
    const h = document.createElement('span'); h.className = 'h'; h.textContent = host;
    const st = document.createElement('span'); st.className = 'state' + (allowed ? '' : ' no'); st.textContent = allowed ? 'allowed' : 'declined';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = allowed ? 'Remove' : 'Ask again';
    b.addEventListener('click', async () => {
      const cur = await getSettings();
      await setSettings({
        recipeHosts: (cur.recipeHosts || []).filter((x) => x !== host),
        recipeDeclined: (cur.recipeDeclined || []).filter((x) => x !== host)
      });
      renderHosts();
    });
    li.append(h, st, b);
    list.append(li);
  }
  $('recipeHostsNone').hidden = rows.length > 0;
}

// Always read the live manifest version so what's shown can't drift from what's packaged.
$('ver').textContent = `v${chrome.runtime.getManifest().version}`;

async function load() {
  const s = await getSettings();
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || 'claude-haiku-4-5';
  $('useLlmFallback').checked = s.useLlmFallback !== false;
  $('defaultIntervalMin').value = String(s.defaultIntervalMin || 360);
  $('workerUrl').value = s.workerUrl || '';
  $('workerToken').value = s.workerToken || '';
  $('recipeService').checked = s.recipeService !== false;
  // In Firefox the switch is Firefox's own permission for error reports (also offered while installing).
  $('sendErrorReports').checked = browserAsks() ? await granted(ERRORS) : !!s.sendErrorReports;
  // Don't hide a setup they already use behind a disclosure.
  if (s.apiKey) $('expClaude').open = true;
  if (s.workerUrl) $('expWorker').open = true;
  renderHosts();
}

// In Firefox the error-report switch acts at once: it asks for, or gives back, Firefox's permission.
// (The prompt opens only from inside the click.)
$('sendErrorReports').addEventListener('click', (e) => {
  if (!browserAsks()) return;
  if (e.target.checked) ask(ERRORS).then((ok) => { e.target.checked = ok; });
  else revoke(ERRORS);
});

$('save').addEventListener('click', async () => {
  // A Claude key or a worker of their own sends pages, so Firefox has to allow it. Asked before
  // anything is awaited, for the same reason as above.
  const consent = ($('apiKey').value.trim() || $('workerUrl').value.trim()) ? ask(PAGE_DATA) : null;
  await setSettings({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    useLlmFallback: $('useLlmFallback').checked,
    defaultIntervalMin: Number($('defaultIntervalMin').value),
    workerUrl: $('workerUrl').value.trim().replace(/\/+$/, ''),
    workerToken: $('workerToken').value.trim(),
    recipeService: $('recipeService').checked,
    sendErrorReports: $('sendErrorReports').checked
  });
  if (consent && !(await consent)) {
    statusEl.textContent = 'Saved, but Firefox didn’t allow sending page data, so the Claude API and your own worker stay off.';
    statusEl.style.color = 'var(--amber)';
    return;
  }
  statusEl.textContent = 'Saved ✓';
  statusEl.style.color = 'var(--green)';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

$('testWorker').addEventListener('click', async () => {
  const ws = $('workerStatus');
  const url = $('workerUrl').value.trim().replace(/\/+$/, '');
  const token = $('workerToken').value.trim();
  if (!url) { chip(ws, 'warn', 'enter the worker URL first'); return; }
  chip(ws, '', 'testing…');
  try {
    // A throwaway host: 404 = a recipe worker answering (it just has no recipe for it).
    const res = await fetch(`${url}/recipe?host=connectivity-check.invalid`);
    if (res.status !== 404) { chip(ws, 'err', `not a recipe worker (HTTP ${res.status})`); return; }
    if (!token) { chip(ws, 'ok', 'reachable'); return; }
    // The token unlocks the operator endpoints: 200 = accepted, 401 = rejected.
    const auth = await fetch(`${url}/reports?limit=1`, { headers: { authorization: 'Bearer ' + token } });
    if (auth.status === 401) chip(ws, 'err', 'reachable, token rejected');
    else chip(ws, auth.ok ? 'ok' : 'warn', auth.ok ? 'reachable, token OK' : `reachable, token check HTTP ${auth.status}`);
  } catch (e) { chip(ws, 'err', 'cannot reach worker'); console.warn(e); }
});

$('test').addEventListener('click', async () => {
  const as = $('apiStatus');
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { chip(as, 'warn', 'enter a key first'); return; }
  chip(as, '', 'testing…');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: $('model').value, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] })
    });
    if (res.ok) { chip(as, 'ok', 'key works'); }
    else { const t = await res.text(); chip(as, 'err', `HTTP ${res.status}`); console.warn(t); }
  } catch (e) { chip(as, 'err', 'network error'); console.warn(e); }
});

load();
