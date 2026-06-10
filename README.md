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
- ✅ **Open-tab fallback**: when a plain `fetch()` is bot-blocked (Akamai/PerimeterX) or finds no price, BuyTracker re-checks by briefly opening an **inactive background tab** — a real navigation with your session, which gets past the wall and picks up JS-hydrated prices. The mode goes sticky per watch.
- ✅ **Price history as a step series** (a point is stored only when the price actually changes) + inline SVG chart with lowest-price and current markers.
- ✅ **Alerts** (Chrome notifications) on price drop, target-price hit, restock, and LLM-detected new offers.
- ✅ Per-watch **check interval** and **target price**; pause/resume/delete.
- ⏳ Checks run only while the browser is open (extension-only mode). Always-on scheduling is the planned next step. (Away-from-PC alerting channel TBD — **not** Telegram.)

## Install (load unpacked)

1. Build the icons once (already committed, but to regenerate): `node scripts/generate-icons.js`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this folder (`buytracker/`).
4. Open the extension **Options** and paste an Anthropic API key (optional — only needed for the LLM fallback). “Test API key” verifies it.

## Use

- Browse to a product page → click the toolbar icon → **+ Watch this page**.
- The popup lists each watch with its current price, change vs. last, a price-history chart, status, interval, and a target-price field.
- **check now** forces a re-check; **↻** checks everything that’s due.

## How it works

```
Watch this page ─► capture.js (rendered DOM, your session) ─► baseline + first price point
Every N hours  ─► background.js acquires (cheapest reliable signal first):
                   ├─ Shopify /products/<handle>.js  (exact available + price, free)
                   ├─ fetch(url, credentials) from your IP → JSON-LD/schema.org price + availability
                   ├─ open-tab fallback (real navigation) if blocked / no price
                   └─ llm.js: Claude Haiku 4.5 (tool-use)     (only if no structured price, or area changed)
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
| `src/lib/storage.js` | chrome.storage wrappers + append-on-change history logic |
| `src/lib/chart.js` | Dependency-free SVG step chart |
| `src/popup.*` | Watchlist UI with inline charts |
| `src/options.*` | API key / model / interval settings |

## Notes & limitations

- **API key** lives in `chrome.storage.local` (this browser only). Fine for personal use; the planned local-proxy step removes it from the client.
- **Akamai/PerimeterX-class sites** (e.g. eprice.it) block a non-navigational `fetch`, so BuyTracker falls back to the **open-tab** path. That briefly opens an inactive background tab on each check for those watches — heavier and momentarily visible in the tab strip, but it works from your real session. Fine for non-urgent, low-frequency checks.
- The LLM fallback runs **only when no structured price is found** (or, for an **area** watch, only when the watched region changed), to keep cost near zero.
- The **area selector** is best-effort (id → stable class → nth-of-type). On sites with churning markup it may need re-creating; price-history watches don’t depend on it.
- The Shopify `.js` fast-path reports price in the store currency but **not a currency code** — the currency is taken from the page’s JSON-LD when you add the watch from an open tab (right-click on the page). Prices are assumed to be in cents (×100); zero-decimal currencies (e.g. JPY) aren’t special-cased yet.
