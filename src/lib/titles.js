// Watches on sibling listings (same product, another storage size or colour) often share their title
// up to the one word that differs — and the popup's one-line ellipsis cut both before it, leaving two
// identical-looking cards. For a title that shares its start with another watch's, this returns the
// part that tells it apart, so the card can pin it after the (ellipsized) shared head.

// Shared start, in characters, past which two one-line titles read the same in the popup.
const SIMILAR_PREFIX = 20;

// Trailing text both titles share is dropped only from a separator on, so a store suffix
// (" : Amazon.pl: Elektronika", " | MediaWorld") goes but a unit belonging to the differing value
// (the " GB" of "256 GB" / "512 GB") stays.
const SEP = /\s[|:–—-]\s|:\s/;

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a, b, max) {
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// titles: string[] → [{ head, tail }] in the same order. tail is '' when the title needs no help.
export function titleParts(titles) {
  return titles.map((t, i) => {
    let start = Infinity, cut = Infinity;
    titles.forEach((s, j) => {
      if (j === i || s === t) return; // identical titles: no text can tell them apart
      const p = commonPrefix(t, s);
      if (p < SIMILAR_PREFIX) return;
      const q = commonSuffix(t, s, Math.min(t.length, s.length) - p);
      const sep = SEP.exec(t.slice(t.length - q));
      start = Math.min(start, p);
      cut = Math.min(cut, sep ? q - sep.index : 0);
    });
    if (start === Infinity) return { head: t, tail: '' };
    while (start > 0 && !/\s/.test(t[start - 1])) start--; // back to the start of the differing word
    const head = t.slice(0, start).trim();
    const tail = t.slice(start, t.length - cut).trim();
    return head && tail ? { head, tail } : { head: t, tail: '' };
  });
}

// A watch's title without the store's own name, as a product name for a group and a search: "Roborock
// Qrevo Curv 2 Flow | Roborock IT", "Apple iPhone 15 (128 GB) - Nero : Amazon.it: Elettronica". The
// title is cut at the first separator after which a part names the store's site, so a part that only
// looks like a suffix ("- Nero") stays. The store's name comes from its address, not from a list.
const SEP_ALL = new RegExp(SEP.source, 'g');
const squash = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function storeless(title, url) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  let labels = [];
  try { labels = new URL(url).hostname.split('.').slice(0, -1).map(squash).filter((l) => l.length >= 3 && l !== 'www'); } catch { /* no address */ }
  if (!labels.length) return t;
  const cuts = [...t.matchAll(SEP_ALL)];
  for (let i = 0; i < cuts.length; i++) {
    const part = t.slice(cuts[i].index + cuts[i][0].length, i + 1 < cuts.length ? cuts[i + 1].index : t.length);
    if (labels.some((l) => squash(part).includes(l))) return t.slice(0, cuts[i].index).trim() || t;
  }
  return t;
}

// What "Find in other stores" searches for: the EAN when the page gave one (it finds that exact
// product), else the product's name, up to its first comma (marketplace titles go on with a feature
// list) and at most 12 words.
export function searchQuery(w) {
  if (w.gtin) return w.gtin;
  let q = storeless(w.title || '', w.url);
  const comma = q.indexOf(', ');
  if (comma > 0 && q.slice(0, comma).split(' ').length >= 3) q = q.slice(0, comma);
  return q.split(' ').slice(0, 12).join(' ') || w.url;
}
