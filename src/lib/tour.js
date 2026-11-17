// A step-by-step coachmark tour: dims the page except one element and points a card at it. The popup
// runs one on its first open; its last step hands over to a second one on the Settings page.
// Styles: src/tour.css. Step text is set as HTML: only the constant copy written in this repo goes in.
//
// A step: { target: () => Element|null (null: a centered card), title, text,
//           interactive: the highlighted element stays clickable,
//           primary: { label, action } in place of Next/Done (the tour ends after action) }.
// fitHeight: the page is sized to its content, as the popup is (the browser fits the popup to its
// body). The overlay is position: fixed and adds nothing to that height, so the body is held tall
// enough for every step's card, or the card is cut off.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const PAD = 4; // room around the highlighted element
const GAP = 12; // between the highlight and the card

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.append(e);
  return e;
}

export function startTour(steps, { done = () => {}, fitHeight = false } = {}) {
  let i = 0;
  let ended = false;

  const root = el('div', 'bt-tour');
  const block = el('div', 'bt-tour-block', root); // takes the clicks outside the highlight
  const hole = el('div', 'bt-tour-hole', root);
  const card = el('div', 'bt-tour-card', root);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'bt-tour-title');
  card.setAttribute('aria-describedby', 'bt-tour-text');
  const arrow = el('div', 'bt-tour-arrow', card);
  const dots = el('div', 'bt-tour-dots', card);
  dots.setAttribute('aria-hidden', 'true');
  const live = el('div', '', card);
  live.setAttribute('aria-live', 'polite');
  const title = el('h3', '', live); title.id = 'bt-tour-title';
  const text = el('p', '', live); text.id = 'bt-tour-text';
  const actions = el('div', 'bt-tour-actions', card);
  const left = el('button', 'text', actions); left.type = 'button'; left.id = 'tourSkip';
  el('span', 'sp', actions);
  const back = el('button', '', actions); back.type = 'button'; back.textContent = 'Back';
  const next = el('button', 'primary', actions); next.type = 'button'; next.id = 'tourNext';
  for (let k = 0; k < steps.length; k++) el('i', '', dots);

  function fill(k) {
    const s = steps[k], last = k === steps.length - 1;
    title.textContent = s.title;
    text.innerHTML = s.text;
    [...dots.children].forEach((d, j) => d.classList.toggle('on', j === k));
    left.textContent = last ? 'Done' : 'Skip';
    left.hidden = last && !s.primary; // a plain last step has Done on the right already
    back.hidden = k === 0;
    next.textContent = s.primary ? s.primary.label : last ? 'Done' : 'Next';
  }

  const width = () => Math.min(300, document.documentElement.clientWidth - 20);

  function place() {
    const s = steps[i];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const w = width();
    card.style.width = `${w}px`;
    const t = s.target?.();
    // On a page, the highlight goes mid-screen, clear of sticky bars along the edges (Settings' save
    // bar). Not in a fitHeight page: it's already sized for every step, and while the popup is still
    // growing to that size, scrolling would shift the page under the highlight.
    if (t && !fitHeight) t.scrollIntoView({ block: 'center' });
    const r = t?.getBoundingClientRect();
    if (!t || !r.width) {
      hole.hidden = true;
      block.classList.add('dim');
      block.style.clipPath = '';
      card.className = 'bt-tour-card center';
      card.style.left = `${(vw - w) / 2}px`;
      card.style.top = `${Math.max(10, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    const x = r.left - PAD, y = r.top - PAD, hw = r.width + 2 * PAD, hh = r.height + 2 * PAD;
    hole.hidden = false;
    Object.assign(hole.style, { left: `${x}px`, top: `${y}px`, width: `${hw}px`, height: `${hh}px` });
    hole.style.borderRadius = `${(parseFloat(getComputedStyle(t).borderTopLeftRadius) || 4) + PAD}px`;
    block.classList.remove('dim');
    // Cut the highlight out of the click blocker, so the element under it can be used.
    block.style.clipPath = s.interactive
      ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x}px ${y}px, ${x + hw}px ${y}px, ${x + hw}px ${y + hh}px, ${x}px ${y + hh}px, ${x}px ${y}px)`
      : '';
    const ch = card.offsetHeight;
    const below = y + hh + GAP, above = y - GAP - ch;
    const down = below + ch <= vh - 8 || above < 8;
    card.className = `bt-tour-card ${down ? 'below' : 'above'}`;
    const cx = r.left + r.width / 2;
    const cl = clamp(cx - w / 2, 10, vw - 10 - w);
    card.style.left = `${cl}px`;
    card.style.top = `${down ? below : above}px`;
    arrow.style.left = `${clamp(cx - cl - 6, 14, w - 26)}px`;
  }

  function go(k) {
    i = k;
    fill(i);
    place();
    next.focus({ preventScroll: true });
  }

  async function end(reason) {
    if (ended) return;
    ended = true;
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    document.documentElement.classList.remove('bt-touring', 'bt-fit');
    if (fitHeight) document.body.style.minHeight = '';
    await done(reason);
  }

  function onKey(e) {
    // The arrows page the tour, except in a highlighted field, where they're the field's own keys.
    const arrows = !e.target.closest?.('input, select, textarea');
    if (e.key === 'Escape') { e.preventDefault(); end('skip'); }
    else if (arrows && e.key === 'ArrowRight' && i < steps.length - 1) { e.preventDefault(); go(i + 1); }
    else if (arrows && e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Tab') {
      // Keep focus in the card, plus the highlighted element when it's usable.
      const s = steps[i];
      const own = [...card.querySelectorAll('button')].filter((b) => !b.hidden);
      const t = s.interactive ? s.target?.() : null;
      const ring = t ? [t.matches('input, select, button, a') ? t : t.querySelector('input, select, button, a'), ...own].filter(Boolean) : own;
      const at = ring.indexOf(document.activeElement);
      e.preventDefault();
      ring[(at + (e.shiftKey ? -1 : 1) + ring.length) % ring.length].focus();
    }
  }

  left.addEventListener('click', () => end('skip'));
  back.addEventListener('click', () => go(i - 1));
  next.addEventListener('click', async () => {
    const s = steps[i];
    if (s.primary) { await s.primary.action(); end('action'); }
    else if (i < steps.length - 1) go(i + 1);
    else end('done');
  });

  document.documentElement.classList.add('bt-touring');
  if (fitHeight) document.documentElement.classList.add('bt-fit');
  document.body.append(root);
  if (fitHeight) {
    // The tallest step, measured with each step's own text in the card.
    card.style.width = `${width()}px`;
    let need = 0;
    steps.forEach((s, k) => {
      fill(k);
      const r = s.target?.()?.getBoundingClientRect();
      need = Math.max(need, (r ? r.bottom + PAD + GAP : 30) + card.offsetHeight + 14);
    });
    document.body.style.minHeight = `${Math.ceil(need)}px`;
  }
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  go(0);
  // Steps after the first glide from one highlight to the next.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('animate')));
  return { end };
}
