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
    // 0. availState maps the full schema.org ItemAvailability enum (pure unit, no browser).
    //    Guards the OnlineOnly→"out of stock" regression and keeps popup display == history state.
    const { availState } = await import(require('url').pathToFileURL(path + '/src/lib/storage.js').href);
    const AVAIL_CASES = [
      ['InStock', 'in'], ['OnlineOnly', 'in'], ['InStoreOnly', 'in'], ['LimitedAvailability', 'in'],
      ['MadeToOrder', 'in'], ['http://schema.org/OnlineOnly', 'in'], ['in stock', 'in'],
      ['OutOfStock', 'out'], ['SoldOut', 'out'], ['Discontinued', 'out'], ['PreOrder', 'out'],
      ['PreSale', 'out'], ['BackOrder', 'out'], ['out of stock', 'out'],
      ['', null], ['unknown', null], [null, null], ['Reserved', null]
    ];
    const availBad = AVAIL_CASES.filter(([s, want]) => availState(s) !== want);
    console.log(availBad.length === 0
      ? `OK: availState maps all ${AVAIL_CASES.length} enum cases (OnlineOnly→in, unknown→null)`
      : (fail('availState: ' + availBad.map(([s]) => `${JSON.stringify(s)}→${availState(s)}`).join(', ')), ''));

    // 0b. recordObservation precedence: an in→out transition is 'oos' even when the price collapses.
    //     This is what keeps an unavailable listing from ever reading as a "price drop".
    const { recordObservation } = await import(require('url').pathToFileURL(path + '/src/lib/storage.js').href);
    const w0 = { history: [] };
    recordObservation(w0, { t: 1, price: 2199, currency: 'PLN', availability: 'InStock' });
    const kindOos = recordObservation(w0, { t: 2, price: null, currency: 'PLN', availability: 'OutOfStock' });
    console.log(kindOos === 'oos' ? 'OK: recordObservation in→out with price gone = oos (not drop)' : (fail(`recordObservation kind=${kindOos}`), ''));

    // 0b2. trustedPrice: an amount only READ off the page (DOM scan or LLM) is the product's own
    //      price only while the product is purchasable. Regression for "ECOVACS WINBOT W3 … 18.99 PLN":
    //      the listing was "Chwilowo niedostępne" and had no price at all, so every zł on it belonged
    //      to a sponsored/carousel neighbour — and the LLM, forced by tool_choice to answer, returned one.
    const { trustedPrice } = await import(require('url').pathToFileURL(path + '/src/lib/storage.js').href);
    const TRUST_CASES = [
      [18.99, { structured: false, availability: 'OutOfStock' }, null],   // carousel price on a dead listing
      [18.99, { structured: false, availability: 'InStock' }, 18.99],     // purchasable → the guess is its price
      [18.99, { structured: false, availability: null }, 18.99],          // unknown stock → not our call to void it
      [1950.61, { structured: true, availability: 'OutOfStock' }, 1950.61], // a schema.org offer is the product's own
      [null, { structured: true, availability: 'InStock' }, null]
    ];
    const trustBad = TRUST_CASES.filter(([p, o, want]) => trustedPrice(p, o) !== want);
    console.log(trustBad.length === 0
      ? `OK: trustedPrice voids a read-off-the-page price only when unpurchasable (${TRUST_CASES.length} cases)`
      : (fail('trustedPrice: ' + trustBad.map(([p, o]) => `${p}/${o.availability}→${trustedPrice(p, o)}`).join(', ')), ''));

    // 0b3. …and once it is voided, the card must stop showing the old number. lastPrice stays sticky
    //      across a check that simply read nothing, but not for a product known to have no price.
    const w1 = { history: [], lastPrice: null };
    recordObservation(w1, { t: 1, price: 18.99, currency: 'PLN', availability: null });
    recordObservation(w1, { t: 2, price: null, currency: 'PLN', availability: null });
    const stickyOk = w1.lastPrice === 18.99;
    recordObservation(w1, { t: 3, price: null, currency: 'PLN', availability: 'OutOfStock' });
    console.log(stickyOk ? 'OK: lastPrice stays sticky through a check that read nothing' : (fail(`lastPrice=${w1.lastPrice} after a blank check`), ''));
    console.log(w1.lastPrice === null ? 'OK: lastPrice cleared once the product is out of stock with no price' : (fail(`lastPrice=${w1.lastPrice} on OOS with no price`), ''));

    // 0c. capturePage against a reduced mirror of an UNAVAILABLE amazon.pl listing (see the fixture's
    //     header). Regression for the "⬇️ Price dropped … is now 211 PLN" false alert: the product had
    //     no price and no buy button, "Chwilowo niedostępne." was plain text the English-only fallback
    //     didn't read, and the DOM price scan picked the cheapest sponsored-carousel item.
    const { capturePage } = await import(require('url').pathToFileURL(path + '/src/lib/capture.js').href);
    const fixture = (name) => require('url').pathToFileURL(path + '/test/fixtures/' + name).href;
    const fx = await ctx.newPage();
    await fx.goto(fixture('amazon-pl-unavailable.html'));
    const capOut = (await fx.evaluate(capturePage, null)).product || {};
    console.log(/outofstock/i.test(capOut.availability || '') ? 'OK: amazon.pl "Chwilowo niedostępne." → OutOfStock' : (fail(`unavailable fixture availability=${capOut.availability}`), ''));
    console.log(capOut.price == null ? 'OK: no bystander (carousel/sponsored) price reported for the unavailable product' : (fail(`unavailable fixture price=${capOut.price} (${capOut.priceSource})`), ''));
    //     …and the in-stock control: the main price wins over cheaper carousel prices, buy box → InStock,
    //     and the price is tagged as a DOM guess (only structured sources are trusted without the LLM).
    await fx.goto(fixture('amazon-pl-instock.html'));
    const capIn = (await fx.evaluate(capturePage, null)).product || {};
    //     The fixture writes it "1950,61zł" (no thousands separator, as amazon.pl really does), which
    //     an optional-separator amount pattern truncated to 195.
    console.log(capIn.price === 1950.61 && capIn.currency === 'PLN' ? 'OK: in-stock control → 1950.61 PLN (main price, not truncated, not a carousel one)' : (fail(`instock fixture price=${capIn.price} ${capIn.currency}`), ''));
    console.log(/instock/i.test(capIn.availability || '') ? 'OK: in-stock control → InStock via "Dodaj do koszyka"' : (fail(`instock fixture availability=${capIn.availability}`), ''));
    console.log(capIn.priceSource === 'dom' ? 'OK: rendered-DOM price tagged priceSource=dom' : (fail(`instock fixture priceSource=${capIn.priceSource}`), ''));

    // 0d. The recipe layer, against the exact recipe the worker derived for amazon.pl and then cached
    //     for weeks. Its in_stock_selector matched Amazon's HIDDEN keyboard-shortcut "Dodaj do koszyka"
    //     button — present on every page, sold out or not — so the listing read InStock, which is what
    //     let a price be believed at all; its price_selector pointed into the #sp_detail sponsored
    //     rail, so each check reported whichever cheap item was loaded there (18.99 / 47.23 / 114.97).
    const { applyRecipe, sanitizeRecipe } = await import(require('url').pathToFileURL(path + '/src/lib/recipe.js').href);
    const BAD_RECIPE = {
      v: 1, host: 'amazon.pl', currency_code: 'PLN',
      in_stock_selector: "button[id*='add-to-cart'], [aria-label*='Dodaj do koszyka']",
      price_selector: '#sp_detail_B0GVG5YWXS > div:nth-of-type(3) > a > span > span'
    };
    await fx.goto(fixture('amazon-pl-unavailable.html'));
    const applied = await fx.evaluate(applyRecipe, BAD_RECIPE);
    console.log(applied.availability === null ? 'OK: a hidden add-to-cart control gives a recipe no stock signal' : (fail(`recipe availability=${applied.availability} from a hidden control`), ''));
    console.log(applied.price == null ? 'OK: a recipe selector resolving into a sponsored rail yields no price' : (fail(`recipe price=${applied.price} from a rail`), ''));
    const clean = sanitizeRecipe(BAD_RECIPE);
    console.log(clean.price_selector === null ? 'OK: sanitizeRecipe drops a rail-scoped price_selector' : (fail(`sanitizeRecipe kept ${clean.price_selector}`), ''));
    const asin = sanitizeRecipe({ price_selector: '#dp_B0CS1DQPR9 .a-price .a-offscreen' }).price_selector;
    console.log(asin === null ? 'OK: …and one pinned to a single product id (a host-wide recipe cannot use it)' : (fail(`sanitizeRecipe kept ${asin}`), ''));
    //     …while a sound recipe must still resolve, hidden-attribute sources included.
    await fx.goto(fixture('amazon-pl-instock.html'));
    const good = await fx.evaluate(applyRecipe, { price_selector: '#corePrice_feature_div .a-offscreen', currency_code: 'PLN', in_stock_selector: '#add-to-cart-button' });
    console.log(good.price === 1950.61 && good.availability === 'InStock' ? 'OK: a sound recipe still resolves price + stock' : (fail(`sound recipe → ${JSON.stringify(good)}`), ''));
    await fx.close();

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
