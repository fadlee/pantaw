-- Root disk usage in bytes; `disk` only held the percentage, so the chart
-- had no used/total size to plot.
ALTER TABLE metrics ADD COLUMN disk_used INTEGER;  -- bytes
ALTER TABLE metrics ADD COLUMN disk_total INTEGER; -- bytes
