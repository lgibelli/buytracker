# BuyTracker — Privacy Policy

_Last updated: 2026-07-03_

BuyTracker does not have a server and does not collect, store, or transmit any
personal data to the developer.

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
how to parse it. The developer operates no server and never receives any of this data.

## What we do NOT do

- No analytics, tracking, ads, or accounts.
- We do not sell or share your data.

## Contact

Questions or issues: [github.com/lgibelli](https://github.com/lgibelli) — or open
an issue at [github.com/lgibelli/buytracker/issues](https://github.com/lgibelli/buytracker/issues).
