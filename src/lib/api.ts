import {
  startEngine,
  stopEngine,
  restartEngine,
  isEngineRunning,
  getMarketTicks,
  getAiRecommendation,
  closePosition,
  closeAllPositions,
  resetAccount,
  getTickCount,
} from './engine';
import {
  getAccount,
  getPositions,
  getTrades,
  getPerformance,
  getSnapshots,
  getSettings,
  updateSettings,
} from './repository';

// The "API" layer. In this architecture the backend is the in-browser PGlite
// database + the simulation engine. These functions mirror the REST endpoints
// the spec asks for, returning predictable JSON-shaped objects. Every function
// catches errors and returns a structured result so the UI never sees an
// unexplained 500-equivalent.

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function wrap<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[api] error:', message);
    return { ok: false, error: message };
  }
}

// GET /api/health
export async function health(): Promise<ApiResult<{ status: string; engine: boolean; ticks: number; db: string }>> {
  return wrap(async () => ({
    status: 'ok',
    engine: isEngineRunning(),
    ticks: getTickCount(),
    db: 'pglite',
  }));
}

// GET /api/bot/status
export async function botStatus(): Promise<ApiResult<{ status: string; running: boolean; started_at: string | null; uptime_seconds: number }>> {
  return wrap(async () => {
    const account = await getAccount();
    let uptime = 0;
    if (account.started_at) {
      uptime = Math.round((Date.now() - new Date(account.started_at).getTime()) / 1000);
    }
    return {
      status: account.bot_status,
      running: account.bot_status === 'RUNNING',
      started_at: account.started_at,
      uptime_seconds: uptime,
    };
  });
}

// POST /api/bot/start
export async function botStart(): Promise<ApiResult<{ message: string }>> {
  return wrap(async () => {
    const res = await startEngine();
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  });
}

// POST /api/bot/stop
export async function botStop(): Promise<ApiResult<{ message: string }>> {
  return wrap(async () => {
    const res = await stopEngine();
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  });
}

// POST /api/bot/restart
export async function botRestart(): Promise<ApiResult<{ message: string }>> {
  return wrap(async () => {
    const res = await restartEngine();
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  });
}

// GET /api/portfolio
export async function portfolio(): Promise<ApiResult<{
  cash: number;
  equity: number;
  total_pnl: number;
  realized_pnl: number;
  unrealized_pnl: number;
  open_value: number;
  open_positions: number;
  closed_trades: number;
  bot_status: string;
  started_at: string | null;
}>> {
  return wrap(async () => {
    const account = await getAccount();
    const positions = await getPositions();
    const trades = await getTrades(1000);
    const openValue = positions.reduce((a, p) => a + p.notional, 0);
    const unrealized = positions.reduce((a, p) => a + p.unrealized_pnl, 0);
    return {
      cash: account.cash,
      equity: account.equity,
      total_pnl: account.total_pnl,
      realized_pnl: account.realized_pnl,
      unrealized_pnl: unrealized,
      open_value: openValue,
      open_positions: positions.length,
      closed_trades: trades.length,
      bot_status: account.bot_status,
      started_at: account.started_at,
    };
  });
}

// GET /api/positions
export async function positions(): Promise<ApiResult<import('./types').Position[]>> {
  return wrap(async () => getPositions());
}

// GET /api/trades
export async function trades(): Promise<ApiResult<import('./types').Trade[]>> {
  return wrap(async () => getTrades(500));
}

// GET /api/performance
export async function performance(): Promise<ApiResult<import('./types').Performance>> {
  return wrap(async () => getPerformance());
}

// GET /api/snapshots
export async function snapshots(): Promise<ApiResult<import('./types').Snapshot[]>> {
  return wrap(async () => getSnapshots(500));
}

// GET /api/market
export async function market(): Promise<ApiResult<import('./types').MarketTick[]>> {
  return wrap(async () => getMarketTicks());
}

// GET /api/ai-recommendation
export async function aiRecommendation(symbol?: string): Promise<ApiResult<import('./types').AiRecommendation>> {
  return wrap(async () => getAiRecommendation(symbol));
}

// POST /api/positions/:id/close
export async function closePositionApi(id: string): Promise<ApiResult<{ message: string }>> {
  return wrap(async () => {
    const res = await closePosition(id);
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  });
}

// POST /api/positions/close-all
export async function closeAllApi(): Promise<ApiResult<{ message: string }>> {
  return wrap(async () => {
    const res = await closeAllPositions();
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  });
}

// POST /api/reset
export async function resetApi(): Promise<ApiResult<{ message: string }>> {
  return wrap(async () => {
    const res = await resetAccount();
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  });
}

// GET /api/settings
export async function getSettingsApi(): Promise<ApiResult<import('./types').Settings>> {
  return wrap(async () => getSettings());
}

// PUT /api/settings
export async function updateSettingsApi(s: Partial<import('./types').Settings>): Promise<ApiResult<import('./types').Settings>> {
  return wrap(async () => updateSettings(s));
}
