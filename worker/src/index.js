// BuyTracker recipe service: a public Cloudflare Worker anyone running the extension can use.
//
// The extension renders a product page in a real tab, reduces it to a small snapshot, and — for a
// store whose page its built-in reader can't read, and only once the user has allowed that store — asks
// here how to read it. derive.js has Qwen on Workers AI write a declarative recipe (selectors, a global
// path, a currency), which is cached in KV per store and shared: every later user of that store gets it
// with no AI call, and the extension runs it locally on every check. Rendering stays in the extension.
//
// Open to everyone, so it is bounded on every axis, all inside Cloudflare's free tier:
//   - AI spend: at most DAILY_NEURONS a day (default 9,000 of Workers AI's free 10,000), metered from
//     each reply; then 429 until UTC midnight and the extension backs off;
//   - per client: 20 derivations a day (a keyed hash of day + IP, deleted the next day);
//   - one client can't set what every user of a store gets: a recipe becomes the store's shared one
//     only when two different clients' pages yield the same recipe on the same day (vouch), a
//     correction re-derives for the reporting user only, and a forced re-derivation can replace the
//     shared recipe only once it is a week old or reads nothing (shareRule);
//   - the request body is whitelisted to the snapshot fields and size-capped, so the worker is no
//     general-purpose AI proxy.
// Also served: GET /privacy (the store listing's policy page) and the opt-in reports (POST /feedback,
// /errors). AUTH_TOKEN gates the operator endpoints: the logs and DELETE /recipe.

import PRIVACY_HTML from '../../privacy.html';
import { deriveRecipe, sanitizeSnapshot, sanitizeFeedback, isUseful } from './derive.js';

const MAX_BODY_BYTES = 262_144; // real snapshots are a few KB; anything bigger is not our client
const DAY_MS = 86_400_000;
const SHARED_MIN_AGE_MS = 7 * DAY_MS;
// Recipes get a prefix so a crafted ?host= can never touch another kind of key.
const recipeKey = (host) => 'recipe:' + host;
const secsToUtcMidnight = () => Math.max(60, Math.round(((Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS - Date.now()) / 1000));

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400'
});

const json = (obj, status, origin, extra) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors(origin), ...(extra || {}) } });

// Length-independent constant-time string compare, so the auth gate doesn't leak the token byte by
// byte via early-exit timing.
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

function authed(req, env) {
  if (!env.AUTH_TOKEN) return false; // refuse to run open if no token is configured
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  return !!m && timingSafeEqual(m[1], env.AUTH_TOKEN);
}

