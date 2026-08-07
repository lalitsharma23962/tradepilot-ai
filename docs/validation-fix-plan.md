# v28 validation fix plan

This branch preserves the existing validation gate. It does not lower minimum trades, profit factor, positive-return, drawdown, OOS, or Monte Carlo requirements.

Fixes applied in the v28 strategy/backtest execution path:
- prevent a new trade from being opened on the final bar of a fold and then immediately force-closed at the same close;
- make retest/reclaim signals require an actual recent EMA reclaim rather than merely having a historical close within a broad ATR band;
- require confirmation on the reclaim bar so the retest family is not the dominant low-quality signal source;
- keep score-scaled 1.5R–3R research targets and the existing strict gate;
- keep paper execution and validation on the same signal contract.
