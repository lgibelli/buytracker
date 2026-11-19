# BuyTracker — Privacy Policy

_Last updated: 2026-11-19_

BuyTracker has no accounts, analytics or ads. It sends nothing about the pages you watch
to the developer unless you choose to, as described under [Free recipe creator](#free-recipe-creator-store-by-store)
and [Reports to the developer](#reports-to-the-developer). It sends anonymous error reports
about bugs in its own code, which you can turn off. Unless you turn sync off in Settings, your
browser's own sync copies your watch list (not its price history) to your other computers, as
described under [Sync between your computers](#sync-between-your-computers).

## What the extension stores

Your list of watched pages, their price history, and your settings are stored
locally in your browser's own extension storage. They never leave your device
except as described below.

### Sync between your computers

With "Sync between computers" on in Settings (it is on unless you turn it off), BuyTracker
also keeps a copy of your watch list in your browser's sync storage: each watch's page
address, title, target price, check interval, whether it's paused, and its last price and
stock, plus the recipe creator switch, the stores you allowed or declined for it, and the
check interval for new watches. Your browser carries that copy to your other computers
signed in to the same account: Chrome through your Google account when Chrome sync is on,
Firefox through your Firefox account. Google or Mozilla handle it under their own privacy
policies. It never goes to the developer. Price history, the address and token of your own
recipe worker, and the error-report setting stay on each computer.

## Free recipe creator, store by store

When BuyTracker can't read a store on its own, that store's watch offers the free recipe
creator, a service which the developer runs on Cloudflare (`buytracker-recipes.nervoso.workers.dev`).
**Nothing about a store is sent until you allow that store**, on its watch or by submitting
a "Report & fix" for it. You can remove a store, or turn the recipe creator off, in Settings.

For a store you allowed, BuyTracker sends the product page's address without its query
string or fragment, and a short extract of the page: its title, the prices and buttons near
the product with their positions in the page, the start of its text, and data the page
publishes for its own scripts. Email addresses and phone numbers are redacted first, and
data named like account, customer, cart or session details is left out. An AI model on
Cloudflare (Workers AI) turns the extract into a "recipe", the rules for where this store
shows price and stock. The service does not keep the extract. Once two different connections
get the same recipe for a store on the same day, the service keeps it and gives it to other
users of that store; until then it holds the day's keyed hash of each connection's IP address
with that recipe, and deletes it at the end of the day. BuyTracker sends again only when the
recipe stops reading the page (at most once a week) or when you report a wrong result. All
checks run in your browser.

The service is shared and free, so it has a daily limit, and it counts requests per day by
a keyed hash of your IP address, as described for reports below.

If you run your own copy of the service (Settings, "Experimental feature"), BuyTracker
uses it for every store instead, and the developer receives none of this.

## Reports to the developer

Neither kind of report carries an account, an install ID or any other identifier, so
reports can't be linked to each other or to you.

- **Wrong-result reports.** When a watch shows the wrong price or stock, you can report
  it from the popup. The report goes to the developer only when you tick "Also send this
  report to the developer", or press "Send to the developer" (shown when the recipe
  creator is off). It contains the page address without its query string or
  fragment (nothing after "?" or "#"), the price, currency and stock state BuyTracker
  read, how it read the page (the parsing rules in use, if any, and the last error), your
  correction and optional note, the extension version, and, if the recipe creator
  re-checked the page, what it read then.
- **Error reports.** On for a new install, as the welcome page says; turn off "Send error
  reports to the developer" there or in Settings at any time. Installs from before version
  0.1.17 keep the choice they had (off unless turned on). In Firefox they are sent only if you
  allow them in Firefox's own prompt. When BuyTracker hits a bug in its own code, it sends the error type and
  message, where in BuyTracker's code it happened, the extension version, and your browser
  (Chrome or Firefox) version and operating system (from the browser's user agent). Web addresses, email
  addresses and quoted text are removed first, and nothing about your watches is
  included. Each distinct error is sent at most once a day.

Reports go to a service the developer runs on Cloudflare
(`buytracker-recipes.nervoso.workers.dev`) and are stored in a Cloudflare database:
wrong-result reports for up to a year, error reports for 90 days. They are used only to
fix how BuyTracker reads stores and to fix bugs, and are never sold or shared.

To limit abuse, the service counts requests per day by a keyed hash of your IP address.
The hash can't be turned back into the address, is never stored with a report, and is
deleted the next day. Cloudflare, as the hosting provider, handles the connection under
[its own privacy policy](https://www.cloudflare.com/privacypolicy/).

## What we do NOT do

- No analytics, tracking, ads, or accounts.
- No identifiers: everything BuyTracker sends is anonymous.
- We do not sell or share your data.

## Contact

Questions or issues: [github.com/lgibelli](https://github.com/lgibelli) — or open
an issue at [github.com/lgibelli/buytracker/issues](https://github.com/lgibelli/buytracker/issues).
