import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from './api';
import type { Account, Position, Trade, Performance, Snapshot, MarketTick, Settings } from './types';

export type ConnState = 'loading' | 'connected' | 'partial' | 'down';

interface AppState {
  conn: ConnState;
  account: Account | null;
  positions: Position[];
  trades: Trade[];
  performance: Performance | null;
  snapshots: Snapshot[];
  market: MarketTick[];
  settings: Settings | null;
  errors: Record<string, string>;
  refresh: () => void;
}

const Ctx = createContext<AppState | null>(null);

const POLL_MS = 3000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<ConnState>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [market, setMarket] = useState<MarketTick[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // Independent requests — one failure does not break the others.
      const results = await Promise.allSettled([
        api.portfolio(),
        api.positions(),
        api.trades(),
        api.performance(),
        api.snapshots(),
        api.market(),
        api.getSettingsApi(),
      ]);

      const keys = ['portfolio', 'positions', 'trades', 'performance', 'snapshots', 'market', 'settings'];
      const newErrors: Record<string, string> = {};
      let failCount = 0;

      results.forEach((r, i) => {
        const key = keys[i];
        if (r.status === 'rejected') {
          failCount++;
          newErrors[key] = r.reason instanceof Error ? r.reason.message : 'Request failed';
        } else if (!r.value.ok) {
          failCount++;
          newErrors[key] = r.value.error ?? 'Request failed';
        }
      });

      if (mounted.current) {
        setErrors(newErrors);

        if (failCount === 0) setConn('connected');
        else if (failCount < results.length) setConn('partial');
        else setConn('down');

        if (results[0].status === 'fulfilled' && results[0].value.ok && results[0].value.data) {
          // portfolio returns a subset; fetch full account for settings fields
          const acct = await api.portfolio();
          if (acct.ok && acct.data) {
            // Build a full account object from portfolio + settings.
            const s = results[6].status === 'fulfilled' && results[6].value.ok ? results[6].value.data : null;
            setAccount({
              id: 1,
              cash: acct.data.cash,
              equity: acct.data.equity,
              total_pnl: acct.data.total_pnl,
              realized_pnl: acct.data.realized_pnl,
              bot_status: acct.data.bot_status as Account['bot_status'],
              started_at: acct.data.started_at,
              last_tick_at: null,
              max_positions: 3,
              max_allocation_pct: s?.max_allocation_pct ?? 20,
              default_allocation_pct: s?.default_allocation_pct ?? 15,
              stop_loss_pct: s?.stop_loss_pct ?? 2,
              take_profit_pct: s?.take_profit_pct ?? 4,
              leverage: 1,
              risk_level: s?.risk_level ?? 'Balanced',
              theme: s?.theme ?? 'Dark',
              trade_alerts: s?.trade_alerts ?? true,
              pnl_alerts: s?.pnl_alerts ?? true,
              risk_alerts: s?.risk_alerts ?? true,
            });
          }
        }
        if (results[1].status === 'fulfilled' && results[1].value.ok && results[1].value.data) setPositions(results[1].value.data);
        if (results[2].status === 'fulfilled' && results[2].value.ok && results[2].value.data) setTrades(results[2].value.data);
        if (results[3].status === 'fulfilled' && results[3].value.ok && results[3].value.data) setPerformance(results[3].value.data);
        if (results[4].status === 'fulfilled' && results[4].value.ok && results[4].value.data) setSnapshots(results[4].value.data);
        if (results[5].status === 'fulfilled' && results[5].value.ok && results[5].value.data) setMarket(results[5].value.data);
        if (results[6].status === 'fulfilled' && results[6].value.ok && results[6].value.data) setSettings(results[6].value.data);
      }
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Ctx.Provider
      value={{ conn, account, positions, trades, performance, snapshots, market, settings, errors, refresh }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
