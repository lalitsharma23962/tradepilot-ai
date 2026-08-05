# Deployment refresh

This file intentionally forces a fresh Vercel production build so the latest `main` commit is rebuilt without reusing the previous deployment artifact.

The validation implementation in `src/lib/backtest.ts` is the source of truth.