// BuyTracker recipe-derivation worker.
//
// The extension renders a product page in a real tab (its residential IP + the user's session),
// reduces it to a small snapshot, and POSTs it here when the generic deterministic extractors
// (JSON-LD, Shopify .js, rendered-DOM price/buy-box) couldn't pin the price or stock state.
// This worker asks Claude — ONCE per host — to emit a reusable, declarative parse "recipe"
// (CSS selectors / a window global path / fixed currency). The recipe is cached in KV and the
// extension then runs it deterministically on every future check (free, no LLM), re-deriving
// only when the recipe stops matching (site redesign). Rendering stays in the extension; only
// the "figure out how to parse this site" step lives here, and its cost amortizes to ~zero.
//
// The Anthropic key never leaves the worker. Callers must present AUTH_TOKEN as a bearer token.

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const RECIPE_VERSION = 1;

// Flat, LLM-friendly recipe shape. Every field is optional/nullable; the runner in the extension
// (src/lib/recipe.js → applyRecipe) interprets exactly these keys. Kept flat (no oneOf unions) so
// forced tool-use is reliable. The model is told to copy selectors verbatim from the snapshot.
const RECIPE_TOOL = {
  name: 'emit_recipe',
  description: 'Emit a reusable recipe to extract the MAIN product\'s price, currency, and stock state from this site\'s rendered DOM. Prefer the exact selectors listed in the snapshot. Use null for anything you cannot determine.',
  input_schema: {
    type: 'object',
    properties: {
      notes: { type: 'string', description: 'One short sentence on how you identified the price and stock signal.' },
      price_selector: { type: ['string', 'null'], description: 'CSS selector whose text (or attr) holds the current SELLING price (not the struck/list price). Copy one of the snapshot priceCandidates selectors when possible.' },
      price_attr: { type: ['string', 'null'], description: 'Attribute to read instead of element text, e.g. "content" for a <meta>. Null = use the element text.' },
      price_global: { type: ['string', 'null'], description: 'Dotted path into a window global holding a numeric price, e.g. "ecomm_items.0.price". Use ONLY when no DOM selector works AND the global value matches the displayed (tax-inclusive) price.' },
      currency_code: { type: ['string', 'null'], description: 'Fixed ISO code if this site always uses one currency, e.g. "EUR". Prefer this.' },
      currency_selector: { type: ['string', 'null'], description: 'Else a selector whose text contains the currency symbol/code.' },
      in_stock_selector: { type: ['string', 'null'], description: 'A selector that EXISTS in the DOM only when the product is purchasable (e.g. an enabled add-to-cart button). Used only if no out-of-stock signal matches.' },
      out_of_stock_selector: { type: ['string', 'null'], description: 'A selector that EXISTS only when the product is unavailable (e.g. a sold-out badge, or a disabled add-to-cart). Takes priority over in_stock_selector.' },
      out_of_stock_text: { type: ['string', 'null'], description: 'A literal phrase present in the page text only when out of stock (last-resort fallback).' }
    },
    required: ['notes']
  }
};

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400'
});

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors(origin) } });

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

async function deriveRecipe(snapshot, env) {
  const sys = [
    'You write a reusable extraction recipe for ONE e-commerce site, by inspecting a reduced snapshot',
    'of a rendered product page. The recipe must keep working on OTHER products of the same site, so',
    'prefer stable structural selectors over text. Identify the MAIN product only — ignore related/',
    'recommended items and cross-sell. The SELLING price is the one the customer pays now; a struck-',
    'through / "list"/"old" price is NOT it. Call emit_recipe exactly once.'
  ].join(' ');
  const body = {
    model: env.MODEL || 'claude-haiku-4-5',
    max_tokens: 700,
    system: sys,
    tools: [RECIPE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_recipe' },
    messages: [{ role: 'user', content: 'SNAPSHOT:\n' + JSON.stringify(snapshot).slice(0, 24000) }]
  };
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`anthropic HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const tool = (data.content || []).find((b) => b.type === 'tool_use');
  if (!tool) throw new Error('no tool_use in response');
  const r = tool.input || {};
  // Keep only known keys; coerce types defensively.
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : null);
  return {
    v: RECIPE_VERSION,
    notes: str(r.notes) || '',
    price_selector: str(r.price_selector),
    price_attr: str(r.price_attr),
    price_global: str(r.price_global),
    currency_code: str(r.currency_code),
    currency_selector: str(r.currency_selector),
    in_stock_selector: str(r.in_stock_selector),
    out_of_stock_selector: str(r.out_of_stock_selector),
    out_of_stock_text: str(r.out_of_stock_text),
    model: body.model
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin') || '*';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname !== '/recipe') return json({ error: 'not found' }, 404, origin);
    if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, origin);
    if (!env.ANTHROPIC_KEY) return json({ error: 'server missing ANTHROPIC_KEY' }, 500, origin);

    // GET /recipe?host=… → cached recipe or 404 (lets the extension warm its cache without an LLM call).
    if (req.method === 'GET') {
      const host = normalizeHost(url.searchParams.get('host'));
      if (!host) return json({ error: 'host required' }, 400, origin);
      const cached = await env.RECIPES.get(host, 'json');
      return cached ? json({ host, recipe: cached, cached: true }, 200, origin) : json({ error: 'no recipe' }, 404, origin);
    }

    // DELETE /recipe?host=… → invalidate (e.g. site redesigned).
    if (req.method === 'DELETE') {
      const host = normalizeHost(url.searchParams.get('host'));
      if (!host) return json({ error: 'host required' }, 400, origin);
      await env.RECIPES.delete(host);
      return json({ host, deleted: true }, 200, origin);
    }

    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);

    let payload;
    try { payload = await req.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
    let rawHost = payload.host;
    if (!rawHost && payload.url) { try { rawHost = new URL(payload.url).hostname; } catch { /* malformed → 400 below */ } }
    const host = normalizeHost(rawHost);
    if (!host) return json({ error: 'host required' }, 400, origin);

    if (!payload.force) {
      const cached = await env.RECIPES.get(host, 'json');
      if (cached) return json({ host, recipe: cached, cached: true }, 200, origin);
    }
    if (!payload.snapshot || typeof payload.snapshot !== 'object') {
      return json({ error: 'snapshot required to derive' }, 400, origin);
    }

    let recipe;
    try { recipe = await deriveRecipe(payload.snapshot, env); }
    catch (e) { return json({ error: String(e.message || e) }, 502, origin); }

    await env.RECIPES.put(host, JSON.stringify(recipe));
    return json({ host, recipe, cached: false }, 200, origin);
  }
};
