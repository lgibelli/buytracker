# BuyTracker

A personal, browser-based price/offer watcher. It runs in **your** browser on **your** home
connection, so it sees real (logged-in, region-correct) prices and gets past bot walls that block
datacenter scrapers. Smart enough to read structured prices deterministically and fall back to a
cheap LLM (Claude Haiku 4.5) when a page has no structured data. Keeps a **CamelCamelCamel-style
price history** with a step chart and change markers.

## Status: v0.1 MVP (extension-only)

- ✅ One-click **“+ Watch page”** — captures the rendered product (JSON-LD + page text) with your session.
- ✅ **“+ Area”** — click any region of the page (price, promo banner) to watch it **semantically**: the cheap LLM diffs that region against its baseline and flags new offers, gated by a per-area hash so it only spends when the region changes.
- ✅ **Right-click to watch** — context menu on any page or link: **“monitor price changes”** or **“monitor availability (restock)”**. Each creates a watch in the matching mode (notifications are filtered to that mode).
- ✅ **Restock / availability detection** — fires **“📦 Back in stock”** on an out-of-stock → in-stock flip. Signal sources, best first: a **Shopify `/products/<handle>.js`** fast-path (free, exact per-variant `available` flag, no bot wall — covers magbak, enhauto, and most D2C stores), schema.org `availability` (read **independently of price**, since shops drop the price when OOS), and a DOM “sold out / add to cart” fallback.
- ✅ **Two-tier extraction**: schema.org/JSON-LD price first (free, deterministic); Claude Haiku 4.5 fallback only when there’s no structured price (≈$0 with the cheap pre-filter).
- ✅ **Recipe service** for stores the built-in reader can't parse: the watch's card offers it, store by store, and nothing about a store is sent until the user allows it. A free, public Cloudflare Worker (`worker/`, Qwen3 on Workers AI) works out a per-store recipe (CSS selectors for price and stock) once; every later check runs it in the browser with no AI. Users can run their own copy instead (Settings → Your own recipe worker).
  A price merely *read off* the rendered page (the DOM scan, or the LLM reading page text) counts as the product’s own **only while the product is purchasable** — an unavailable listing usually shows no price at all, so every amount on it belongs to a sponsored / “also viewed” neighbour.
  The DOM scan only considers amounts that speak for *this* product: anchored on the page’s product title (`<h1>`), it skips site chrome (e.g. the header cart panel), recommendation / ad rails, hidden elements, unselected variant options, and anything more than about a screen from the title.
  A check that can’t read a field records it as unknown and carries the last value forward — it never adds a blank point to the history.
- ✅ **Open-tab fallback**: when a plain `fetch()` is bot-blocked (Akamai/PerimeterX) or finds no price, BuyTracker re-checks by briefly opening an **inactive background tab** — a real navigation with your session, which gets past the wall and picks up JS-hydrated prices. The mode goes sticky per watch.
- ✅ **Price history as a step series** (a point is stored only when the price actually changes) + inline SVG chart with lowest-price and current markers.
- ✅ **Alerts** (Chrome notifications) on price drop, target-price hit, restock, and LLM-detected new offers.
- ✅ Per-watch **check interval** and **target price**; pause/resume/delete.
- ⏳ Checks run only while the browser is open (extension-only mode). Always-on scheduling is the planned next step. (Away-from-PC alerting channel TBD — **not** Telegram.)

## Install (load unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`buytracker/`).
3. Open the extension **Options** and paste an Anthropic API key (optional — only needed for the LLM fallback). “Test API key” verifies it.

The PNG icons are committed. After editing `icons/logo.svg` (or `icons/logo-small.svg`, the 16px version)
regenerate them with `node scripts/generate-icons.js` — it renders them with headless Chrome.

## Firefox

The same source, with a Firefox manifest (an event page instead of the service worker, the add-on id,
and the data-collection declaration Firefox asks the user about). Needs Firefox 140 or later.

```bash
node scripts/build-firefox.js            # → dist/firefox/ and buytracker-firefox.zip
npx web-ext lint -s dist/firefox         # Mozilla's validator: expect 0 errors
```

To try it: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → `dist/firefox/manifest.json`.

Runtime test in the real (headless) Firefox. It covers the background fetch on a live Shopify store, the
consent gate (with a local fake store and worker, so nothing reaches the production service), the
MAIN-world recipe, and the popup and options flows:

```bash
mkdir -p /tmp/bt-fftest && cd /tmp/bt-fftest && npm i puppeteer-core   # once
node /path/to/buytracker/test/firefox.mjs
```

Firefox asks the user itself before an add-on sends data anywhere. `src/lib/consent.js` handles that:
the store's **Allow** button, a wrong-result report, and saving a Claude key or a self-hosted worker each ask
for page data, and the error-report switch is Firefox's own permission. Without consent nothing leaves the
browser. In Chrome all of this answers yes and the settings decide, as before. Firefox can't show
`alert()`/`confirm()` in a popup, so the popup uses its own toast and a two-click delete.

