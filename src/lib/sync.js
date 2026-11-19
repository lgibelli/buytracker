// Shares the watch list between the user's computers through the browser's own sync storage
// (chrome.storage.sync: the Google account in Chrome, the Firefox account in Firefox). Background only.
//
// What is shared is what the user set up, not what the checks found: every computer keeps checking on
// its own, from its own connection and session, with its own price history. Sync storage is small
// (100 KB in all, 8 KB an item, 512 items), and one watch's history alone can outgrow an item.
//
// Keys in chrome.storage.sync:
//   w:<id>    the watch as set up (storage.js specOf), and `u`: when that last changed
//   o:<id>    its last recorded price and stock {t, p, a, c}. A computer that receives it takes it as its
//             own last point, so it doesn't alert again on a change another computer already alerted
//             on, and a newly synced watch starts its chart from it
//   x:<id>    a deleted watch: when. Only a tombstone deletes a watch elsewhere. A watch that is merely
//             missing from sync storage is pushed again, so an emptied sync area (a sign-out, a reset)
//             can never empty the user's computers
//   settings  storage.js SHARED_SETTINGS, and `u`
//
// One pass (sync) reads both sides, merges by time stamp and writes only what differs, so it can run
// whenever either side changes: a pass that finds nothing to do writes nothing to sync storage.
import {
  getSettings, mutateWatches, forgetDeleted, mergeHistory, recordObservation, specOf, SPEC_FIELDS, SHARED_SETTINGS
} from './storage.js';

// chrome.storage.sync's limits (the same in Firefox), less a margin for how the browser counts.
export const QUOTA = { bytes: 102400 - 1024, item: 8192 - 64, items: 512 };
const TOMBSTONE_MS = 90 * 86_400_000;

const syncArea = () => globalThis.chrome?.storage?.sync || null;
const utf8 = (s) => new TextEncoder().encode(s).length;
// What the browser counts an item as: its key plus its value's JSON.
const itemBytes = (k, v) => utf8(k) + utf8(JSON.stringify(v));
const lastPoint = (w) => { const h = w.history || []; return h[h.length - 1] || null; };
// The same watch: same page, same area, same kind. A price watch and a restock watch of one page (the
// right-click menu makes either) are two watches, never twins.
const twinKey = (s) => [s.url || '', s.selector || '', s.watchType || 'both'].join('\n');
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const sharedOf = (s) => defined(Object.fromEntries(SHARED_SETTINGS.map((k) => [k, s[k]])));

export function obsOf(w) {
  const p = lastPoint(w);
  if (!p) return null;
  return defined({ t: p.t, p: p.price ?? undefined, a: p.availability || undefined, c: w.currency || undefined });
}

// Whether a change to local storage is one the other computers need to hear about: a watch added,
// deleted or set up differently, a new price/stock point, a shared setting, the sync switch.
// (A check that found nothing new changes only lastCheckedAt and the like.)
export function syncRelevant(changes) {
  if (changes.syncDeleted) return true;
  if (changes.settings) {
    const a = changes.settings.oldValue || {}, b = changes.settings.newValue || {};
    if (a.syncWatches !== b.syncWatches || a.sharedAt !== b.sharedAt) return true;
  }
  if (changes.watches) {
    const print = (ws) => JSON.stringify(Object.values(ws || {}).map((w) => [w.id, w.specAt || 0, lastPoint(w)?.t || 0]).sort());
    if (print(changes.watches.oldValue) !== print(changes.watches.newValue)) return true;
  }
  return false;
}

// Coalesce a burst of changes (a check pass, the browser delivering a batch) into one pass, and never
// run two at once: a request during a pass queues one more after it.
let timer = null, running = null, again = false;
export function syncSoon(ms = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; runSync(); }, ms);
}
function runSync() {
  if (running) { again = true; return running; }
  running = (async () => {
    try { do { again = false; await sync(); } while (again); } catch (e) { console.warn('sync', e); } finally { running = null; }
  })();
  return running;
}

// A shared watch this computer doesn't have yet, as a watch of its own: the setup, and the last point
// another computer recorded. It has not been checked here, so the next check pass picks it up.
function fromShared(id, s, o) {
  const w = {
    id, url: s.url, title: s.title || s.url, createdAt: s.createdAt || Date.now(), watchType: s.watchType || 'both',
    intervalMin: s.intervalMin || 360, targetPrice: s.targetPrice ?? null, selector: s.selector || null, paused: !!s.paused,
    specAt: s.u || 0, currency: o?.c || null,
    // An area watch needs the rendered page (as when it's picked); the area's text is learned at its
    // first check here, which alerts on nothing.
    fetchMode: s.selector ? 'tab' : 'auto', lastAreaHash: null,
    history: [], lastPrice: null, lastAvailability: null,
    lastCheckedAt: 0, lastStatus: 'ok', lastError: null, lastSummary: null
  };
  if (o) takePoint(w, o);
  return w;
}

