// Wiring for the first-run welcome tab (opened once on install by background.js).
import { getSettings, setSettings } from './lib/storage.js';
import { browserAsks } from './lib/consent.js';

document.getElementById('ver').textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('done').addEventListener('click', () => window.close());

// Firefox asks about error reports in its own install prompt (lib/consent.js), so the switch is shown
// only where BuyTracker's own setting decides.
if (!browserAsks()) {
  const box = document.getElementById('sendErrorReports');
  getSettings().then((s) => { box.checked = !!s.sendErrorReports; document.getElementById('errs').hidden = false; });
  box.addEventListener('change', () => setSettings({ sendErrorReports: box.checked }));
}
