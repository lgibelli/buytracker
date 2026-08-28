// Claude Haiku 4.5 client — the "nano" fallback that runs only when the deterministic
// JSON-LD path can't decide. Called directly from the extension via fetch.
//
// Security note: the API key lives in chrome.storage.local. Acceptable for a personal,
// single-user tool. The hardening path (later) is a tiny local proxy that holds the key.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const REPORT_TOOL = {
  name: 'report_product',
  description: 'Report the main product on the page and whether a new discount/offer appeared vs the baseline.',
  input_schema: {
    type: 'object',
    properties: {
      price: { type: ['number', 'null'], description: "The MAIN product's own current selling price, or null if this product shows no price (unavailable / sold out). Never a related, sponsored or accessory item's price." },
      currency: { type: ['string', 'null'], description: 'ISO currency code, e.g. EUR, PLN, USD.' },
      availability: { type: ['string', 'null'], description: 'in stock | out of stock | preorder | unknown' },
      list_price: { type: ['number', 'null'], description: 'Original/struck-through price if a discount is shown, else null.' },
      new_offer: { type: 'boolean', description: 'True if a discount/promo/price drop is present now that was NOT in the baseline.' },
      summary: { type: 'string', description: 'One short sentence describing the current price situation or any new offer.' }
    },
    required: ['price', 'currency', 'availability', 'new_offer', 'summary']
  }
};

function buildPrompt({ baselineText, currentText, lastPrice, currency, knownAvailability }) {
  const trim = (s) => (s || '').slice(0, 6000);
  return [
    'You compare two captures of the SAME product page to detect price/offer changes.',
    lastPrice != null ? `Last known price: ${lastPrice} ${currency || ''}.` : 'No prior price recorded.',
    knownAvailability ? `The page's own availability signal reads: ${knownAvailability}.` : '',
    '',
    '=== BASELINE (when the watch was created) ===',
    trim(baselineText),
    '',
    '=== CURRENT (now) ===',
    trim(currentText),
    '',
    'Call report_product with the CURRENT main-product price/currency/availability. Ignore related/recommended items.',
    // A product page carries many amounts and only one of them (sometimes none) is the product's.
    // Without this the model treats "report the price" as "find a number", and on an unavailable
    // listing — where the only amounts belong to the sponsored/"also bought" rails — returns one of
    // those. price:null is the correct, useful answer there; a neighbour's price is a false reading.
    'price MUST be the price of the product this page is about. If that product shows no price of its own —',
    'it is unavailable, sold out, or only "see other sellers" — report price: null. NEVER report a price taken',
    'from a sponsored, recommended, "customers also bought", carousel, or accessory item, or from a shipping fee.',
    'Set new_offer=true only if a discount, promo, coupon, or price drop is present now that was not in the baseline.'
  ].filter(Boolean).join('\n');
}

export async function detectOffer({ apiKey, model, baselineText, currentText, lastPrice, currency, knownAvailability }) {
  if (!apiKey) throw new Error('No API key configured');
  // Bounded like every other network call here — an untimed fetch can park a whole check pass
  // (checkDue runs watches sequentially), which is how passes end up outliving the alarm tick.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5',
        max_tokens: 512,
        tools: [REPORT_TOOL],
        tool_choice: { type: 'tool', name: 'report_product' },
        messages: [{ role: 'user', content: buildPrompt({ baselineText, currentText, lastPrice, currency, knownAvailability }) }]
      }),
      signal: ctrl.signal
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const tool = (data.content || []).find((b) => b.type === 'tool_use');
  if (!tool) throw new Error('LLM returned no tool_use block');
  return tool.input;
}