function takePoint(w, o) {
  recordObservation(w, { t: o.t, price: o.p ?? null, currency: o.c || null, availability: o.a || null });
}

// Two watches of the same page become one: `keep` gets both histories, as one step series.
function mergeInto(keep, drop) {
  keep.history = mergeHistory(keep.history, drop.history);
  const last = lastPoint(keep);
  if (last) { keep.lastPrice = last.price ?? null; keep.lastAvailability = last.availability || keep.lastAvailability || null; }
  keep.lastCheckedAt = Math.max(keep.lastCheckedAt || 0, drop.lastCheckedAt || 0);
  keep.currency = keep.currency || drop.currency || null;
}

// What fits in sync storage: tombstones and settings first, then watch by watch, oldest first, a
// watch's two keys together or not at all. Returns the items to write and the watches left out.
function fit(remote, set, remove, createdAt) {
  let bytes = 0, items = 0;
  const size = {};
  for (const [k, v] of Object.entries(remote)) {
    if (remove.has(k)) continue;
    size[k] = itemBytes(k, v); bytes += size[k]; items++;
  }
  const out = {}, skipped = new Set();
  const take = (keys) => {
    let nb = bytes, ni = items;
    const n = {};
    for (const k of keys) {
      n[k] = itemBytes(k, set[k]);
      if (n[k] > QUOTA.item) return false;
      nb += n[k] - (size[k] || 0);
      if (!size[k]) ni++;
    }
    if (nb > QUOTA.bytes || ni > QUOTA.items) return false;
    bytes = nb; items = ni;
    for (const k of keys) { size[k] = n[k]; out[k] = set[k]; }
    return true;
  };
  for (const k of Object.keys(set)) if (k.startsWith('x:') || k === 'settings') take([k]);
  const ids = [...new Set(Object.keys(set).filter((k) => /^[wo]:/.test(k)).map((k) => k.slice(2)))]
    .sort((a, b) => (createdAt[a] || 0) - (createdAt[b] || 0));
  for (const id of ids) if (!take(['w:' + id, 'o:' + id].filter((k) => k in set))) skipped.add(id);
  return { out, skipped, bytes, items };
}