Publishing: [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) (free) → submit
`buytracker-firefox.zip`. No source upload is needed: the package is the unmodified source plus a generated
manifest. Listing notes are in `STORE_LISTING.md`. The add-on id (`buytracker@salamacchine.it`, in
`scripts/build-firefox.js`) is permanent once it's listed.

## Use

- Browse to a product page → click the toolbar icon → **+ Watch this page**.
- The popup lists each watch with its current price, change vs. last, a price-history chart, status, interval, and a target-price field.
- **check now** forces a re-check; **↻** checks everything that’s due.

## Testing

Automated smoke test (headless Chromium loads the unpacked extension, boots the service worker,
renders popup/options, checks DOM extraction against saved page mirrors in `test/fixtures/` — e.g. an
unavailable amazon.pl listing must yield no price and OutOfStock — and runs a real end-to-end
add-watch + re-check against a live product page):

```bash
mkdir -p /tmp/bt-test && cd /tmp/bt-test && npm i playwright   # once
node /path/to/buytracker/test/smoke.js
```

## How it works

```
Watch this page ─► capture.js (rendered DOM, your session) ─► baseline + first price point
Every N hours  ─► background.js acquires (cheapest reliable signal first):
                   ├─ Shopify /products/<handle>.js  (exact available + price, free)
                   ├─ fetch(url, credentials) from your IP → JSON-LD/schema.org price + availability
                   ├─ open-tab fallback (real navigation) if blocked / no price
                   │    └─ per-store recipe (recipe.js), learned once from the recipe service
                   │       (worker/) for a store the user allowed, then run locally
                   └─ llm.js: Claude Haiku 4.5 (tool-use)     (only with your own key, if no structured price, or area changed)
                 ─► storage.js: append a point ONLY on change (step series)
                 ─► notify on drop / target / restock / new offer
                 ─► chart.js: SVG step chart in the popup
```

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest (permissions, background SW, popup, options) |
| `src/background.js` | Service worker: alarms, residential fetch, check loop, notifications |
| `src/lib/extract.js` | DOM-free JSON-LD/price extraction + block detection + hashing |
| `src/lib/llm.js` | Claude Haiku 4.5 client (forced tool-use → structured JSON) |
| `src/lib/capture.js` | Injected to read the live DOM (product + page/area text) at watch-creation and on tab-mode re-checks |
| `src/lib/picker.js` | Injected element picker for **+ Area** — returns a CSS selector + region text |
| `src/lib/recipe.js` | Per-store recipes: page snapshot for the recipe service, applying a recipe, local cache |
| `src/lib/report.js` | Opt-in wrong-result and error reports to the developer |
| `src/lib/consent.js` | Firefox's own consent for sending data (a no-op in Chrome) |
| `scripts/build-firefox.js` | Builds the Firefox package from the same source |
| `worker/` | The recipe service (Cloudflare Worker + Workers AI, KV, D1) and report intake |
| `src/lib/storage.js` | chrome.storage wrappers + append-on-change history logic |
| `src/lib/chart.js` | Dependency-free SVG step chart |
| `src/popup.*` | Watchlist UI with inline charts |
| `src/options.*` | Recipe service, own worker, API key / model / interval settings |

## Notes & limitations

- **API key** lives in `chrome.storage.local` (this browser only). Fine for personal use; the planned local-proxy step removes it from the client.
- **Akamai/PerimeterX-class sites** (e.g. eprice.it) block a non-navigational `fetch`, so BuyTracker falls back to the **open-tab** path. That briefly opens an inactive background tab on each check for those watches — heavier and momentarily visible in the tab strip, but it works from your real session. Fine for non-urgent, low-frequency checks.
- The LLM fallback runs **only when no structured price is found** (or, for an **area** watch, only when the watched region changed), to keep cost near zero.
- The **area selector** is best-effort (id → stable class → nth-of-type). On sites with churning markup it may need re-creating; price-history watches don’t depend on it.
- The Shopify `.js` fast-path reports price in the store currency but **not a currency code** — the currency is taken from the page’s JSON-LD when you add the watch from an open tab (right-click on the page). Prices are assumed to be in cents (×100); zero-decimal currencies (e.g. JPY) aren’t special-cased yet.

## License

Copyright © 2026 Luca G.

- **The extension** (everything outside `worker/`): [GNU GPL v3](LICENSE) or later.
- **The recipe service** (`worker/`): [GNU AGPL v3](worker/LICENSE) or later. It runs as a network
  service, and the AGPL's extra clause covers exactly that: anyone who runs a modified copy for others to
  use has to offer them its source.
