-- Rolling Pearson correlation of synchronous one-minute log returns of two symbols
-- over a trailing window of :window minutes. Parameters: :a, :b, :window
--   corr = (n Sxy - Sx Sy) / sqrt((n Sxx - Sx^2) (n Syy - Sy^2))
-- Both closes are pivoted onto one row per minute (a single pass over the primary
-- key, no join), keeping only minutes where both symbols traded. A return is used
-- only when both symbols also traded in the previous minute, so the two return
-- series are aligned in time.
WITH p AS (
  SELECT ts,
         MAX(CASE WHEN symbol = :a THEN close END) AS ca,
         MAX(CASE WHEN symbol = :b THEN close END) AS cb
  FROM bars
  WHERE symbol IN (:a, :b)
  GROUP BY ts
  HAVING ca IS NOT NULL AND cb IS NOT NULL
),
j AS (
  SELECT ts, x, y
  FROM (
    SELECT ts,
           ts - LAG(ts) OVER w            AS dt,
           ln(ca / LAG(ca) OVER w)        AS x,
           ln(cb / LAG(cb) OVER w)        AS y
    FROM p
    WINDOW w AS (ORDER BY ts)
  )
  WHERE dt = 60
),
s AS (
  SELECT ts,
         COUNT(*) OVER w AS n,
         SUM(x) OVER w AS sx, SUM(y) OVER w AS sy,
         SUM(x * x) OVER w AS sxx, SUM(y * y) OVER w AS syy, SUM(x * y) OVER w AS sxy
  FROM j
  WINDOW w AS (ORDER BY ts RANGE BETWEEN (:window - 1) * 60 PRECEDING AND CURRENT ROW)
)
SELECT ts,
       n,
       CASE WHEN n >= 0.8 * (:window - 1) AND (n * sxx - sx * sx) > 0 AND (n * syy - sy * sy) > 0
            THEN (n * sxy - sx * sy) / sqrt((n * sxx - sx * sx) * (n * syy - sy * sy)) END AS corr
FROM s
ORDER BY ts;
