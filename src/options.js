import { getSettings, setSettings, getUi, setUi } from './lib/storage.js';
import { installErrorReporting } from './lib/report.js';
import { browserAsks, granted, ask, revoke, PAGE_DATA, ERRORS } from './lib/consent.js';
import { startTour } from './lib/tour.js';

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
  $('defaultIntervalMin').value = String(s.defaultIntervalMin || 360);
  $('workerUrl').value = s.workerUrl || '';
  $('workerToken').value = s.workerToken || '';
  $('recipeService').checked = s.recipeService !== false;
  $('syncWatches').checked = s.syncWatches !== false;
  renderSync();
  // In Firefox the switch is Firefox's own permission for error reports (also offered while installing).
  $('sendErrorReports').checked = browserAsks() ? await granted(ERRORS) : !!s.sendErrorReports;
  // The experimental section stays collapsed even when it's in use; its summary says so instead.
  showWorkerInUse(s.workerUrl);
  renderHosts();
}

// What the last sync pass did (lib/sync.js keeps it in syncState).
async function renderSync() {
  const el = $('syncStatus');
  const [{ syncWatches }, { syncState: st }] = await Promise.all([getSettings(), chrome.storage.local.get('syncState')]);
  if (syncWatches === false) return chip(el, '', 'off on this computer');
  if (!st?.at) return chip(el, '', 'not synced yet');
  if (st.error) return chip(el, 'err', 'couldn’t sync: ' + st.error);
  const n = st.shared || 0;
  const kb = st.bytes != null ? ` · ${Math.ceil(st.bytes / 1024)} KB of 100 KB used` : '';
  if (st.full) return chip(el, 'warn', `${n} watch${n === 1 ? '' : 'es'} shared · sync space is full, so ${st.localOnly.length} stay${st.localOnly.length === 1 ? 's' : ''} on this computer only`);
  chip(el, 'ok', `${n} watch${n === 1 ? '' : 'es'} shared${kb}`);
}

function showWorkerInUse(url) {
  $('workerInUse').textContent = url ? 'in use: your own recipe worker' : 'your own recipe worker';
}

// In Firefox the error-report switch acts at once: it asks for, or gives back, Firefox's permission.
// (The prompt opens only from inside the click.)
$('sendErrorReports').addEventListener('click', (e) => {
  if (!browserAsks()) return;
  if (e.target.checked) ask(ERRORS).then((ok) => { e.target.checked = ok; });
  else revoke(ERRORS);
});

$('save').addEventListener('click', async () => {
  // A worker of their own gets page extracts, so Firefox has to allow it. Asked before anything is
  // awaited, for the same reason as above.
  const workerUrl = $('workerUrl').value.trim().replace(/\/+$/, '');
  const consent = workerUrl ? ask(PAGE_DATA) : null;
  await setSettings({
    defaultIntervalMin: Number($('defaultIntervalMin').value),
    workerUrl,
    workerToken: $('workerToken').value.trim(),
    recipeService: $('recipeService').checked,
    syncWatches: $('syncWatches').checked,
    sendErrorReports: $('sendErrorReports').checked
  });
  renderSync();
  showWorkerInUse(workerUrl);
  if (consent && !(await consent)) {
    statusEl.textContent = 'Saved, but Firefox didn’t allow sending page data, so your own worker stays off.';
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

// The second half of the popup's tour, when its last step sends the user here (popup.js). Settings may
// already be open in a tab, which the browser then only brings forward: hence the storage listener.
let touring = false;
async function maybeTour() {
  if (touring || !(await getUi()).settingsTour) return;
  touring = true;
  await setUi({ settingsTour: false });
  const on = $('sendErrorReports').checked;
  startTour([
    { target: () => $('defaultIntervalMin').closest('.field'), interactive: true, title: 'How often to check',
      text: 'New watches are checked this often while your browser is open. To change one watch, open its card in the popup.' },
    { target: () => $('sendErrorReports').closest('.section'), interactive: true, title: 'Help fix bugs',
      text: `${on ? 'Please keep error reports on.' : 'Please consider turning error reports on.'} When BuyTracker’s own code breaks, the developer learns what failed and can fix it. Never your watches or the pages you visit, and no account or ID.` },
    { target: () => $('save'), interactive: true, title: 'Save',
      text: 'Changed something? Press <b>Save changes</b> to keep it.' },
  ], { done: () => { touring = false; } });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ui?.newValue?.settingsTour) maybeTour();
  if (area === 'local' && changes.syncState) renderSync();
});

load().then(maybeTour);
