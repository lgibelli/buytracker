# BuyTracker — Privacy Policy

_Last updated: 2026-11-16_

BuyTracker has no accounts, analytics or ads. It sends nothing to the developer
unless you choose to, as described under [Reports you choose to send](#reports-you-choose-to-send).

## What the extension stores

Your list of watched pages, their price history, and your settings are stored
locally in your browser using Chrome's storage. They never leave your device
except as described below.

## Optional AI offer detection

This feature is **off by default**. If you enable it and provide your own
Anthropic (Claude) API key, the text of a page you have chosen to watch is sent
directly from your browser to Anthropic (`api.anthropic.com`) to detect prices
and offers. Your API key is stored locally in your browser and is used only to
authenticate these requests. Anthropic's handling of that data is governed by
[Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## Optional self-hosted parsing helper

Also **off by default**. BuyTracker can optionally use a small "recipe" service that
you deploy yourself on your own Cloudflare account (see the project README). If you
configure its URL and token in settings, a reduced snapshot of a page you have chosen
to watch — with emails/phone numbers redacted and personal-looking fields stripped —
is sent from your browser to **your own** service, which asks Anthropic once per site
how to parse it. The developer never receives any of this data.

## Reports you choose to send

Nothing below is sent unless you act. Neither kind of report carries an account, an
install ID or any other identifier, so reports can't be linked to each other or to you.

- **Wrong-result reports.** When a watch shows the wrong price or stock, you can report
  it from the popup. The report goes to the developer only when you tick "Also send this
  report to the developer", or press "Send to the developer" (shown when you don't run
  your own recipe service). It contains the page address without its query string or
  fragment (nothing after "?" or "#"), the price, currency and stock state BuyTracker
  read, how it read the page (the parsing rules in use, if any, and the last error), your
  correction and optional note, the extension version, and, if your own recipe service
  re-checked the page, what it read then.
- **Error reports.** Off by default: turn on "Send error reports to the developer" in
  Settings. When BuyTracker hits a bug in its own code, it sends the error type and
  message, where in BuyTracker's code it happened, the extension version, and your Chrome
  version and operating system (from the browser's user agent). Web addresses, email
  addresses and quoted text are removed first, and nothing about your watches is
  included. Each distinct error is sent at most once a day.

Reports go to a service the developer runs on Cloudflare
(`buytracker-recipes.nervoso.workers.dev`) and are stored in a Cloudflare database:
wrong-result reports for up to a year, error reports for 90 days. They are used only to
fix how BuyTracker reads stores and to fix bugs, and are never sold or shared.

To limit abuse, the service counts reports per day by a keyed hash of your IP address.
The hash can't be turned back into the address, is never stored with a report, and is
deleted the next day. Cloudflare, as the hosting provider, handles the connection under
[its own privacy policy](https://www.cloudflare.com/privacypolicy/).

## What we do NOT do

- No analytics, tracking, ads, or accounts.
- No identifiers: the reports you choose to send are anonymous.
- We do not sell or share your data.

## Contact

Questions or issues: [github.com/lgibelli](https://github.com/lgibelli) — or open
an issue at [github.com/lgibelli/buytracker/issues](https://github.com/lgibelli/buytracker/issues).
