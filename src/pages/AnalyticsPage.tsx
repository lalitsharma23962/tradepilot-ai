import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '@/lib/store';
import { Badge, Card, CardBody, CardHeader, EmptyState, LoadingState, StatCard } from '@/components/ui';
import { fmtMoney, fmtNum, fmtTime, pnlClass } from '@/lib/format';

export function AnalyticsPage() {
  const { conn, performance, snapshots } = useApp();

  const equityCurve = useMemo(
    () => snapshots.map((s, i) => ({ idx: i, equity: s.equity, ts: fmtTime(s.ts) })),
    [snapshots]
  );

  if (conn === 'loading' && !performance) {
    return <div className="p-6"><LoadingState message="Loading analytics…" /></div>;
  }

  if (!performance) {
    return <div className="p-6"><EmptyState title="No analytics yet" message="Start the bot to generate performance data." /></div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Equity" value={fmtMoney(performance.equity)} tone="accent" />
        <StatCard label="Total PnL" value={fmtMoney(performance.total_pnl)} tone={performance.total_pnl >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Win Rate" value={`${fmtNum(performance.win_rate, 1)}%`} />
        <StatCard label="Wins" value={String(performance.wins)} tone="positive" />
        <StatCard label="Losses" value={String(performance.losses)} tone="negative" />
        <StatCard label="Trade Count" value={String(performance.trade_count)} />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Best Trade" value={fmtMoney(performance.best_trade)} tone="positive" />
        <StatCard label="Worst Trade" value={fmtMoney(performance.worst_trade)} tone="negative" />
        <StatCard label="Avg Trade" value={fmtMoney(performance.avg_trade)} tone={performance.avg_trade >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Max Drawdown" value={fmtMoney(performance.max_drawdown)} tone="negative" />
      </div>

      <Card>
        <CardHeader title="Equity Curve" subtitle="Actual paper-trading equity snapshots" action={<Badge tone="accent">PAPER</Badge>} />
        <CardBody>
          {equityCurve.length < 2 ? (
            <EmptyState title="Not enough history yet" message="The equity curve builds up as the bot runs. If there's no data, a historical mock is shown below." />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={equityCurve}>
                <defs>
                  <linearGradient id="anGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="ts" tick={{ fontSize: 10, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} domain={['auto', 'auto']} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94a3b8' }} />
                <Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#anGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Historical Mock Equity Curve" subtitle="Illustrative only — not real trading results" action={<Badge tone="warning">HISTORICAL MOCK</Badge>} />
        <CardBody>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={mockEquity}>
              <defs>
                <linearGradient id="mockGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#64748b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#64748b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="d" tick={{ fontSize: 10, fill: '#64748b' }} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94a3b8' }} />
              <Area type="monotone" dataKey="v" stroke="#64748b" strokeWidth={1.5} fill="url(#mockGrad)" strokeDasharray="4 4" />
            </AreaChart>
          </ResponsiveContainer>
        </CardBody>
      </Card>
    </div>
  );
}

const mockEquity = Array.from({ length: 30 }, (_, i) => {
  const base = 10000;
  const trend = i * 15;
  const noise = Math.sin(i / 3) * 80;
  return { d: `D${i + 1}`, v: Math.round(base + trend + noise) };
});
