# Validation fix — 2026-08-16

The validation UI previously conflated two different states:

1. insufficient sample size, and
2. sufficient data with a strategy that failed chronological pre-OOS gates.

The validator also did not pass its funnel counters into the production strategy evaluator, so `barsEvaluated` could remain zero even while the backtest evaluated bars.

This fix keeps the conservative gates intact. It does **not** lower trade-count, profit-factor, return, drawdown, or Monte Carlo thresholds. It instead makes the evidence report honest and allows the untouched OOS segment to be measured even when pre-OOS folds fail.
