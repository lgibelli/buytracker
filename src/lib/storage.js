// Thin wrappers over chrome.storage.local. Watches (incl. their price history) live under `watches`.

const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  apiKey: '',
  defaultIntervalMin: 360, // 6h — these are non-urgent buys
  useLlmFallback: true,
  // Optional recipe-derivation worker (see worker/). When both are set, sites the generic extractors
  // can't parse get a per-site recipe derived once and cached, instead of an LLM call every check.
  workerUrl: '',
  workerToken: ''
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// One-off UI/onboarding state (tour seen, dismissed hints). Kept separate from settings
// so clearing it can't disturb a user's real configuration.
export async function getUi() {
  const { ui } = await chrome.storage.local.get('ui');
  return ui || {};
}

export async function setUi(patch) {
  const ui = await getUi();
  const next = { ...ui, ...patch };
  await chrome.storage.local.set({ ui: next });
  return next;
}

export async function getWatches() {
  const { watches } = await chrome.storage.local.get('watches');
  return watches || {};
}

export async function getWatch(id) {
  return (await getWatches())[id] || null;
}

export async function putWatch(watch) {
  const watches = await getWatches();
  watches[watch.id] = watch;
  await chrome.storage.local.set({ watches });
  return watch;
}

export async function deleteWatch(id) {
  const watches = await getWatches();
  delete watches[id];
  await chrome.storage.local.set({ watches });
}

export function newId() {
  return 'w_' + Math.abs(hash(Date.now() + ':' + Math.floor(performance.now() * 1000))).toString(36);
}

function hash(s) {
  s = String(s);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// Single source of truth: map a schema.org ItemAvailability value (or freeform string) to
// 'in' | 'out' | null. Availability answers "purchasable now?", independent of price. The
// schema.org enumeration is finite and known, so we classify BOTH directions explicitly and
// return null for anything we don't recognise — we never guess "out" from an unknown string.
// Every consumer (change detection here, the popup badge) imports this so they can't drift.
export function availState(a) {
  const s = String(a || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  // Not buyable now: gone, sold out, or not yet released.
  if (/outofstock|soldout|discontinued|backorder|preorder|presale/.test(s)) return 'out';
  // Available now — includes channel-restricted (online/in-store only), limited, and made-to-order.
  if (/instock|onlineonly|instoreonly|limitedavailability|madetoorder/.test(s)) return 'in';
  return null;
}

// Is a price the PRODUCT'S price, or a bystander's? A structured source (a schema.org offer, a
// Shopify variant, a per-site recipe) names the product itself, so its price is always the
// product's own. A price merely READ off the rendered page — the DOM scan's "most prominent
// amount", or the LLM reading page text — is a guess about which of the page's many amounts
// belongs to the product, and a listing that can't be bought usually shows NO price of its own:
// every amount on it belongs to a sponsored / "also viewed" / carousel neighbour. That is how
// 18,99 zł from a carousel became an unavailable amazon.pl robot's price.
export function trustedPrice(price, { structured, availability }) {
  if (price == null || structured) return price ?? null;
  return availState(availability) === 'out' ? null : price;
}

// Append a price/availability point only when something actually changes (CamelCamelCamel-style
// step series). Returns the change kind: 'new' | 'drop' | 'rise' | 'restock' | 'oos' | 'change' | null.
export function recordObservation(watch, { t, price, currency, availability }) {
  watch.history = watch.history || [];
  const prev = watch.history[watch.history.length - 1] || null;
  const sCur = availState(availability), sPrev = prev ? availState(prev.availability) : null;
  let kind = null;
  if (!prev) kind = 'new';
  else if (sPrev === 'out' && sCur === 'in') kind = 'restock';
  else if (sPrev === 'in' && sCur === 'out') kind = 'oos';
  else if (price != null && prev.price != null && price < prev.price) kind = 'drop';
  else if (price != null && prev.price != null && price > prev.price) kind = 'rise';

  const priceChanged = !prev || prev.price !== price;
  const availChanged = !prev || (prev.availability || '') !== (availability || '');
  if (priceChanged || availChanged) {
    watch.history.push({ t, price: price ?? null, availability: availability || null });
    if (watch.history.length > 1000) watch.history = watch.history.slice(-1000);
  }
  if (currency) watch.currency = currency;
  // lastPrice is sticky for display, so a check that reads nothing doesn't blank the card — EXCEPT
  // when the product is known to be unpurchasable AND carries no price: there is nothing current to
  // show, and holding the old number is what kept a once-recorded bystander price on the card
  // forever. The history (and the chart) still keeps every price the watch ever saw.
  watch.lastPrice = price ?? (availState(availability) === 'out' ? null : (watch.lastPrice ?? null));
  watch.lastAvailability = availability || watch.lastAvailability || null;
  return priceChanged || availChanged ? (kind || 'change') : null;
}
