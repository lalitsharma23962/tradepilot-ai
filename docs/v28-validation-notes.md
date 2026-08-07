# v28 validation notes

This file records the validation integrity rules for the v28 paper-trading gate.

- The gate must remain strict: all three pre-OOS folds must pass minimum trade count, positive return, PF >= 1.05, and max drawdown <= 20% before the untouched OOS segment is eligible.
- Paper trading must remain blocked while the gate is rejected.
- Validator execution must use the same completed-candle decision model as the paper engine.
- Strategy stop and risk/reward values must flow directly into validation and paper execution; validation must not silently replace them.
- 40,000 completed candles are used for the validation window.
