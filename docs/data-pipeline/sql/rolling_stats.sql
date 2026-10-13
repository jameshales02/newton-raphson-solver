-- Rolling statistics for one symbol over a trailing time window of :window minutes.
-- Parameters: :symbol, :window
--   vwap          sum(typical * volume) / sum(volume) over the window, typical = (H + L + C) / 3
--   session_vwap  the same, anchored at 00:00 UTC each day
--   rv_ann        realised volatility: sqrt(sum r^2 / minutes covered * 525,600)
--   park_ann      Parkinson range volatility: sqrt(mean((ln H/L)^2) / (4 ln 2) * 525,600)
-- Windows are time-based (RANGE on ts), so missing minutes shrink the sample instead
-- of silently stretching the window. Values are NULL until 80% of the window is filled.
WITH r AS (
  SELECT ts, high, low, close, volume,
         (high + low + close) / 3.0 AS typical,
         ln(high / low)             AS hl,
         dt,
         ret
  FROM (
    SELECT b.*,
           b.ts - LAG(b.ts) OVER w AS dt,
           CASE WHEN b.ts - LAG(b.ts) OVER w <= 300 THEN ln(b.close / LAG(b.close) OVER w) END AS ret
    FROM bars AS b
    WHERE b.symbol = :symbol
    WINDOW w AS (ORDER BY b.ts)
  )
),
agg AS (
  SELECT ts, close, volume,
         SUM(typical * volume) OVER win / NULLIF(SUM(volume) OVER win, 0)  AS vwap,
         SUM(typical * volume) OVER day / NULLIF(SUM(volume) OVER day, 0)  AS session_vwap,
         SUM(ret * ret) OVER win                                           AS sum_r2,
         SUM(CASE WHEN ret IS NOT NULL THEN dt END) OVER win / 60.0        AS minutes_covered,
         AVG(hl * hl) OVER win                                             AS mean_hl2,
         COUNT(ret) OVER win                                               AS n_returns
  FROM r
  WINDOW win AS (ORDER BY ts RANGE BETWEEN (:window - 1) * 60 PRECEDING AND CURRENT ROW),
         day AS (PARTITION BY ts / 86400 ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
)
SELECT ts,
       close,
       volume,
       CASE WHEN n_returns >= 0.8 * (:window - 1) THEN vwap END                                      AS vwap,
       session_vwap,
       CASE WHEN n_returns >= 0.8 * (:window - 1) THEN sqrt(sum_r2 / minutes_covered * 525600.0) END AS rv_ann,
       CASE WHEN n_returns >= 0.8 * (:window - 1) THEN sqrt(mean_hl2 / (4 * ln(2)) * 525600.0) END   AS park_ann,
       n_returns
FROM agg
ORDER BY ts;
