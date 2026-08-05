# TradePilot AI — 2026 research protocol

Updated: 2026-08-05

## What changed

The historical validator now uses up to 40,000 completed BTCUSDT 5-minute Binance spot candles, rather than a 20,000-candle window. The window is fetched dynamically, so a validation run on 5 August 2026 includes the most recent market history available at run time rather than a hard-coded July cutoff.

The selection protocol is now:

1. 50% training window.
2. 20% pre-out-of-sample validation window split into two sequential folds.
3. 30% untouched final OOS window.
4. Candidate eligibility by minimum trade count.
5. Stability filter across the two pre-OOS folds.
6. Selection using return, profit factor, Sharpe/Sortino, drawdown, fold stability and an overfit penalty.
7. Final OOS is evaluated only after selection.
8. Monte Carlo trade-resampling is used as a separate robustness check.
9. Fees and slippage are included in every simulated entry and exit.
10. Paper trading remains blocked unless the final gate passes.

## Strategy families covered

- Regime-aware production trend/breakout
- EMA trend + momentum
- Donchian 20 and 55 breakouts
- EMA pullback
- RSI mean reversion
- Bollinger mean reversion
- MACD trend
- Volatility range breakouts at 20/30/40 bars
- 21-bar and 72-bar momentum
- Regime hybrid
- Volatility contraction breakout
- ATR channel trend
- Z-score mean reversion

## Important market-data boundary

The current backtest is intentionally spot OHLCV based. It does **not** pretend to have historical funding, open-interest, order-book, liquidation, options-IV, or cross-venue basis data. Those signals are useful research directions, but they must be added with synchronized historical datasets before they are allowed into a backtest score.

This is important because current 2026 research continues to emphasize cost-aware execution and strict walk-forward validation, while also finding that some apparently useful ML/microstructure effects disappear after realistic costs or multiple-testing controls.

## 2026 research context

- Binance's current developer platform exposes spot, USD-M futures, options, WebSocket, SBE and other market-data interfaces; derivative feeds include funding/open-interest style information that can be integrated later.
- Recent 2026 research supports volatility-adaptive trend following, cost-aware trade filters, and multi-fold walk-forward evaluation, but it does not justify assuming that any single strategy will remain profitable out of sample.
- Funding-rate research supports treating funding as a separate carry/positioning factor rather than a standalone directional signal.

The implementation therefore favors **robustness over forcing the gate to pass**. A strategy that fails OOS remains rejected even if it looked good in-sample.
