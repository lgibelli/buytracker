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
      price: { type: ['number', 'null'], description: 'Current selling price as a number, or null if none visible.' },
      currency: { type: ['string', 'null'], description: 'ISO currency code, e.g. EUR, PLN, USD.' },
      availability: { type: ['string', 'null'], description: 'in stock | out of stock | preorder | unknown' },
      list_price: { type: ['number', 'null'], description: 'Original/struck-through price if a discount is shown, else null.' },
      new_offer: { type: 'boolean', description: 'True if a discount/promo/price drop is present now that was NOT in the baseline.' },
      summary: { type: 'string', description: 'One short sentence describing the current price situation or any new offer.' }
    },
    required: ['price', 'currency', 'availability', 'new_offer', 'summary']
  }
};

function buildPrompt({ baselineText, currentText, lastPrice, currency }) {
  const trim = (s) => (s || '').slice(0, 6000);
  return [
    'You compare two captures of the SAME product page to detect price/offer changes.',
    lastPrice != null ? `Last known price: ${lastPrice} ${currency || ''}.` : 'No prior price recorded.',
    '',
    '=== BASELINE (when the watch was created) ===',
    trim(baselineText),
    '',
    '=== CURRENT (now) ===',
    trim(currentText),
    '',
    'Call report_product with the CURRENT main-product price/currency/availability. Ignore related/recommended items.',
    'Set new_offer=true only if a discount, promo, coupon, or price drop is present now that was not in the baseline.'
  ].join('\n');
}

export async function detectOffer({ apiKey, model, baselineText, currentText, lastPrice, currency }) {
  if (!apiKey) throw new Error('No API key configured');
  const res = await fetch(ENDPOINT, {
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
      messages: [{ role: 'user', content: buildPrompt({ baselineText, currentText, lastPrice, currency }) }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const tool = (data.content || []).find((b) => b.type === 'tool_use');
  if (!tool) throw new Error('LLM returned no tool_use block');
  return tool.input;
}
