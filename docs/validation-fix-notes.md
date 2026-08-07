# v28 validation parity fix

The canonical production strategy owns the stop and reward multiple. Production callers must not pass a fixed `riskReward` override; the validator may pass research min/max bounds (1.5R–3R) but must consume `signal.riskReward`.

The required completed-hour higher-timeframe confirmation is fail-closed when fewer than 50 completed hourly candles are available.

CI must pass `npm run typecheck` and `npm run build` before paper trading is considered.
