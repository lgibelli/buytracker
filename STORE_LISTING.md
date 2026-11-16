# BuyTracker — Chrome Web Store listing

Copy-paste source for the Chrome Web Store submission. Keep in sync with `manifest.json`.

## Item name

```
BuyTracker — Price & Offer Watcher
```

## Summary (short description, ≤132 chars)

```
Watch any product page for price drops, new offers, and restocks — with price history and smart alerts, all in your browser.
```

## Detailed description

```
BuyTracker watches the product pages you care about and alerts you when the price drops, a new offer appears, or an out-of-stock item is back — with a CamelCamelCamel-style price history chart for every item you track.

Everything runs locally in your own browser. Because checks happen in your session, BuyTracker sees the real, region-correct, logged-in price you'd actually pay — not a generic guess.

FEATURES
• One-click watch — open a product page and hit "+ Watch page", or right-click any page or link.
• Watch a specific area — click "+ Area" and select just the price/offer region of a page to monitor.
• Price history — a clean chart of every price point BuyTracker has recorded.
• Smart alerts — desktop notifications on price drops, restocks, a target price you set, or a new discount/offer.
• Set your own check interval per item and a target price.
• Works broadly — uses a site's structured data and a fast path for Shopify stores; falls back to rendering the page when needed.
• Optional AI offer detection — if you add your own Anthropic (Claude) API key, BuyTracker can spot new discounts on pages that don't expose a clean price. This is off by default and entirely optional.
• Free recipe service for tricky stores — when BuyTracker can't read a store on its own, the watch offers to learn it. Only if you allow that store, a free service works out how to read it once; every later check runs in your browser. Power users can run their own copy instead.

PRIVACY
• No account, no sign-up, no tracking.
• Your watches, history, and settings stay in your browser.
• Nothing is sent to us unless you choose to: a store you allow for the recipe service (its page address and a short extract of the product page, never anything about you), a wrong-result report you send from a watch, or error reports if you turn them on in Settings. All anonymous.
• Page text is only sent to Anthropic if YOU turn on the AI fallback and provide YOUR OWN API key.

NOTE
Checks run in your browser, while it is open (extension-only mode).
```

## Graphic assets (`store-assets/`)

| Store field | File |
|---|---|
| Screenshots (1280×800) | `screenshot-1-popup-1280x800.png`, `screenshot-2-options-1280x800.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560.png` |
| Promo video (YouTube link) | `promo-video-30s.mp4`: upload it to YouTube and paste the link |

The promo tiles are 24-bit PNGs (no alpha) rendered from `store-assets/promo/small.html` and
`marquee.html`. Edit those, then run `node scripts/render-promo.js` on a Mac (it uses the macOS fonts
Avenir Next and DIN Alternate).

The video (30 s, 1080p, with an ElevenLabs voiceover) is made in two steps:

