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
  workerToken: '',
  // Send reports of bugs in BuyTracker's own code to the developer (src/lib/report.js). Opt-in.
  sendErrorReports: false
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

// Every watch lives in ONE `watches` map and chrome.storage has no transactions, so each write is a
// read-modify-write of the whole map. Two that overlap — a "check now" finishing while the scheduled
// pass saves another watch — let the later one write back a map read before the earlier one landed,
// silently undoing that check. Writes are serialised per JS context (the service worker does nearly
// all of them); updateWatch also re-reads the watch inside the lock, so a caller never writes back a
// copy that went stale while it was busy.
let writeChain = Promise.resolve();
function serial(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

// mutate(current | null) → the watch to store, or null to store nothing. Resolves to what was stored.
export function updateWatch(id, mutate) {
  return serial(async () => {
    const watches = await getWatches();
    const next = mutate(watches[id] || null);
    if (!next) return null;
    watches[id] = next;
    await chrome.storage.local.set({ watches });
    return next;
  });
}

export function putWatch(watch) {
  return updateWatch(watch.id, () => watch);
}

export function deleteWatch(id) {
  return serial(async () => {
    const watches = await getWatches();
    delete watches[id];
    await chrome.storage.local.set({ watches });
  });
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
  // A field this check could not read is UNKNOWN, not changed. Recording the blank was what filled
  // histories with a "no price / unknown" point every other check (an LLM reply of "unknown", a tab
  // that loaded slowly) — and it hid real moves behind it: 211.89 → blank → 169.51 compared the new
  // price against the blank, so the drop was never reported. So: a check that read nothing records
  // nothing; an unreadable availability carries the last known one forward; an unreadable price
  // carries the last one forward too — unless the product is now known to be unpurchasable, where a
  // listing legitimately shows no price and holding the old one would keep a bystander's on the card.
  const seenAvail = availState(availability) ? availability : null;
  if (price == null && !seenAvail) {
    if (currency) watch.currency = currency;
    return null;
  }
  const avail = seenAvail || prev?.availability || null;
  const sCur = availState(avail), sPrev = prev ? availState(prev.availability) : null;
  const p = price ?? (sCur === 'out' ? null : (prev?.price ?? null));
  let kind = null;
  if (!prev) kind = 'new';
  else if (sPrev === 'out' && sCur === 'in') kind = 'restock';
  else if (sPrev === 'in' && sCur === 'out') kind = 'oos';
  else if (p != null && prev.price != null && p < prev.price) kind = 'drop';
  else if (p != null && prev.price != null && p > prev.price) kind = 'rise';

  const priceChanged = !prev || prev.price !== p;
  const availChanged = !prev || (prev.availability || '') !== (avail || '');
  if (priceChanged || availChanged) {
    watch.history.push({ t, price: p, availability: avail });
    if (watch.history.length > 1000) watch.history = watch.history.slice(-1000);
  }
  if (currency) watch.currency = currency;
  // lastPrice is sticky for display — EXCEPT when the product is known to be unpurchasable AND carries
  // no price: there is nothing current to show, and holding the old number is what kept a
  // once-recorded bystander price on the card forever. The history (and the chart) keeps every price.
  watch.lastPrice = p ?? (sCur === 'out' ? null : (watch.lastPrice ?? null));
  watch.lastAvailability = avail || watch.lastAvailability || null;
  return priceChanged || availChanged ? (kind || 'change') : null;
}
