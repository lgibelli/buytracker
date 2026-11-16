# BuyTracker recipe service

A small Cloudflare Worker that works out **reusable per-store parse recipes** with an AI model on
Workers AI and shares them. The browser extension renders a product page (residential IP + the
user's session), reduces it to a small snapshot, and asks this worker how to read that store
**once**; afterwards the extension runs the cached recipe on every check (no AI, no server round
trip), and asks again only when the recipe stops reading the page.

The published extension uses the public instance at `https://buytracker-recipes.nervoso.workers.dev`,
and only for stores the user allowed on the watch's card (`recipeServiceFor` in
`../src/lib/recipe.js`). Anyone can run their own copy and point the extension at it (Settings →
Your own recipe worker); then it's used for every store, with no per-store prompt.

- `src/index.js`: routing, rate limits, the AI meter, the shared-recipe rules, report intake.
- `src/derive.js`: the prompt, the Workers AI call, parsing and checking the model's recipe.
- Model: `@cf/qwen/qwen3-30b-a3b-fp8` (`MODEL` in `wrangler.toml`). In a test on seven live stores
  and the saved Amazon traps it wrote a correct recipe every time, at ~30 neurons a recipe.

## Endpoints

**Public** (the published extension can't hold a secret):

- `POST /recipe` with body `{ host?, url?, snapshot, force?, feedback? }`. Returns the shared recipe
  if the store has one (unless `force` or `feedback`), otherwise derives one from `snapshot`.
  Snapshots are whitelisted to the fields `buildSnapshot()` produces and size-capped, so the worker
  can't be used as a general AI proxy. `feedback` (from "Wrong result? Report & fix") is
  `{ correct_availability?: 'in'|'out', correct_price?: number, note?: string }`: it forces a
  re-derivation and goes to the model as a trusted correction (the free-text `note` is treated as
  data, never as instructions). The reply says whether the recipe is the store's shared one
  (`shared`).
- `GET /recipe?host=<host>`: the shared recipe or `404`. No AI call.
- `POST /feedback`: a wrong-result report a user chose to send (`../src/lib/report.js` →
  `sendFeedback`): page address without query string, what BuyTracker read, the correction, the
  outcome.
- `POST /errors`: an error from BuyTracker's own code, sent only while the user has "Send error
  reports" on in Settings, already scrubbed of web addresses, emails and quoted text.
- `GET /privacy`: the privacy policy (`../privacy.html`), the Chrome Web Store listing's policy URL.

**Operator only** (`Authorization: Bearer <AUTH_TOKEN>`):

- `DELETE /recipe?host=<host>`: drop a store's shared recipe.
- `GET /reports?limit=&host=`: corrections made with your token (outcome, model, error).
- `GET /feedback?limit=&host=`, `GET /errors?limit=`: what users chose to send.

`host` is normalised (lowercased, leading `www.` stripped).

## Limits: staying inside Cloudflare's free tier

Everything is bounded so that the service runs on free allowances.

- **AI spend.** Before each model call the worker books that call's worst-case cost in neurons (from
  the input size and `max_tokens`, priced with `NEURONS_PER_MTOK` in `src/derive.js`), and calls the
  model only if the booking fits under `DAILY_NEURONS`. Afterwards it settles to what the reply
  reports. Booking is one atomic D1 upsert, so parallel requests can't overshoot together; a call
  that timed out keeps its worst case booked. The default cap, 3,300 a day, is a third of Workers
  AI's free 10,000. Past it, `POST /recipe` answers `429 {"error":"daily limit reached","retry_after":…}`
  with `Retry-After` until UTC midnight; the extension parks derivation until then and checks keep
  running.
- **Per client and per day.** At most 20 derivations per client a day and 100 in total (`INTAKE.derive`).
  A client is a keyed hash of (day, IP): it can't be reversed, isn't stored with anything, and is
  deleted the next day.
- **One client can't set what every user of a store gets.** The snapshot comes from the client, so a
  crafted one could steer the model. A recipe becomes a store's shared one only when two different
  clients (by the day's IP hash) get the same recipe from their own pages on the same day (`vouch`;
  the pending votes expire at UTC midnight); until then each client gets its recipe for itself. A
  correction re-derives for the reporting user only (their extension caches it), except the
  operator's (with `AUTH_TOKEN`), which replaces the shared recipe. A forced re-derivation can
  replace the shared recipe only once it is a week old or reads nothing. A recipe that reads nothing
  is never shared.
- **Reports.** `POST /feedback` and `POST /errors` take at most 16 KB, whitelist every field, and
  are rate-limited the same way: per client 20 reports and 50 errors a day, at most 1,000 reports
  and 5,000 errors a day in total. Reports are pruned after a year, errors after 90 days (`INTAKE`
  in `src/index.js`; `../privacy.html` says the same). Read them with `npm run feedback` /
  `npm run errors`, or `GET` with your token.

**Which plan you're on matters.** On the Workers Free plan, usage past a daily allowance fails rather
than billing. On Workers Paid, Workers AI usage past 10,000 neurons a day is billed ($0.011 per 1,000
neurons), and the allowance is shared by everything on the account. `DAILY_NEURONS` only meters this
worker's calls, so leave room for anything else that uses Workers AI (including `wrangler dev`
sessions, which call the real Workers AI but keep their meter in a local D1).

## Deploy (run these yourself: they need your Cloudflare login)

```sh
cd worker
npm i                        # wrangler
npx wrangler login

# 1. Create the KV namespace and the D1 database; paste the printed ids into wrangler.toml.
npx wrangler kv namespace create RECIPES
npx wrangler d1 create buytracker-reports
npx wrangler d1 migrations apply buytracker-reports --remote

# 2. Set the operator secret (never commit it): unlocks the logs and DELETE /recipe, and keys the
#    hash used to rate-limit clients.
npx wrangler secret put AUTH_TOKEN

# 3. Ship it.
npx wrangler deploy
```

`wrangler deploy` prints the worker URL (e.g. `https://buytracker-recipes.<sub>.workers.dev`). To use
your own copy from the extension, put that URL (and, optionally, your `AUTH_TOKEN`) in **Settings →
Your own recipe worker**.

## Local test

```sh
npx wrangler dev      # POST to http://localhost:8787/recipe; Workers AI runs remotely, KV and D1 locally
```

`--var DAILY_NEURONS:250` sets a small cap to watch the meter; `--persist-to <dir>` gives a fresh
local D1 (apply the migrations to it with `wrangler d1 migrations apply buytracker-reports --local
--persist-to <dir>`).