1. `node scripts/render-video.js` renders `store-assets/promo/video.html` (which draws the popup with the
   extension's real `popup.css` and `chart.js`) to `store-assets/promo/video-silent.mp4`. Needs ffmpeg.
   `node scripts/render-video.js 3 14 29` renders stills at those seconds for review.
2. `ELEVENLABS_API_KEY=… node scripts/voiceover.js` voices the lines in `store-assets/promo/voiceover.json`
   (each with the second it starts and when its beat ends) and mixes them over the silent render.
   Clips are cached in `store-assets/promo/voice/`, so only edited lines are re-synthesised (and billed);
   `--voices` lists the voices on your account.
3. Music: "Light Tech" by MusicDog (Envato Elements, licensed to this project). Save it as
   `store-assets/promo/music.wav` (kept out of git) and re-run `node scripts/voiceover.js`. The bed starts
   `music.start` = 8 s into the track (so its drop lands on "Free."), is set to `music.level_lufs` with one
   fixed gain, faded, and ducked under the voice. No API key is needed when the voice clips are cached.
   The track is Claim Clear (HAAWK): add the video in Envato's Claim Clear dashboard before uploading.

## Single purpose

```
Monitor product web pages the user chooses and notify them when the price, availability, or offers on those pages change.
```

- **Category:** Shopping
- **Language:** English
- **Privacy policy URL:** `https://buytracker-recipes.nervoso.workers.dev/privacy` (served by the recipe worker from the repo's `privacy.html`)

## Permission justifications

| Permission | Justification |
|---|---|
| `host_permissions` (`<all_urls>`) | Users can choose to watch a product on any retailer's website, so the extension must be able to read and re-check pages on any domain the user explicitly adds as a watch. It does not run on sites the user hasn't chosen to track. |
| `scripting` | To read the real rendered price/availability and to let the user click a specific region of a page to watch, the extension injects a small content script into the product page the user is tracking. |
| `tabs` | Some product pages only show price/stock after JavaScript runs, so the extension opens the page in a background tab to read the rendered value. It also opens the product page when the user clicks an alert notification. |
| `activeTab` | When the user clicks "Watch this page" or "Watch area" in the popup, the extension acts on the user's current tab to capture that product. |
| `storage` / `unlimitedStorage` | Stores the user's watches, settings, and per-item price history locally. `unlimitedStorage` is needed because price history accumulates over time for many tracked items. |
| `alarms` | Schedules periodic background re-checks of the user's watched pages on the interval they set. |
| `notifications` | Sends the user a desktop alert when a watched item drops in price, hits their target, comes back in stock, or shows a new offer. |
| `contextMenus` | Adds right-click menu items so the user can start watching a page or link for price or availability changes. |

**Remote code:** "No, I am not using remote code." (The Anthropic call is a data request via `fetch`, not loaded/executed code.)

## Data-use disclosures (Privacy practices tab)

- **Data collected** (tick these two, nothing else):
  - *Website content*: page text/price is read; a short, redacted extract of a watched product page goes
    to the developer's recipe service **only** for a store the user allowed on that watch (or to the
    user's own self-hosted copy, if configured); page text goes to Anthropic **only** if the user enables
    the AI fallback with their own key; and the price/stock read for one page goes to the developer in a
    wrong-result report the user chooses to send.
  - *Web history*: the recipe service request and a wrong-result report each include that one watched
    page's address (without query string or fragment). Ticked to be conservative: it is a single page
    the user picked, not browsing history.
  - Error reports (opt-in in Settings) carry the error message, a code location, and the extension and
    Chrome versions. None of the store's data categories applies to them.
- **Certifications — all three are TRUE:**
  1. I do not sell or transfer user data to third parties outside of approved use cases.
  2. I do not use or transfer user data for purposes unrelated to the item's single purpose.
  3. I do not use or transfer user data to determine creditworthiness or for lending.
- **Reviewer note:**

```
The extension sends nothing to the developer unless the user chooses to, in three opt-in ways: (0) when the extension can't read a store on its own, the watch's card offers the free recipe service; only if the user presses "Allow for <store>" (or submits a wrong-result report, whose form says so), the extension sends that product page's address without query string or fragment and a short extract of the page (title, prices, buttons, opening text, page data, with emails and phone numbers redacted). A Cloudflare Workers AI model turns it into CSS selectors for that store; the extract is not stored, and the selectors are shared with other users of the store once two different connections get the same ones. Allowed stores can be removed in Settings. (1) From a watch's "Wrong result? Report" form, the user can tick "Also send this report to the developer" (or press "Send to the developer"); the report holds that page's address without query string or fragment, the price/stock the extension read, and the user's correction. (2) In Settings, "Send error reports to the developer" (off by default) sends errors from the extension's own code, with web addresses, emails and quoted text removed. All go to the developer's Cloudflare Worker (buytracker-recipes.nervoso.workers.dev), carry no account or identifier, and are rate-limited. The optional AI fallback is off by default; when the user enables it and supplies their own Anthropic API key, the text of the user's watched page is sent directly from the user's browser to api.anthropic.com to detect offers. The API key is stored locally only. Instead of the developer's recipe service, the user may self-host the open-source service on their own Cloudflare account (URL entered in settings); then the same extract goes to that user-owned endpoint instead.
```

---

# Firefox Add-ons (addons.mozilla.org)

Upload `buytracker-firefox.zip` (`node scripts/build-firefox.js`). Free; no developer fee.

- **Platforms:** Firefox for desktop only. Leave **Android unticked**: it has no context menus and
  handles background tabs differently, and none of that has been tested.
- **Source code:** "No". The package is the plain source plus a generated manifest (no minifier,
  bundler or transpiler).
- **Name / summary / description:** reuse the Chrome ones above (the AMO summary allows 250 chars).
- **Categories:** Shopping.
- **License:** GNU General Public License v3.0 (the extension; the worker is AGPL v3, see README).
- **Support site:** https://salamacchine.it/apps/buytracker/
- **Privacy policy:** paste the text of `PRIVACY.md` (AMO hosts it on the listing).
- **Data collection:** declared in the manifest, so there's nothing to fill in on the form. Nothing
  is required. *Website content* and *Browsing activity* are optional and asked for when the user
  allows a store, sends a wrong-result report, or saves a Claude key or a self-hosted worker. *Technical
  and interaction data* is optional and covers error reports (the Settings switch, also offered at install).
- **Version notes (0.1.16):**

```
First Firefox release. Watch any product page for price drops, restocks and new offers, with a price-history chart and browser notifications. Checks run in your browser. For the few stores it can't read on its own, an optional free recipe service (asked per store, with Firefox's data consent) works out how, once.
```

- **Notes to reviewer:** (no account needed)

```
No account or login is needed. To test: open a product page (e.g. https://eu.magbak.com/products/magbak-phone-mount-and-charger-for-tesla-25w), click the toolbar icon, then "Watch this page". The popup shows the price and stock; the refresh button re-checks in the background. Right-click a page for the same via the context menu.

Data: nothing leaves the browser unless the user chooses to, and never before Firefox's own data-collection consent (src/lib/consent.js requests it from the click that needs it; background.js runCheck/reportWrong and report.js check it before sending). Page data (websiteContent, browsingActivity) is used only: (1) when the user presses "Allow for <store>" on a store BuyTracker can't read, which sends that page's address without query string and a short extract to the developer's recipe service (buytracker-recipes.nervoso.workers.dev); (2) in a wrong-result report the user chooses to send; (3) if the user enters their own Anthropic API key or self-hosted worker. Error reports (technicalAndInteraction) are off unless the user turns them on. No account, no identifier.

The recipes the service returns are data, never code: CSS selectors and a dotted path to a page global, checked by sanitizeRecipe() and read by applyRecipe() in src/lib/recipe.js. <all_urls> is needed because any store's product page can be watched; pages are read only when the user adds a watch and on its scheduled re-checks.

innerHTML (src/popup.js, render): the popup's watch list is built from a template in which every value goes through esc() (escapes & < > "), or is a number the extension computed; the price chart filters the page-supplied currency to letters and currency symbols (src/lib/chart.js). MV3's extension-page CSP also blocks inline script. Every other page uses DOM APIs.

The package is the plain source plus a manifest generated by scripts/build-firefox.js: no minifier, bundler or transpiler.
```
