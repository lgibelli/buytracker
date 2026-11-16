// Renders the extension's PNG icons from the SVG marks with headless Chrome (see chrome.js).
//
//   icons/logo.svg       → icon32.png, icon48.png, icon128.png
//   icons/logo-small.svg → icon16.png (the mark hand-tuned to the 16px pixel grid)
//
// The 128px icon keeps the Chrome Web Store's transparent margin (96px of art, 16px each side); 48 and
// 32 are inset by 2px and 1px; 16 is full-bleed. Re-run after editing either SVG.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { screenshot } = require('./chrome');

const ICONS = path.join(__dirname, '..', 'icons');
const TARGETS = [
  { size: 128, inset: 16, src: 'logo.svg' },
  { size: 48, inset: 2, src: 'logo.svg' },
  { size: 32, inset: 1, src: 'logo.svg' },
  { size: 16, inset: 0, src: 'logo-small.svg' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-icons-'));
try {
  for (const { size, inset, src } of TARGETS) {
    const art = size - 2 * inset;
    const page = path.join(tmp, `icon${size}.html`);
    // The SVG goes in as an <img> inside a page sized to the icon: rendering the bare SVG file as the
    // top-level document sometimes produced a blank 128px capture.
    fs.writeFileSync(page, `<!DOCTYPE html><html><body style="margin:0"><img src="${pathToFileURL(path.join(ICONS, src))}" style="display:block;width:${art}px;height:${art}px;margin:${inset}px"></body></html>`);
    screenshot(page, size, size, path.join(ICONS, `icon${size}.png`), { transparent: true });
    console.log(`icon${size}.png ← ${src} (${art}px art, ${inset}px inset)`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
