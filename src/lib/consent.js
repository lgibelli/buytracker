// Firefox asks the user itself before an add-on sends data off the device. The Firefox manifest
// (written by scripts/build-firefox.js) declares what may be sent, under
// browser_specific_settings.gecko.data_collection_permissions, and the user grants it in Firefox's own
// prompt or later in about:addons. Chrome has no such API: there every check here answers yes, and
// BuyTracker's own settings (per-store Allow, error reports) decide alone, as before.
//
// PAGE_DATA is anything that carries a page: the recipe service, the user's own worker, the direct
// Claude API, and wrong-result reports (a page address and an extract). ERRORS is error reports.
export const PAGE_DATA = ['websiteContent', 'browsingActivity'];
export const ERRORS = ['technicalAndInteraction'];

export const browserAsks = () => !!chrome.runtime.getManifest().browser_specific_settings?.gecko?.data_collection_permissions;

// `browser.*`, not `chrome.*`: it's Firefox-only, and there it always returns promises.
const perms = () => globalThis.browser.permissions;

export async function granted(kinds) {
  if (!browserAsks()) return true;
  try { return await perms().contains({ data_collection: kinds }); } catch { return false; }
}

// Call this inside the click handler itself, before anything is awaited: Firefox opens its prompt only
// for a request made while it is handling the user's input. Resolves true once granted (at once, with
// no prompt, if it already was).
export function ask(kinds) {
  if (!browserAsks()) return Promise.resolve(true);
  try { return perms().request({ data_collection: kinds }).catch(() => false); } catch { return Promise.resolve(false); }
}

export function revoke(kinds) {
  if (!browserAsks()) return Promise.resolve();
  try { return perms().remove({ data_collection: kinds }).catch(() => {}); } catch { return Promise.resolve(); }
}

// The settings a check runs with. If the browser has to allow sending page data and hasn't (Firefox,
// never asked or turned off in about:addons), every route that would carry a page is off: the recipe
// service for every store, the user's own worker, and the direct Claude API. Stores allowed earlier get
// their offer back on the card, and its Allow asks Firefox. Never save what this returns.
export async function sendable(settings) {
  if (await granted(PAGE_DATA)) return settings;
  return { ...settings, recipeHosts: [], workerUrl: '', workerToken: '', apiKey: '' };
}
