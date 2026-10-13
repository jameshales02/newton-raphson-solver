-- Market data store. Shared by the Python pipeline (sqlite3) and the in-browser
-- demo (sql.js): both execute these exact files.

-- One row per symbol per minute. ts is the bar's open time in Unix seconds (UTC).
-- Rows are validated before insert; the CHECK constraints are a second line of defence.
CREATE TABLE IF NOT EXISTS bars (
  symbol      TEXT    NOT NULL,
  ts          INTEGER NOT NULL CHECK (ts % 60 = 0),
  open        REAL    NOT NULL CHECK (open > 0),
  high        REAL    NOT NULL,
  low         REAL    NOT NULL CHECK (low > 0),
  close       REAL    NOT NULL CHECK (close > 0),
  volume      REAL    NOT NULL CHECK (volume >= 0),
  source      TEXT    NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, ts),
  CHECK (low <= open AND low <= close AND high >= open AND high >= close)
) WITHOUT ROWID;

-- Audit trail: one row per symbol per ingest run.
CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id        INTEGER PRIMARY KEY,
  source        TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  rows_fetched  INTEGER,
  rows_written  INTEGER,
  rows_rejected INTEGER,
  first_ts      INTEGER,
  last_ts       INTEGER,
  status        TEXT
);

-- Log returns between consecutive bars. dt is the step in seconds: 60 for adjacent
-- minutes, more when minutes with no trades are missing. Returns spanning more than
-- five minutes are left NULL rather than stitched across an outage.
CREATE VIEW IF NOT EXISTS returns AS
SELECT symbol,
       ts,
       close,
       ts - LAG(ts) OVER w AS dt,
       CASE WHEN ts - LAG(ts) OVER w <= 300 THEN ln(close / LAG(close) OVER w) END AS r
FROM bars
WINDOW w AS (PARTITION BY symbol ORDER BY ts);
