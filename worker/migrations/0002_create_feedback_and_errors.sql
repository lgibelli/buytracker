-- Reports that users of the published extension CHOOSE to send to the developer (POST /feedback,
-- POST /errors: public, no token). Nothing here identifies a user: no account, no install id, no IP.

-- "Wrong result? Report" submissions where the user ticked "send to the developer".
CREATE TABLE IF NOT EXISTS feedback (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   INTEGER NOT NULL,   -- epoch ms (worker clock)
  version              TEXT,               -- extension version
  host                 TEXT NOT NULL,
  url                  TEXT,               -- origin + path only: the query string and fragment are dropped
  watch_type           TEXT,               -- 'both' | 'price' | 'availability'
  read_price           REAL,               -- what BuyTracker showed before the report
  read_currency        TEXT,
  read_availability    TEXT,               -- 'in' | 'out' | null
  read_status          TEXT,               -- 'ok' | 'no_data' | 'blocked' | 'error'
  read_error           TEXT,
  fetch_mode           TEXT,               -- 'tab' | 'fetch' | null
  recipe               TEXT,               -- JSON: the per-site selectors in use, if any
  correct_availability TEXT,               -- the user's correction: 'in' | 'out' | null
  correct_price        REAL,
  note                 TEXT,               -- optional free-text hint the user typed
  outcome              TEXT,               -- 'fixed' | 'still_wrong' | 'rederived' | 'error' | 'not_attempted'
  after_price          REAL,               -- what the re-check read (when the user's own worker re-derived)
  after_availability   TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts   ON feedback(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_host ON feedback(host);

-- Errors in BuyTracker's own code, sent only when the user turned on "Send error reports".
-- Web addresses, emails and quoted values are removed in the extension before sending.
CREATE TABLE IF NOT EXISTS errors (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  version  TEXT,
  context  TEXT,   -- 'background' | 'popup' | 'options' | 'welcome'
  name     TEXT,   -- TypeError, ...
  message  TEXT,
  stack    TEXT,   -- frames as src/<file>.js:line:col
  browser  TEXT    -- e.g. 'Chrome 131 / macOS', from the User-Agent
);
CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors(ts);

-- Per-day intake counters for rate limiting. A client is a keyed hash of (day, IP): it can't be
-- reversed, can't be linked across days, isn't stored with any report, and is deleted the next day.
CREATE TABLE IF NOT EXISTS intake_counts (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (day, key)
);
