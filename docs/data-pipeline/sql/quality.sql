-- Data-quality report per symbol: coverage, gaps and integrity checks.
WITH g AS (
  SELECT symbol, ts, open, high, low, close, volume,
         ts - LAG(ts) OVER (PARTITION BY symbol ORDER BY ts) AS dt
  FROM bars
)
SELECT symbol,
       COUNT(*)                                                    AS bars,
       MIN(ts)                                                     AS first_ts,
       MAX(ts)                                                     AS last_ts,
       (MAX(ts) - MIN(ts)) / 60 + 1 - COUNT(*)                     AS missing_minutes,
       SUM(CASE WHEN dt > 60 THEN 1 ELSE 0 END)                    AS gaps,
       COALESCE(MAX(dt) / 60 - 1, 0)                               AS longest_gap_minutes,
       SUM(CASE WHEN low > MIN(open, close) OR high < MAX(open, close) THEN 1 ELSE 0 END) AS ohlc_violations,
       SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END)                 AS zero_volume_bars
FROM g
GROUP BY symbol
ORDER BY symbol;
