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
• Optional self-hosted helper — power users can deploy a tiny open-source service on their own Cloudflare account that teaches BuyTracker how to parse tricky sites once, then every future check is free and local. Also off by default.

PRIVACY
• No account, no sign-up, no tracking.
• Your watches, history, and settings stay in your browser.
• BuyTracker never sends your data to us — we don't have a server.
• Page text is only sent to Anthropic if YOU turn on the AI fallback and provide YOUR OWN API key.

NOTE
Checks run while your browser is open (extension-only mode). There's no cloud component.
```

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

- **Data collected:** *Website content* only (page text/price is read; transmitted to Anthropic **only** if the user enables the AI fallback with their own key, and/or — redacted — to the user's own self-hosted recipe service if they configure one). Nothing else.
- **Certifications — all three are TRUE:**
  1. I do not sell or transfer user data to third parties outside of approved use cases.
  2. I do not use or transfer user data for purposes unrelated to the item's single purpose.
  3. I do not use or transfer user data to determine creditworthiness or for lending.
- **Reviewer note:**

```
The extension has no backend and collects nothing to the developer. The optional AI fallback is off by default; when the user enables it and supplies their own Anthropic API key, the text of the user's watched page is sent directly from the user's browser to api.anthropic.com to detect offers. The API key is stored locally only. Separately and also off by default, the user may self-host an open-source helper service on their own Cloudflare account (URL + token entered in settings); when configured, a PII-redacted snapshot of a watched page is sent to that user-owned endpoint once per site to derive parsing rules. The developer operates neither endpoint and receives no data.
```
