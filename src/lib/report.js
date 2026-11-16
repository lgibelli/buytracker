// Reports to the developer, sent only when the user chooses to (privacy.html, "Reports you choose to
// send"). Two kinds, both to the developer's worker (worker/src/index.js, POST /feedback and /errors):
//   - a wrong-result report, one at a time, when the user ticks "send to the developer" (or, without a
//     recipe worker of their own, presses "Send to the developer"): sendFeedback()
//   - error reports for bugs in BuyTracker's own code, only while "Send error reports" is on in
//     Settings (off by default): reportError(), installErrorReporting()
// No account, no install id, nothing that links one report to another.
import { getSettings, availState } from './storage.js';

export const DEV_ENDPOINT = 'https://buytracker-recipes.nervoso.workers.dev';
const MAX_ERRORS_PER_DAY = 20;

const version = () => chrome.runtime.getManifest().version;

// The address without its query string and fragment, which is where tracking and session ids live.
export function pageAddress(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return null; }
}

// Strip what could identify the user or the pages they visit from an error text: the extension id
// (frames become src/<file>.js:line:col), web addresses, emails, and double-quoted values (V8 quotes
// the text it failed on, e.g. JSON.parse echoes the start of a page). Single-quoted property names
// ("reading 'price'") are kept: they are what make an error fixable.
export function scrub(text, max) {
  return String(text ?? '')
    .replace(/chrome-extension:\/\/[a-p]{32}\//g, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/"[^"\n]*"/g, '"…"')
    .slice(0, max);
}

async function post(path, body) {
  return fetch(DEV_ENDPOINT + path, {
    method: 'POST', keepalive: true, credentials: 'omit',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

// One wrong-result report: what BuyTracker showed (`watch`, as it was when the user reported), the
// per-site recipe in use, the user's correction, and — when their own worker re-derived — what the
// re-check read and whether that matches the correction (`outcome`).
export async function sendFeedback({ watch, recipe, feedback, outcome, after }) {
  const res = await post('/feedback', {
    version: version(), url: pageAddress(watch.url), watch_type: watch.watchType || 'both',
    read: {
      price: watch.lastPrice ?? null, currency: watch.currency || null, availability: availState(watch.lastAvailability),
      status: watch.lastStatus || null, error: watch.lastError ? scrub(watch.lastError, 300) : null, fetch_mode: watch.fetchMode || null
    },
    recipe: recipe || null,
    correction: { availability: feedback.correct_availability || null, price: feedback.correct_price ?? null, note: feedback.note || null },
    outcome,
    after: after ? { price: after.lastPrice ?? null, availability: availState(after.lastAvailability) } : null
  });
  if (res.status === 429) throw new Error('Too many reports from your network today. Try again tomorrow.');
  if (!res.ok) throw new Error(`Couldn't send the report (HTTP ${res.status}).`);
}

// Errors worth a report are programming errors. A failed fetch is also a TypeError, but it is the
// network (or a store blocking us), not a bug.
const BUG_NAMES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError']);
const NETWORK = /failed to fetch|networkerror|network error|load failed|aborted|timed? ?out/i;
export const isBug = (e) => !!e && BUG_NAMES.has(e.name) && !NETWORK.test(e.message || '');

// Sends one error when the user has error reports on. Each distinct error goes at most once a day,
// and at most MAX_ERRORS_PER_DAY in all, so a bug hit on every check sends one report, not hundreds.
// Never throws: reporting must not become a second failure.
export async function reportError(err, context) {
  try {
    if (!err || !(await getSettings()).sendErrorReports) return;
    const name = scrub(err.name || 'Error', 60);
    const message = scrub(err.message ?? err, 500);
    const stack = scrub(err.stack || '', 2000);
    const frame = /src\/[\w/.-]+:\d+/.exec(stack)?.[0] || '';
    const key = `${name}|${message}|${frame}`;
    const day = new Date().toISOString().slice(0, 10);
    const { errorReports: log } = await chrome.storage.local.get('errorReports');
    const sent = log?.day === day ? log.sent : [];
    if (sent.includes(key) || sent.length >= MAX_ERRORS_PER_DAY) return;
    await chrome.storage.local.set({ errorReports: { day, sent: [...sent, key] } });
    await post('/errors', { version: version(), context, name, message, stack });
  } catch { /* offline, or the report itself failed: drop it */ }
}

// Uncaught errors and unhandled rejections in this page or the service worker. Caught errors are
// reported where they are caught (background.js), and only when isBug().
export function installErrorReporting(context) {
  self.addEventListener('error', (ev) => {
    reportError(ev.error instanceof Error ? ev.error
      : { name: 'Error', message: ev.message, stack: ev.filename ? `at ${ev.filename}:${ev.lineno}:${ev.colno}` : '' }, context);
  });
  self.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    if (r instanceof Error && NETWORK.test(r.message)) return;
    reportError(r instanceof Error ? r : { name: 'UnhandledRejection', message: String(r) }, context);
  });
}
