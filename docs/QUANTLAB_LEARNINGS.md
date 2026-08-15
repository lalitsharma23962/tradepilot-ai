# QuantLab learnings applied to TradePilot AI

This document records the engineering lessons extracted from the QUANTLAB paper/validation implementation and its observed behavior. It is intentionally not a claim of profitability.

## Observed evidence

The reviewed QUANTLAB configuration produced 66 OOS trades, 33.33% win rate, -0.20R expectancy, 0.84 profit factor, -$323.49 net P&L and an 87.5% Monte Carlo probability of loss. The correct conclusion was rejection, not threshold relaxation.

## Changes applied here

1. **Validation-to-paper configuration lock**
   - Paper trading now loads the symbol and timeframe from the latest validation gate instead of silently scanning every configured symbol/timeframe.
   - A rejected or insufficient validation gate still permits paper research, but the engine labels the run as research and keeps the exact validated symbol/timeframe.

2. **Canonical fixed 2R target behavior**
   - The production strategy remains on the existing fixed 2R ladder rather than dynamically changing the final target just to improve historical results.
   - The paper position now stores the final 2R target separately from the currently active partial target.

3. **Signal vs execution auditability**
   - Every new paper position receives a signal ID.
   - Signal timestamp, signal entry, signal stop and final target are persisted separately from the actual execution entry.
   - Closed trades carry the same telemetry so signal-to-execution-to-exit behavior can be reconstructed.

4. **Realistic cost accounting remains explicit**
   - Gross P&L and fees are stored separately on closed paper trades.
   - Net P&L remains the amount used for account accounting.

5. **Cooldown semantics fixed**
   - `cooldownBars` is now interpreted as elapsed bars of the active validated timeframe rather than as 15-second engine ticks.

6. **No synthetic paper prices in the production engine**
   - The active paper engine continues to require completed Binance market data.

## What is deliberately NOT changed

- Validation gates are not weakened to make a strategy pass.
- No 100% certainty claim is introduced.
- No 1:10 or 1:15 target is forced into production without evidence.
- No future information is intentionally introduced into signal generation or execution.
- A rejected historical validation remains rejected.

## Next research step

Run fresh validation on the exact symbol/timeframe that the paper engine will use, then compare OOS expectancy, profit factor, drawdown, trade count and Monte Carlo results before changing production parameters.
