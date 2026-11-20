// Product groups: one product watched at several stores. A watch's `group` names its group and is
// shared between computers like the rest of its setup (storage.js SPEC_FIELDS). A group is nothing
// more than the watches carrying the same one, so there is nothing else to store or sync, and a group
// left with a single watch shows as a plain watch again.
import { updateWatch, availState, newId } from './storage.js';

// A GTIN (EAN-13, UPC-A, EAN-8, GTIN-14) as a page states it, if it is one: a valid length and a
// correct GS1 check digit. Anything else in a gtin field (a SKU, an all-zero placeholder) is null.
export function normGtin(v) {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim().replace(/[\s-]/g, '');
  if (!/^(\d{8}|\d{12,14})$/.test(s) || /^0+$/.test(s)) return null;
  let sum = 0;
  for (let i = s.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(s[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(s[s.length - 1]) ? s : null;
}

// The same GTIN at whatever length it was written (a UPC-A is an EAN-13 with a leading zero).
export const sameGtin = (a, b) => !!a && !!b && a.padStart(14, '0') === b.padStart(14, '0');

// Area watches follow part of a page, not a product's price, so they are never grouped.
export const groupable = (w) => !!w && !w.selector;

// Watch map → Map of group id → its watches, for groups of two or more, cheapest first.
export function groupsOf(watches) {
  const by = new Map();
  for (const w of Object.values(watches)) {
    if (!w.group || !groupable(w)) continue;
    if (!by.has(w.group)) by.set(w.group, []);
    by.get(w.group).push(w);
  }
  for (const [g, ws] of by) {
    if (ws.length < 2) by.delete(g);
    else by.set(g, byPrice(ws));
  }
  return by;
}

const buyable = (w) => w.lastPrice != null && availState(w.lastAvailability) !== 'out';

// Members in the order a shopper reads them: what can be bought, cheapest first, then the rest.
function byPrice(ws) {
  const best = cheapest(ws);
  const cur = best?.currency || '';
  const rank = (w) => (buyable(w) ? ((w.currency || '') === cur ? 0 : 1) : w.lastPrice != null ? 2 : 3);
  return [...ws].sort((a, b) => rank(a) - rank(b) || (a.lastPrice ?? Infinity) - (b.lastPrice ?? Infinity) || (a.createdAt || 0) - (b.createdAt || 0));
}

// The cheapest watch that can be bought now: priced, not out of stock, in the currency most of those
// are priced in (prices in two currencies don't compare; a tie goes to the oldest watch's).
export function cheapest(ws) {
  const priced = ws.filter(buyable).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!priced.length) return null;
  const n = new Map();
  for (const w of priced) n.set(w.currency || '', (n.get(w.currency || '') || 0) + 1);
  const cur = [...n].sort((a, b) => b[1] - a[1])[0][0];
  return priced.filter((w) => (w.currency || '') === cur).sort((a, b) => a.lastPrice - b.lastPrice)[0];
}

// The id a watch's group has, or a new one when the first other store joins it. Never derived from the
// watch's own id: a watch that left a group must not lead the next store it is grouped with back into it.
export const groupIdFor = (w) => w.group || 'g_' + newId().slice(2) + Math.random().toString(36).slice(2, 6);

function setGroup(id, group) {
  return updateWatch(id, (w) => (w && w.group !== group ? { ...w, group } : null));
}

// `id` becomes the same product as `targetId`: it joins the target's group, which starts here if the
// target had none.
export async function joinGroup(id, targetId) {
  let group = null;
  await updateWatch(targetId, (t) => {
    if (!groupable(t)) return null;
    group = groupIdFor(t);
    return t.group ? null : { ...t, group };
  });
  if (!group) throw new Error('Watch not found');
  await updateWatch(id, (w) => (groupable(w) && w.group !== group ? { ...w, group } : null));
  return group;
}

export const leaveGroup = (id) => setGroup(id, null);

// The user said two watches with the same EAN are not the same product: stop suggesting it. Kept on
// this computer only.
export function notSame(id, otherId) {
  return updateWatch(id, (w) => w && { ...w, notSame: [...new Set([...(w.notSame || []), otherId])] });
}

// The watch to suggest grouping `w` with, from its EAN, or null. Shown on one card of the pair only:
// the one that would join (a lone watch joins a group), or the newer of two lone watches.
export function suggestedMatch(w, all, groups) {
  if (!w.gtin || !groupable(w)) return null;
  const inGroup = (x) => !!x.group && groups.has(x.group);
  if (inGroup(w)) return null;
  for (const o of all) {
    if (o.id === w.id || !groupable(o) || !sameGtin(w.gtin, o.gtin)) continue;
    if ((w.notSame || []).includes(o.id) || (o.notSame || []).includes(w.id)) continue;
    if (!inGroup(o) && ((o.createdAt || 0) > (w.createdAt || 0) || ((o.createdAt || 0) === (w.createdAt || 0) && o.id > w.id))) continue;
    return o;
  }
  return null;
}

// A result link as a watch's address: without the fragment and the click-tracking parameters search
// engines and ad networks append (Google adds srsltid to store results), which would make the same
// page look like a different one.
const TRACKING = /^(srsltid|gclid|gbraid|wbraid|dclid|fbclid|msclkid|utm_[a-z]+)$/i;
export function cleanLink(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.href;
}
export const sameLink = (a, b) => cleanLink(a) === cleanLink(b);