function normalizeHost(h) {
  return String(h || '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.\-:]/g, '').slice(0, 200);
}

// Corrections are logged only for the operator's own requests (authed): a public user's correction
// re-derives their recipe and is not kept. What users choose to send the developer goes to /feedback.
async function logReport(env, r) {
  if (!env.REPORTS) return;
  try {
    await env.REPORTS.prepare(
      `INSERT INTO reports (ts, host, url, correct_availability, correct_price, note, outcome, recipe_useful, recipe_notes, model, cost_usd, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      r.ts, r.host, r.url ? String(r.url).slice(0, 500) : null,
      r.correct_availability ?? null, r.correct_price ?? null, r.note ?? null,
      r.outcome, r.recipe_useful ?? null, r.recipe_notes ? String(r.recipe_notes).slice(0, 400) : null,
      r.model ?? null, null, r.error ? String(r.error).slice(0, 300) : null
    ).run();
  } catch (e) { console.warn('report log failed', e); }
}

// --- Public intake: reports users of the published extension choose to send (POST /feedback, /errors) ---
// No token: the extension is public, so any token it shipped would be too. Instead every field is
// whitelisted and capped, and intake is rate-limited per client and per day in total, which keeps a
// flood well inside D1's free allowance (and storage bounded) whatever the plan. Rows are pruned
// after a while (privacy.html states the same periods).
const INTAKE_MAX_BYTES = 16_384;
const INTAKE = {
  feedback: { perClient: 20, perDay: 1000, keepMs: 365 * DAY_MS },
  errors: { perClient: 50, perDay: 5000, keepMs: 90 * DAY_MS },
  // perDay is a second, independent limit under the neuron cap: 100 recipes a day, ~3,000 neurons at
  // the ~30 a recipe takes.
  derive: { perClient: 20, perDay: 100 }
};

const istr = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const inum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ione = (v, allowed) => (allowed.includes(v) ? v : null);
// Defence in depth: the extension already strips these before sending.
const iscrub = (v, n) => istr(v, n)?.replace(/\b(?:https?|wss?):\/\/[^\s'")]+/g, '<url>').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>') ?? null;
const RECIPE_KEYS = ['price_selector', 'price_attr', 'price_global', 'currency_code', 'currency_selector', 'in_stock_selector', 'out_of_stock_selector', 'out_of_stock_text'];

function cleanFeedback(p) {
  let u;
  try { u = new URL(p.url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = normalizeHost(u.hostname);
  if (!host) return null;
  const read = p.read && typeof p.read === 'object' ? p.read : {};
  const fix = p.correction && typeof p.correction === 'object' ? p.correction : {};
  const after = p.after && typeof p.after === 'object' ? p.after : {};
  let recipe = null;
  if (p.recipe && typeof p.recipe === 'object') {
    const r = Object.fromEntries(RECIPE_KEYS.map((k) => [k, istr(p.recipe[k], 300)]).filter(([, v]) => v));
    if (Object.keys(r).length) recipe = JSON.stringify(r);
  }
  const row = {
    version: istr(p.version, 20), host, url: (u.origin + u.pathname).slice(0, 500),
    watch_type: ione(p.watch_type, ['both', 'price', 'availability']),
    read_price: inum(read.price), read_currency: istr(read.currency, 8), read_availability: ione(read.availability, ['in', 'out']),
    read_status: ione(read.status, ['ok', 'no_data', 'blocked', 'error']), read_error: iscrub(read.error, 300),
    fetch_mode: ione(read.fetch_mode, ['tab', 'fetch']), recipe,
    correct_availability: ione(fix.availability, ['in', 'out']), correct_price: inum(fix.price), note: istr(fix.note, 300),
    outcome: ione(p.outcome, ['fixed', 'still_wrong', 'rederived', 'error', 'not_attempted']),
    after_price: inum(after.price), after_availability: ione(after.availability, ['in', 'out'])
  };
  // A report says what is wrong; one that says nothing is not worth a row.
  return row.correct_availability || row.correct_price != null || row.note ? row : null;
}

function browserOf(ua) {
  const b = /(Firefox|Chrome)\/(\d+)/.exec(ua || ''); // a Firefox user agent never says Chrome, nor the reverse
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  return b ? `${b[1]} ${b[2]} / ${os}` : os;
}

function cleanError(p, ua) {
  const message = iscrub(p.message, 500);
  if (!message) return null;
  return {
    version: istr(p.version, 20), context: ione(p.context, ['background', 'popup', 'options', 'welcome']),
    name: istr(p.name, 60), message, stack: iscrub(p.stack, 2000), browser: browserOf(ua)
  };
}

async function clientKey(env, day, ip) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_TOKEN || 'buytracker'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(day + '|' + ip)));
  return [...mac.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Counts this request against the client's and the day's allowance; false = over the limit. The
// day's total only counts admitted requests, so one noisy client can't use up everyone's allowance.
async function admit(env, kind, ip) {
  const day = new Date().toISOString().slice(0, 10);
  const bump = env.REPORTS.prepare('INSERT INTO intake_counts (day, key, n) VALUES (?, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1 RETURNING n');
  const [mine] = await env.REPORTS.batch([
    bump.bind(day, `${kind}:${await clientKey(env, day, ip)}`),
    env.REPORTS.prepare('DELETE FROM intake_counts WHERE day < ?').bind(day)
  ]);
  if (mine.results[0].n > INTAKE[kind].perClient) return false;
  const all = await bump.bind(day, `${kind}:*`).first();
  return all.n <= INTAKE[kind].perDay;
}

async function intake(req, env, kind, origin) {
  if (!env.REPORTS) return json({ error: 'reports DB not configured' }, 501, origin);
  if (Number(req.headers.get('content-length') || 0) > INTAKE_MAX_BYTES) return json({ error: 'body too large' }, 413, origin);
  const text = await req.text();
  if (text.length > INTAKE_MAX_BYTES) return json({ error: 'body too large' }, 413, origin);
  let p;
  try { p = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400, origin); }
  const row = p && typeof p === 'object' && (kind === 'feedback' ? cleanFeedback(p) : cleanError(p, req.headers.get('user-agent')));
  if (!row) return json({ error: 'nothing to record' }, 400, origin);
  if (!await admit(env, kind, req.headers.get('cf-connecting-ip') || 'unknown')) {
    return json({ error: 'too many reports today' }, 429, origin, { 'retry-after': String(secsToUtcMidnight()) });
  }
  const cols = Object.keys(row);
  await env.REPORTS.batch([
    env.REPORTS.prepare(`INSERT INTO ${kind} (ts, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`).bind(Date.now(), ...cols.map((c) => row[c])),
    env.REPORTS.prepare(`DELETE FROM ${kind} WHERE ts < ?`).bind(Date.now() - INTAKE[kind].keepMs)
  ]);
  return json({ ok: true }, 200, origin);
}


// --- Recipes ---
// The AI meter. Before each model call the worker books that call's WORST-CASE cost (derive.js prices it
// from the input size and max_tokens), and only calls the model if the booking fits under today's cap;
// afterwards it settles to what the reply reports. Booking is one atomic upsert, so concurrent requests
// can't all pass a "spent < cap" check and overshoot together, and a call whose cost is unknown (it
// timed out) keeps its worst case booked. So the meter never reads below the real spend, and the real
// spend never passes the cap. Days are UTC, like Workers AI's free allocation. Any D1 error fails the
// request: no meter, no model call. Default cap: a third of the free 10,000 (wrangler.toml DAILY_NEURONS).
const neuronBudget = (env) => Math.max(0, Number(env.DAILY_NEURONS ?? 3300));
const today = () => new Date().toISOString().slice(0, 10);

async function bumpNeurons(env, delta) {
  const row = await env.REPORTS.prepare("INSERT INTO intake_counts (day, key, n) VALUES (?, 'neurons:*', ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n RETURNING n")
    .bind(today(), delta).first();
  return row.n;
}
// → true if n more neurons fit under today's cap (else the booking is taken back).
async function reserveNeurons(env, n) {
  if (await bumpNeurons(env, n) <= neuronBudget(env)) return true;
  await bumpNeurons(env, -n);
  return false;
}
// Replace a booking with what the call actually used (unknown → the worst case stays booked).
async function settleNeurons(env, reserved, used) {
  if (reserved && Number.isFinite(used) && Math.ceil(used) !== reserved) await bumpNeurons(env, Math.ceil(used) - reserved);
}

// May a freshly derived recipe become the store's shared one? No shared recipe yet: yes. A forced
// re-derivation (the user's copy stopped reading a signal): only once the shared recipe is a week old or
// reads nothing. A user's correction: no, it goes back to that user only (their extension caches it),
// so one person can't rewrite a store's recipe for everyone; the operator's corrections may.
function shareRule(cached, feedback, own) {
  if (feedback) return own;
  if (!cached) return true;
  return !isUseful(cached) || Date.now() - (cached.derivedAt || 0) > SHARED_MIN_AGE_MS;
}

// The snapshot comes from the client, so a crafted one can steer the model. A recipe is therefore shared
// only once SHARE_QUORUM different clients (keyed hashes of day + IP, as for rate limits) got the same
// recipe from their own pages on the same day; until then each gets it back for themselves. The
// pending votes expire at UTC midnight, with the day's client hashes. Class-based selectors make
// recipes from different products of one store agree.
const SHARE_QUORUM = 2;
const recipePrint = (r) => JSON.stringify([r.price_selector, r.price_attr, r.price_global, r.currency_code, r.currency_selector,
  r.in_stock_selector, r.out_of_stock_selector, r.out_of_stock_text]);

async function vouch(env, host, recipe, client) {
  const key = 'pending:' + host;
  const pending = (await env.RECIPES.get(key, 'json')) || [];
  const print = recipePrint(recipe);
  let entry = pending.find((p) => p.print === print);
  if (!entry) { entry = { print, clients: [] }; pending.push(entry); }
  if (!entry.clients.includes(client)) entry.clients.push(client);
  if (entry.clients.length >= SHARE_QUORUM) {
    await env.RECIPES.put(recipeKey(host), JSON.stringify(recipe));
    await env.RECIPES.delete(key);
    return true;
  }
  await env.RECIPES.put(key, JSON.stringify(pending.slice(-8)), { expirationTtl: secsToUtcMidnight() });
  return false;
}

async function handleRecipe(req, env, url, origin) {
  // GET /recipe?host=… → the shared recipe or 404 (no AI call).
  if (req.method === 'GET') {
    const host = normalizeHost(url.searchParams.get('host'));
    if (!host) return json({ error: 'host required' }, 400, origin);
    const cached = await env.RECIPES.get(recipeKey(host), 'json');
    return cached ? json({ host, recipe: cached, cached: true, shared: true }, 200, origin) : json({ error: 'no recipe' }, 404, origin);
  }
  // DELETE /recipe?host=… → drop a store's shared recipe (operator only).
  if (req.method === 'DELETE') {
    if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, origin);
    const host = normalizeHost(url.searchParams.get('host'));
    if (!host) return json({ error: 'host required' }, 400, origin);
    await env.RECIPES.delete(recipeKey(host));
    return json({ host, deleted: true }, 200, origin);
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);

  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413, origin);
  let payload;
  try { payload = await req.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
  if (!payload || typeof payload !== 'object') return json({ error: 'bad json' }, 400, origin);
  let rawHost = payload.host;
  if (!rawHost && payload.url) { try { rawHost = new URL(payload.url).hostname; } catch { /* → 400 below */ } }
  const host = normalizeHost(rawHost);
  if (!host) return json({ error: 'host required' }, 400, origin);

  const feedback = sanitizeFeedback(payload.feedback);
  const cached = await env.RECIPES.get(recipeKey(host), 'json');
  // A correction always re-derives (the recipe is exactly what it says is wrong).
  if (cached && !payload.force && !feedback) return json({ host, recipe: cached, cached: true, shared: true }, 200, origin);
  if (!payload.snapshot || typeof payload.snapshot !== 'object') return json({ error: 'snapshot required to derive' }, 400, origin);
  if (!env.AI || !env.REPORTS) return json({ error: 'server missing AI or REPORTS binding' }, 500, origin);

  const overBudget = () => {
    const retry = secsToUtcMidnight();
    return json({ error: 'daily limit reached', retry_after: retry }, 429, origin, { 'retry-after': String(retry) });
  };
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  if (!await admit(env, 'derive', ip)) return overBudget();

  const own = authed(req, env);
  let recipe;
  try {
    let reserved, neurons;
    ({ recipe, reserved, neurons } = await deriveRecipe(env, sanitizeSnapshot(payload.snapshot, host), feedback, (n) => reserveNeurons(env, n)));
    await settleNeurons(env, reserved, neurons);
  } catch (e) {
    if (e.overBudget) return overBudget();
    await settleNeurons(env, e.reserved, e.neurons);
    if (own && feedback) await logReport(env, { ts: Date.now(), host, url: payload.url, ...feedbackCols(feedback), outcome: 'error', error: String(e.message || e) });
    return json({ error: String(e.message || e) }, 502, origin);
  }

  // A recipe that reads nothing is never shared: the requester's extension caches it and asks again in a week.
  const useful = isUseful(recipe);
  let shared = false;
  if (useful && shareRule(cached, feedback, own)) {
    if (own) { await env.RECIPES.put(recipeKey(host), JSON.stringify(recipe)); shared = true; }
    else shared = await vouch(env, host, recipe, await clientKey(env, today(), ip));
  }
  if (own && feedback) await logReport(env, { ts: Date.now(), host, url: payload.url, ...feedbackCols(feedback), outcome: 'derived', recipe_useful: useful ? 1 : 0, recipe_notes: recipe.notes || null, model: recipe.model });
  return json({ host, recipe, cached: false, shared }, 200, origin);
}

const feedbackCols = (f) => ({ correct_availability: f.correct_availability, correct_price: f.correct_price, note: f.note });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin') || '*';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname === '/privacy') return new Response(PRIVACY_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/recipe') return handleRecipe(req, env, url, origin);

    const isIntake = url.pathname === '/feedback' || url.pathname === '/errors';
    if (url.pathname !== '/reports' && !isIntake) return json({ error: 'not found' }, 404, origin);
    // POST /feedback, POST /errors → reports from users of the published extension (public, rate-limited).
    if (isIntake && req.method === 'POST') return intake(req, env, url.pathname.slice(1), origin);

    // GET /reports | /feedback | /errors ?limit=&host=… → a log, most recent first (operator only).
    // /reports holds the operator's own corrections; /feedback and /errors are what users sent.
    if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, origin);
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, origin);
    if (!env.REPORTS) return json({ error: 'reports DB not configured' }, 501, origin);
    const table = url.pathname.slice(1);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const host = table === 'errors' ? '' : normalizeHost(url.searchParams.get('host'));
    const q = host
      ? env.REPORTS.prepare(`SELECT * FROM ${table} WHERE host = ? ORDER BY ts DESC LIMIT ?`).bind(host, limit)
      : env.REPORTS.prepare(`SELECT * FROM ${table} ORDER BY ts DESC LIMIT ?`).bind(limit);
    const { results } = await q.all();
    return json({ [table]: results }, 200, origin);
  }
};
