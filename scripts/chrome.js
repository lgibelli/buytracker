// Headless-Chrome screenshots for the asset scripts (extension icons, store promo tiles). Node only,
// no npm deps. Chrome is looked up in the usual install locations; set CHROME=/path/to/chrome to override.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const env = process.env;
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
      .map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  }[process.platform] || [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found — set CHROME=/path/to/chrome');
  return found;
}

// Renders an HTML file at width×height CSS px (scale 1) to a PNG at `out`. With `transparent`, what the
// page leaves unpainted stays transparent (RGBA PNG); otherwise Chrome paints it white and writes a
// 24-bit RGB PNG with no alpha channel.
function screenshot(htmlFile, width, height, out, { transparent = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-shot-'));
  const shot = path.join(tmp, 'shot.png');
  try {
    execFileSync(findChrome(), [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(tmp, 'profile')}`, // never touches a running Chrome's profile
      '--force-device-scale-factor=1', '--virtual-time-budget=2000',
      ...(transparent ? ['--default-background-color=00000000'] : []),
      `--window-size=${width},${height}`, `--screenshot=${shot}`, pathToFileURL(htmlFile).href,
    ], { stdio: 'ignore' });
    if (!fs.existsSync(shot)) throw new Error(`Chrome wrote no screenshot of ${htmlFile}`);
    fs.copyFileSync(shot, out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { findChrome, screenshot };
