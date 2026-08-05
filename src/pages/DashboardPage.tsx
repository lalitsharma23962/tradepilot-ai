import { useMemo } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '@/lib/store';
import { Badge, Card, CardBody, CardHeader, EmptyState, LoadingState, StatCard, Table } from '@/components/ui';
import { fmtMoney, fmtNum, fmtPct, fmtTime, pnlClass } from '@/lib/format';

export function DashboardPage() {
  const { conn, account, positions, trades, performance, snapshots, market } = useApp();

  if (conn === 'loading' && !account) {
    return (
      <div className="p-6">
        <LoadingState message="Initializing paper trading engine…" />
      </div>
    );
  }

  const todayPnl = useMemo(() => {
    if (!snapshots.length || !account) return 0;
    const first = snapshots[0];
    return account.equity - first.equity;
  }, [snapshots, account]);

  const equityData = useMemo(
    () =>
      snapshots.map((s, i) => ({
        idx: i,
        equity: s.equity,
        cash: s.cash,
        ts: fmtTime(s.ts),
      })),
    [snapshots]
  );

  const dailyPnlData = useMemo(() => {
    // Group snapshots into buckets to show per-period PnL bars.
    if (snapshots.length < 2) return [];
    const buckets: { label: string; pnl: number }[] = [];
    const chunk = Math.max(1, Math.floor(snapshots.length / 12));
    for (let i = 0; i < snapshots.length; i += chunk) {
      const slice = snapshots.slice(i, i + chunk);
      if (slice.length < 2) continue;
      const start = slice[0].equity;
      const end = slice[slice.length - 1].equity;
      buckets.push({ label: fmtTime(slice[0].ts), pnl: end - start });
    }
    return buckets;
  }, [snapshots]);

  return (
    <div className="space-y-6 p-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Portfolio Value" value={fmtMoney(account?.equity)} tone="accent" />
        <StatCard
          label="Today's PnL"
          value={fmtMoney(todayPnl)}
          sub={fmtPct(account ? (todayPnl / 10000) * 100 : 0)}
          tone={todayPnl >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Total PnL"
          value={fmtMoney(account?.total_pnl)}
          tone={(account?.total_pnl ?? 0) >= 0 ? 'positive' : 'negative'}
        />
        <StatCard label="Cash Balance" value={fmtMoney(account?.cash)} />
        <StatCard label="Open Positions" value={String(positions.length)} />
        <StatCard label="Closed Trades" value={String(trades.length)} />
        <StatCard
          label="Win Rate"
          value={performance ? `${fmtNum(performance.win_rate, 1)}%` : '0%'}
          sub={performance ? `${performance.wins}W / ${performance.losses}L` : ''}
        />
        <StatCard
          label="Bot Status"
          value={account?.bot_status === 'RUNNING' ? 'RUNNING' : 'STOPPED'}
          tone={account?.bot_status === 'RUNNING' ? 'positive' : 'neutral'}
        />
      </div>

      {/* Equity chart */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Equity Curve" subtitle="Paper trading account equity over time" action={<Badge tone="accent">PAPER</Badge>} />
          <CardBody>
            {equityData.length < 2 ? (
              <EmptyState title="No equity history yet" message="Start the bot to begin recording equity snapshots." />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={equityData}>
                  <defs>
                    <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="ts" tick={{ fontSize: 10, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#64748b' }} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Area type="monotone" dataKey="equity" stroke="#0ea5e9" strokeWidth={2} fill="url(#eqGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Daily PnL" subtitle="PnL per period (Paper)" action={<Badge tone="accent">PAPER</Badge>} />
          <CardBody>
            {dailyPnlData.length < 2 ? (
              <EmptyState title="No PnL data yet" message="PnL bars appear after the bot runs for a bit." />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={dailyPnlData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {dailyPnlData.map((d, i) => (
                      <Cell key={i} fill={d.pnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Open positions + recent trades */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Open Positions" subtitle="Live simulated positions" action={<Badge tone="accent">PAPER</Badge>} />
          <CardBody className="p-0">
            {positions.length === 0 ? (
              <EmptyState title="No open positions" message="Start the bot to open simulated positions." />
            ) : (
              <Table
                headers={['Symbol', 'Side', 'Qty', 'Entry', 'Current', 'PnL']}
                rows={positions.slice(0, 6).map((p) => [
                  p.symbol,
                  <Badge tone={p.side === 'LONG' ? 'positive' : 'negative'}>{p.side}</Badge>,
                  fmtNum(p.quantity, 4),
                  fmtMoney(p.entry_price, p.entry_price >= 100 ? 2 : 4),
                  fmtMoney(p.current_price, p.current_price >= 100 ? 2 : 4),
                  <span className={pnlClass(p.unrealized_pnl)}>{fmtMoney(p.unrealized_pnl)}</span>,
                ])}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent Trades" subtitle="Closed paper trades" action={<Badge tone="accent">PAPER</Badge>} />
          <CardBody className="p-0">
            {trades.length === 0 ? (
              <EmptyState title="No trades yet" message="Closed trades will appear here." />
            ) : (
              <Table
                headers={['Time', 'Symbol', 'Side', 'PnL', 'Return']}
                rows={trades.slice(0, 6).map((t) => [
                  fmtTime(t.closed_at),
                  t.symbol,
                  <Badge tone={t.side === 'LONG' ? 'positive' : 'negative'}>{t.side}</Badge>,
                  <span className={pnlClass(t.pnl)}>{fmtMoney(t.pnl)}</span>,
                  <span className={pnlClass(t.return_pct)}>{fmtPct(t.return_pct)}</span>,
                ])}
              />
            )}
          </CardBody>
        </Card>
      </div>

      {/* Market overview */}
      <Card>
        <CardHeader title="Market Overview" subtitle="Simulated prices (Mock)" action={<Badge tone="warning">MOCK</Badge>} />
        <CardBody className="p-0">
          {market.length === 0 ? (
            <EmptyState title="No market data" message="Simulated prices initialize on first load." />
          ) : (
            <Table
              headers={['Symbol', 'Price', 'Change']}
              rows={market.map((m) => [
                m.symbol,
                fmtMoney(m.price, m.price >= 100 ? 2 : 4),
                <span className={pnlClass(m.change_pct)}>{fmtPct(m.change_pct)}</span>,
              ])}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
