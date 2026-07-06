// Dependency-free CamelCamelCamel-style price-history chart, rendered as an inline SVG string.
// History is a step series (points exist only where the price changed), so we draw a step line.

export function priceChartSVG(history, opts = {}) {
  const W = opts.width || 320;
  const H = opts.height || 120;
  const pad = { l: 8, r: 8, t: 10, b: 20 };
  // currency originates from page content — keep only safe currency-code characters.
  const cur = String(opts.currency || '').replace(/[^A-Za-z$€£¥]/g, '').slice(0, 5);
  const pts = (history || []).filter((p) => p.price != null);

  if (pts.length === 0) {
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${W}" height="${H}" rx="6" fill="#0f1216"/>
      <text x="${W / 2}" y="${H / 2}" fill="#7a8794" font-size="11" text-anchor="middle" font-family="sans-serif">no price history yet</text>
    </svg>`;
  }

  const now = Date.now();
  const t0 = Math.min(pts[0].t, now - 1);
  const t1 = Math.max(now, pts[pts.length - 1].t);
  const prices = pts.map((p) => p.price);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;

  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * innerW;
  const y = (p) => pad.t + (1 - (p - lo) / span) * innerH;

  // Step path: hold each price until the next change, then extend flat to "now".
  let d = `M ${x(pts[0].t).toFixed(1)} ${y(pts[0].price).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${x(pts[i].t).toFixed(1)} ${y(pts[i - 1].price).toFixed(1)}`;
    d += ` L ${x(pts[i].t).toFixed(1)} ${y(pts[i].price).toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${x(now).toFixed(1)} ${y(last.price).toFixed(1)}`;

  const dots = pts.map((p) => {
    const drop = p === pts[0] ? false : p.price < pts[pts.indexOf(p) - 1].price;
    const col = drop ? '#34d399' : '#f87171';
    return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="2.5" fill="${col}"/>`;
  }).join('');

  const lowest = Math.min(...prices);
  const lowestPt = pts.find((p) => p.price === lowest);
  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(2));

  // X-axis time labels: evenly spaced ticks from the first observation to "now".
  const spanT = t1 - t0;
  const dateLabel = (t) => {
    const d = new Date(t);
    const p2 = (n) => String(n).padStart(2, '0');
    if (spanT < 22 * 3600e3) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
  };
  const nTicks = Math.max(2, Math.min(4, Math.round(innerW / 120)));
  let axis = '';
  for (let i = 0; i < nTicks; i++) {
    const f = i / (nTicks - 1);
    const xt = pad.l + f * innerW;
    const anchor = i === 0 ? 'start' : i === nTicks - 1 ? 'end' : 'middle';
    axis += `<line x1="${xt.toFixed(1)}" y1="${(H - pad.b).toFixed(1)}" x2="${xt.toFixed(1)}" y2="${(H - pad.b + 3).toFixed(1)}" stroke="#1f2630" stroke-width="1"/>`;
    axis += `<text x="${xt.toFixed(1)}" y="${(H - 6).toFixed(1)}" fill="#5b6b7a" font-size="9" text-anchor="${anchor}">${dateLabel(t0 + f * spanT)}</text>`;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
    <rect width="${W}" height="${H}" rx="6" fill="#0f1216"/>
    <line x1="${pad.l}" y1="${y(hi).toFixed(1)}" x2="${W - pad.r}" y2="${y(hi).toFixed(1)}" stroke="#1f2630" stroke-width="1"/>
    <line x1="${pad.l}" y1="${y(lo).toFixed(1)}" x2="${W - pad.r}" y2="${y(lo).toFixed(1)}" stroke="#1f2630" stroke-width="1"/>
    <text x="${pad.l}" y="${(y(hi) - 2).toFixed(1)}" fill="#5b6b7a" font-size="9">${fmt(hi)}</text>
    <text x="${pad.l}" y="${(y(lo) - 3).toFixed(1)}" fill="#5b6b7a" font-size="9">${fmt(lo)}</text>
    ${axis}
    <path d="${d}" fill="none" stroke="#60a5fa" stroke-width="1.6" stroke-linejoin="round"/>
    ${dots}
    <circle cx="${x(lowestPt.t).toFixed(1)}" cy="${y(lowest).toFixed(1)}" r="3.5" fill="none" stroke="#34d399" stroke-width="1.5"/>
    <circle cx="${x(now).toFixed(1)}" cy="${y(last.price).toFixed(1)}" r="3" fill="#fff"/>
    <text x="${W - pad.r}" y="${(y(last.price) - 4).toFixed(1)}" fill="#e6edf3" font-size="10" text-anchor="end">${fmt(last.price)} ${cur}</text>
  </svg>`;
}
