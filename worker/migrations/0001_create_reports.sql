-- User "report wrong result" submissions, logged for later review.
-- One row per report that reaches derivation (feedback present); auto-derivations are NOT logged.
CREATE TABLE IF NOT EXISTS reports (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   INTEGER NOT NULL,   -- epoch ms (worker clock)
  host                 TEXT NOT NULL,
  url                  TEXT,
  correct_availability TEXT,               -- 'in' | 'out' | null
  correct_price        REAL,               -- user-stated selling price | null
  note                 TEXT,               -- optional free-text hint (data, not instructions)
  outcome              TEXT,               -- 'derived' | 'error'
  recipe_useful        INTEGER,            -- 1 if the re-derived recipe has any extraction signal
  recipe_notes         TEXT,              -- the LLM's one-line notes on how it parsed
  model                TEXT,
  cost_usd             REAL,
  error                TEXT                -- populated when outcome = 'error'
);

CREATE INDEX IF NOT EXISTS idx_reports_ts   ON reports(ts);
CREATE INDEX IF NOT EXISTS idx_reports_host ON reports(host);
