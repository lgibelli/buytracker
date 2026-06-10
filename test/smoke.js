const { chromium } = require('playwright');
const path = require("path").resolve(__dirname, "..");

(async () => {
  const ctx = await chromium.launchPersistentContext(require('os').tmpdir() + '/buytracker-test-profile', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };

  try {
    // 1. Service worker boots (manifest + ES module imports OK)
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log('OK: service worker booted', sw.url());

    // 2. Alarm registered
    await new Promise((r) => setTimeout(r, 1500));
    const alarms = await sw.evaluate(() => chrome.alarms.getAll());
    console.log(alarms.some((a) => a.name === 'tick') ? 'OK: tick alarm registered' : (fail('no tick alarm'), ''));

    // 3. Popup renders without console errors
    const popup = await ctx.newPage();
    const errs = [];
    popup.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    popup.on('pageerror', (e) => errs.push(String(e)));
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.waitForTimeout(800);
    const emptyVisible = await popup.locator('#empty').isVisible();
    console.log(errs.length === 0 ? 'OK: popup renders, zero console errors' : (fail('popup errors: ' + errs.join(' | ')), ''));
    console.log(emptyVisible ? 'OK: empty state shown (no watches yet)' : (fail('empty state not visible'), ''));

    // 4. Options page renders
    const opts = await ctx.newPage();
    const oerrs = [];
    opts.on('pageerror', (e) => oerrs.push(String(e)));
    await opts.goto(`chrome-extension://${extId}/src/options.html`);
    await opts.waitForTimeout(500);
    console.log(oerrs.length === 0 ? 'OK: options page renders' : (fail('options errors: ' + oerrs.join(' | ')), ''));

    // 5. END-TO-END: open the real magbak product page (currently OOS) and add a watch for it.
    const prod = await ctx.newPage();
    await prod.goto('https://eu.magbak.com/products/magbak-phone-mount-and-charger-for-tesla-25w', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await prod.waitForTimeout(3000);
    await prod.bringToFront();
    const resp = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'addCurrentTab' }));
    if (!resp || !resp.ok) { fail('addCurrentTab: ' + JSON.stringify(resp)); }
    else {
      const w = resp.watch;
      console.log(`OK: watch created — title="${(w.title || '').slice(0, 50)}…"`);
      const point = (w.history || [])[0] || {};
      const availOk = /outofstock/i.test(point.availability || '');
      const priceOk = point.price === 87.95;
      console.log(priceOk ? 'OK: captured price 87.95' : (fail(`price=${point.price}`), ''));
      console.log(availOk ? 'OK: captured availability OutOfStock (restock watch armed)' : (fail(`availability=${point.availability}`), ''));

      // 6. checkNow exercises the Shopify fast-path from the service worker
      const r2 = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'checkNow', id }), w.id);
      if (!r2 || !r2.ok) fail('checkNow: ' + JSON.stringify(r2));
      else {
        const w2 = r2.watch;
        console.log(`OK: checkNow ran — status=${w2.lastStatus} price=${w2.lastPrice} avail=${w2.lastAvailability} points=${w2.history.length}`);
        if (w2.lastStatus !== 'ok' || w2.lastPrice !== 87.95) fail('checkNow unexpected result');
        if (w2.history.length !== 1) fail(`history grew on no-change: ${w2.history.length} points`);
        else console.log('OK: no-change check appended no history point (step-series invariant)');
      }
    }

    console.log(process.exitCode ? '--- SMOKE TEST: FAILURES ABOVE ---' : '--- SMOKE TEST: ALL PASS ---');
  } catch (e) {
    fail('exception: ' + (e.stack || e));
  } finally {
    await ctx.close();
  }
})();
