# BuyTracker recipe worker

A tiny Cloudflare Worker that derives **reusable per-site parse recipes** with Claude and caches
them in KV. The browser extension renders the page (residential IP + your session), reduces it to a
small snapshot, and asks this worker how to parse the site **once per host**; afterwards the
extension runs the cached recipe deterministically on every check — no LLM, no server round-trip —
re-deriving only when the recipe stops matching. The Anthropic key stays server-side.

See `../src/lib/recipe.js` for the matching extension side, and the project memory for why rendering
stays in the extension rather than moving to the worker.

## Endpoints

All require `Authorization: Bearer <AUTH_TOKEN>`.

- `POST /recipe` — body `{ host?, url?, snapshot, force? }`. Returns the cached recipe if one exists
  (unless `force:true`), otherwise derives a fresh one from `snapshot`, caches it, and returns it.
- `GET /recipe?host=<host>` — cached recipe or `404` (warm the extension cache with no LLM call).
- `DELETE /recipe?host=<host>` — invalidate a stale recipe.

`host` is normalised (lowercased, leading `www.` stripped).

## Deploy (run these yourself — they need your Cloudflare login)

```sh
cd worker
npm i -g wrangler            # or: npm i -D wrangler && npx wrangler ...
wrangler login

# 1. Create the KV namespace, then paste the printed id into wrangler.toml ([[kv_namespaces]] id).
wrangler kv namespace create RECIPES

# 2. Set secrets (never commit these):
wrangler secret put ANTHROPIC_KEY   # your sk-ant-... key
wrangler secret put AUTH_TOKEN      # a long random string; paste the SAME value into the
                                    # extension options ("Recipe worker token")

# 3. Ship it.
wrangler deploy
```

`wrangler deploy` prints your worker URL (e.g. `https://buytracker-recipes.<sub>.workers.dev`).
Put that URL + the `AUTH_TOKEN` into the extension's **Settings → Recipe worker**.

## Local test

```sh
wrangler dev          # then POST to http://localhost:8787/recipe with the Bearer header
```
A `vars`-based `AUTH_TOKEN`/`ANTHROPIC_KEY` in a local `.dev.vars` file works for `wrangler dev`.
