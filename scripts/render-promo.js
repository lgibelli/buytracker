// Renders the Chrome Web Store promo tiles from their HTML sources in store-assets/promo/ with headless
// Chrome (see chrome.js). The tiles use macOS system fonts (Avenir Next, DIN Alternate); elsewhere Chrome
// substitutes a fallback, so render on a Mac. The store wants JPEG or 24-bit PNG without alpha: the tiles
// paint an opaque background, so Chrome writes RGB PNGs — checked below.
const fs = require('fs');
const path = require('path');
const { screenshot } = require('./chrome');

const ASSETS = path.join(__dirname, '..', 'store-assets');
const TILES = [
  { src: 'small.html', width: 440, height: 280, out: 'promo-small-440x280.png' },
  { src: 'marquee.html', width: 1400, height: 560, out: 'promo-marquee-1400x560.png' },
];

for (const { src, width, height, out } of TILES) {
  const file = path.join(ASSETS, out);
  screenshot(path.join(ASSETS, 'promo', src), width, height, file);
  const png = fs.readFileSync(file);
  // IHDR: width @16, height @20, bit depth @24, colour type @25 (2 = RGB, no alpha).
  const [w, h, depth, type] = [png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]];
  if (w !== width || h !== height || depth !== 8 || type !== 2) {
    throw new Error(`${out}: got ${w}×${h}, ${depth}-bit colour type ${type}; want ${width}×${height} 8-bit RGB`);
  }
  console.log(`${out} ← promo/${src} (${width}×${height}, 24-bit RGB)`);
}