export async function sync() {
  const sa = syncArea();
  const settings = await getSettings();
  if (!sa || settings.syncWatches === false) return { off: true };
  const now = Date.now();
  const remote = await sa.get(null);
  const { syncDeleted = {}, syncState: before = {} } = await chrome.storage.local.get(['syncDeleted', 'syncState']);
  const joined = !!before.joinedAt;

  const specs = {}, obs = {}, dead = {};
  for (const [k, v] of Object.entries(remote)) {
    const i = k.indexOf(':');
    if (i < 0 || v == null) continue;
    const kind = k.slice(0, i), id = k.slice(i + 1);
    if (kind === 'w' && v.url) specs[id] = v;
    else if (kind === 'o') obs[id] = v;
    else if (kind === 'x') dead[id] = v;
  }
  const set = {}, remove = new Set();

  // Deletions made on this computer become tombstones.
  for (const [id, t] of Object.entries(syncDeleted)) if (!dead[id]) { dead[id] = t; set['x:' + id] = t; }

  // The same page shared twice (two computers that both watched it, joining at the same time): every
  // computer keeps the oldest one, so they all agree, and merges the other into it.
  const alias = {}, carried = {};
  const groups = {};
  for (const [id, s] of Object.entries(specs)) if (!dead[id]) (groups[twinKey(s)] ||= []).push(id);
  for (const ids of Object.values(groups)) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => (specs[a].createdAt || 0) - (specs[b].createdAt || 0) || (a < b ? -1 : 1));
    for (const loser of ids.slice(1)) {
      alias[loser] = ids[0]; dead[loser] = now; set['x:' + loser] = now;
      if (obs[loser]) (carried[ids[0]] ||= []).push(obs[loser]); // its last point may be the newer one
    }
  }
  for (const [id, t] of Object.entries(dead)) {
    if (specs[id]) remove.add('w:' + id);
    if (obs[id]) remove.add('o:' + id);
    delete specs[id]; delete obs[id];
    if (remote['x:' + id] != null && now - t > TOMBSTONE_MS) remove.add('x:' + id);
  }

  // Settings: the newer side wins. A computer's first pass keeps the stores it was asked about as well.
  const rs = remote.settings;
  let localSettings = null;
  // An install that never changed them shares its defaults as the oldest possible: a new computer that
  // runs before its browser has downloaded anything must not override the settings already shared.
  if (!rs) set.settings = { ...sharedOf(settings), u: settings.sharedAt || 0 };
  else if (!joined) {
    const hosts = [...new Set([...(rs.recipeHosts || []), ...(settings.recipeHosts || [])])];
    const declined = [...new Set([...(rs.recipeDeclined || []), ...(settings.recipeDeclined || [])])].filter((h) => !hosts.includes(h));
    const merged = { ...sharedOf(rs), recipeHosts: hosts, recipeDeclined: declined };
    localSettings = { ...merged, sharedAt: now };
    set.settings = { ...merged, u: now };
  } else if ((rs.u || 0) > (settings.sharedAt || 0)) localSettings = { ...sharedOf(rs), sharedAt: rs.u };
  else if ((settings.sharedAt || 0) > (rs.u || 0)) set.settings = { ...sharedOf(settings), u: settings.sharedAt };
  if (localSettings) {
    const { settings: stored = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...stored, ...localSettings } });
  }

  const createdAt = {};
  let added = 0;
  await mutateWatches((ws) => {
    let changed = false;
    // 1. Deleted on another computer, or merged into its twin.
    for (const id of Object.keys(ws)) {
      if (!dead[id]) continue;
      const into = alias[id];
      if (into && specs[into]) {
        if (ws[into]) mergeInto(ws[into], ws[id]);
        else ws[into] = { ...ws[id], id: into, createdAt: specs[into].createdAt };
      }
      delete ws[id]; changed = true;
    }
    // 2. A watch never shared from here, of a page another computer shares: it's that watch.
    const byTwin = {}, keptTarget = {};
    for (const [id, s] of Object.entries(specs)) byTwin[twinKey(s)] = id;
    for (const w of Object.values(ws)) {
      const sid = byTwin[twinKey(w)];
      if (specs[w.id] || !sid || sid === w.id) continue;
      if (ws[sid]) mergeInto(ws[sid], w);
      else ws[sid] = { ...w, id: sid, createdAt: specs[sid].createdAt };
      if (w.targetPrice != null) keptTarget[sid] = w.targetPrice;
      delete ws[w.id]; changed = true;
    }
    // 3. Shared watches: add those this computer lacks; take a newer setup and a newer point.
    for (const [id, s] of Object.entries(specs)) {
      const o = obs[id] || null;
      let w = ws[id];
      if (!w) { ws[id] = w = fromShared(id, s, o); added++; changed = true; }
      if ((s.u || 0) > (w.specAt || 0)) {
        for (const k of SPEC_FIELDS) w[k] = s[k] ?? (k === 'paused' ? false : null);
        w.specAt = s.u;
        changed = true;
      }
      // The shared setup wins, but a target price set here on the same page, where it has none, stays.
      if (keptTarget[id] != null && w.targetPrice == null) { w.targetPrice = keptTarget[id]; w.specAt = now; changed = true; }
      for (const p of [o, ...(carried[id] || [])].filter(Boolean).sort((a, b) => a.t - b.t)) {
        if (p.t <= (lastPoint(w)?.t || 0)) continue;
        const was = JSON.stringify(w);
        takePoint(w, p);
        if (JSON.stringify(w) !== was) changed = true;
      }
    }
    // 4. Push what sync storage lacks, or has older. Watches from before sync have no stamp yet.
    for (const w of Object.values(ws)) {
      createdAt[w.id] = w.createdAt || 0;
      if (!w.specAt) { w.specAt = now; changed = true; }
      const s = specs[w.id];
      if (!s || w.specAt > (s.u || 0)) set['w:' + w.id] = { ...specOf(w), u: w.specAt };
      const mine = obsOf(w), theirs = obs[w.id];
      if (mine && (!theirs || mine.t > theirs.t)) set['o:' + w.id] = mine;
    }
    return changed;
  });

  const { out, skipped, bytes, items } = fit(remote, set, remove, createdAt);
  // Tombstones (and settings) first, so a watch's keys never go before its tombstone is up; then the
  // removals, which free the room fit() counted on; then the rest.
  let error = null, tombstonesUp = false;
  const early = Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith('x:') || k === 'settings'));
  const late = Object.fromEntries(Object.entries(out).filter(([k]) => !(k in early)));
  try {
    if (Object.keys(early).length) await sa.set(early);
    tombstonesUp = true;
    if (remove.size) await sa.remove([...remove]);
    if (Object.keys(late).length) await sa.set(late);
  } catch (e) { error = String(e?.message || e); }

  // Deletions whose tombstone is now in sync storage needn't be kept here any more.
  const up = Object.keys(syncDeleted).filter((id) => (tombstonesUp && early['x:' + id] != null) || remote['x:' + id] != null);
  if (up.length) await forgetDeleted(up);

  const state = {
    at: now, joinedAt: before.joinedAt || (error ? null : now), error,
    // Watches that aren't in sync storage at all because it's full: their cards say so.
    localOnly: [...skipped].filter((id) => !specs[id]),
    full: skipped.size > 0,
    shared: Object.keys(specs).length + Object.keys(out).filter((k) => k.startsWith('w:') && !specs[k.slice(2)]).length,
    bytes: error ? before.bytes ?? null : bytes, items: error ? before.items ?? null : items, added
  };
  await chrome.storage.local.set({ syncState: state });
  return state;
}
