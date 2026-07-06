import { getSettings, setSettings } from './lib/storage.js';

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

// Worker "connection" indicator reflects only what we can know without a network call:
// both fields present = configured; a successful Test upgrades it to Connected.
function refreshWorkerConn() {
  const url = $('workerUrl').value.trim();
  const token = $('workerToken').value.trim();
  if (url && token) chip($('workerConn'), 'set', 'Configured');
  else chip($('workerConn'), '', 'Not set up');
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
  refreshWorkerConn();
  // If they're already using the experimental Claude path, don't hide their key behind a disclosure.
  if (s.apiKey) $('expClaude').open = true;
}

$('workerUrl').addEventListener('input', refreshWorkerConn);
$('workerToken').addEventListener('input', refreshWorkerConn);

$('save').addEventListener('click', async () => {
  await setSettings({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    useLlmFallback: $('useLlmFallback').checked,
    defaultIntervalMin: Number($('defaultIntervalMin').value),
    workerUrl: $('workerUrl').value.trim().replace(/\/+$/, ''),
    workerToken: $('workerToken').value.trim()
  });
  refreshWorkerConn();
  statusEl.textContent = 'Saved ✓';
  statusEl.style.color = 'var(--green)';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

$('testWorker').addEventListener('click', async () => {
  const ws = $('workerStatus');
  const url = $('workerUrl').value.trim().replace(/\/+$/, '');
  const token = $('workerToken').value.trim();
  if (!url || !token) { chip(ws, 'warn', 'enter URL + token first'); return; }
  chip(ws, '', 'testing…');
  try {
    // GET with a throwaway host: 404 = reachable & authed (just no recipe), 401 = bad token.
    const res = await fetch(`${url}/recipe?host=connectivity-check.invalid`, { headers: { authorization: 'Bearer ' + token } });
    if (res.status === 404) { chip(ws, 'ok', 'reachable, token OK'); chip($('workerConn'), 'ok', 'Connected'); }
    else if (res.status === 401) { chip(ws, 'err', 'token rejected (401)'); }
    else { chip(ws, 'err', `unexpected HTTP ${res.status}`); }
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
