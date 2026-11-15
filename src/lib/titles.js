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
