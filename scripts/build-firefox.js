// Builds the Firefox package, buytracker-firefox.zip, from the same source as the Chrome one. Only the
// manifest differs:
//   - background: Firefox doesn't run extension service workers, so the same module is an event page
//   - options_ui in place of options_page
//   - browser_specific_settings.gecko: the add-on id (permanent once on addons.mozilla.org) and what
//     the add-on may send off the device. Firefox asks the user for that itself; src/lib/consent.js
//     asks and checks, and that is also how the code knows it runs in Firefox.
// Usage: node scripts/build-firefox.js   then check it with:   npx web-ext lint -s dist/firefox
// No npm deps; zips with the system `zip`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'firefox');
const zipPath = path.join(root, 'buytracker-firefox.zip');

const GECKO_ID = 'buytracker@salamacchine.it';

const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
m.background = { scripts: [m.background.service_worker], type: m.background.type };
m.options_ui = { page: m.options_page, open_in_tab: true };
delete m.options_page;
m.browser_specific_settings = {
  gecko: {
    id: GECKO_ID,
    // 140: the first Firefox with data_collection_permissions (and MAIN-world scripting, from 128).
    strict_min_version: '140.0',
    data_collection_permissions: {
      // Nothing is needed to use BuyTracker. Page data (a page address and an extract: the recipe
      // service, the user's own worker or Claude key, wrong-result reports) is asked for when the user
      // first chooses one of those; error reports have their own switch. Keep in step with consent.js.
      required: ['none'],
      optional: ['websiteContent', 'browsingActivity', 'technicalAndInteraction']
    }
  }
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const dir of ['src', 'icons']) {
  fs.cpSync(path.join(root, dir), path.join(out, dir), { recursive: true, filter: (f) => path.basename(f) !== '.DS_Store' });
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE')); // the GPL goes with every copy
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-qrX', zipPath, '.'], { cwd: out });
console.log(`Built ${path.relative(root, zipPath)} (v${m.version}, ${GECKO_ID}) from ${path.relative(root, out)}/`);
