import { getSettings, setSettings } from './lib/storage.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

// Always read the live manifest version so what's shown can't drift from what's packaged.
$('ver').textContent = `BuyTracker v${chrome.runtime.getManifest().version}`;

async function load() {
  const s = await getSettings();
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || 'claude-haiku-4-5';
  $('useLlmFallback').checked = s.useLlmFallback !== false;
  $('defaultIntervalMin').value = String(s.defaultIntervalMin || 360);
}

$('save').addEventListener('click', async () => {
  await setSettings({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    useLlmFallback: $('useLlmFallback').checked,
    defaultIntervalMin: Number($('defaultIntervalMin').value)
  });
  statusEl.textContent = 'Saved ✓';
  statusEl.style.color = '#34d399';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

$('test').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { statusEl.textContent = 'enter a key first'; statusEl.style.color = '#f0c674'; return; }
  statusEl.textContent = 'testing…'; statusEl.style.color = '#8b97a4';
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
    if (res.ok) { statusEl.textContent = 'key works ✓'; statusEl.style.color = '#34d399'; }
    else { const t = await res.text(); statusEl.textContent = `HTTP ${res.status}`; statusEl.style.color = '#f87171'; console.warn(t); }
  } catch (e) {
    statusEl.textContent = 'network error'; statusEl.style.color = '#f87171'; console.warn(e);
  }
});

load();
