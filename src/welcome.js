// Wiring for the first-run welcome tab (opened once on install by background.js).
document.getElementById('ver').textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('done').addEventListener('click', () => window.close());
