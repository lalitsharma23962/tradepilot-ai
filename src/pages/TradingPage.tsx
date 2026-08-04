import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Brain, Zap, Shield, Target, TrendingUp, TrendingDown } from 'lucide-react';
import { useApp } from '@/lib/store';
import * as api from '@/lib/api';
import { getPriceHistory } from '@/lib/engineV2';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, LoadingState, Table } from '@/components/ui';
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '@/lib/format';
import type { AiRecommendation } from '@/lib/types';

export function TradingPage() {
  const { conn, account, positions, trades, market } = useApp();
  const [rec, setRec] = useState<AiRecommendation | null>(null);
  const [loadingRec, setLoadingRec] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTC/USDT');

  useEffect(() => {
    let mounted = true;
    const fetchRec = async () => {
      const res = await api.aiRecommendation(selectedSymbol);
      if (mounted && res.ok && res.data) setRec(res.data);
      if (mounted) setLoadingRec(false);
    };
    fetchRec();
    const id = setInterval(fetchRec, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, [selectedSymbol]);

  if (conn === 'loading' && !account) {
    return <div className="p-6"><LoadingState message="Loading trading desk…" /></div>;
  }

  const running = account?.bot_status === 'RUNNING';

  return (
    <div className="space-y-6 p-6">
      {/* Paper trading status */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">Paper Trading Engine</h3>
                <Badge tone="accent">PAPER TRADING</Badge>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Simulated trading only. No exchange connection. No real money. No API credentials required.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge tone={running ? 'positive' : 'neutral'}>
                <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                {running ? 'Engine Running' : 'Engine Stopped'}
              </Badge>
              <Badge tone="neutral">Leverage 1x</Badge>
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Simulated price chart */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Simulated Price Chart"
            subtitle={`${selectedSymbol} — Mock data`}
            action={<Badge tone="warning">MOCK</Badge>}
          />
          <CardBody>
            <div className="mb-4 flex flex-wrap gap-2">
              {market.map((m) => (
                <button
                  key={m.symbol}
                  onClick={() => setSelectedSymbol(m.symbol)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    selectedSymbol === m.symbol
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  {m.symbol}
                </button>
              ))}
            </div>
            <SimPriceChart symbol={selectedSymbol} />
          </CardBody>
        </Card>

        {/* AI Recommendation */}
        <Card>
          <CardHeader title="AI Recommendation" subtitle="Observation only — never auto-executes" action={<Badge tone="accent">SIMULATED</Badge>} />
          <CardBody>
            {loadingRec || !rec ? (
              <LoadingState message="Analyzing simulated market…" />
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${rec.action === 'LONG' ? 'bg-emerald-950 text-emerald-400' : rec.action === 'SHORT' ? 'bg-red-950 text-red-400' : 'bg-slate-800 text-slate-400'}`}>
                    {rec.action === 'LONG' ? <TrendingUp className="h-5 w-5" /> : rec.action === 'SHORT' ? <TrendingDown className="h-5 w-5" /> : <Brain className="h-5 w-5" />}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{rec.symbol}</p>
                    <p className="text-xs text-slate-500">Signal: <span className={rec.action === 'LONG' ? 'text-emerald-400' : rec.action === 'SHORT' ? 'text-red-400' : 'text-slate-400'}>{rec.action}</span></p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <InfoRow icon={<Zap className="h-3.5 w-3.5" />} label="Confidence" value={`${fmtNum(rec.confidence, 0)}%`} />
                  <InfoRow icon={<Shield className="h-3.5 w-3.5" />} label="Risk Score" value={`${rec.risk_score}/100`} />
                  <InfoRow label="Suggested Entry" value={fmtMoney(rec.entry, rec.entry >= 100 ? 2 : 4)} />
                  <InfoRow label="Stop Loss" value={fmtMoney(rec.stop_loss, rec.stop_loss >= 100 ? 2 : 4)} tone="negative" />
                  <InfoRow label="Take Profit" value={fmtMoney(rec.take_profit, rec.take_profit >= 100 ? 2 : 4)} tone="positive" />
                </div>

                <div className="rounded-lg bg-slate-800/50 p-3">
                  <p className="text-xs leading-relaxed text-slate-400">{rec.explanation}</p>
                </div>

                <Button disabled className="w-full" variant="secondary">
                  Coming Soon — Paper Engine Controlled
                </Button>
                <p className="text-center text-[10px] text-slate-600">
                  Manual execution is intentionally disabled. The paper engine controls all trades.
                </p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Open positions + recent trades */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Open Positions" action={<Badge tone="accent">PAPER</Badge>} />
          <CardBody className="p-0">
            {positions.length === 0 ? (
              <EmptyState title="No open positions" message="Start the bot to open simulated positions." />
            ) : (
              <Table
                headers={['Symbol', 'Side', 'Qty', 'Entry', 'Current', 'PnL']}
                rows={positions.map((p) => [
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
          <CardHeader title="Recent Trades" action={<Badge tone="accent">PAPER</Badge>} />
          <CardBody className="p-0">
            {trades.length === 0 ? (
              <EmptyState title="No trades yet" message="Closed trades will appear here." />
            ) : (
              <Table
                headers={['Symbol', 'Side', 'PnL', 'Return']}
                rows={trades.slice(0, 8).map((t) => [
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
    </div>
  );
}

function InfoRow({ icon, label, value, tone }: { icon?: React.ReactNode; label: string; value: string; tone?: 'positive' | 'negative' }) {
  const toneClass = tone === 'positive' ? 'text-emerald-400' : tone === 'negative' ? 'text-red-400' : 'text-slate-200';
  return (
    <div className="flex items-center justify-between rounded-lg bg-slate-800/40 px-3 py-2">
      <span className="flex items-center gap-1.5 text-slate-500">{icon}{label}</span>
      <span className={`font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

function SimPriceChart({ symbol }: { symbol: string }) {
  const [data, setData] = useState<{ ts: number; price: number }[]>([]);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      const hist = getPriceHistory(symbol, 180);
      if (mounted) setData(hist);
    };
    load();
    const id = setInterval(load, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [symbol]);

  if (data.length < 2) {
    return <EmptyState title="Waiting for price data" message="Simulated prices generate as the engine ticks." />;
  }

  const chartData = data.map((d) => ({ ts: new Date(d.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), price: d.price }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="ts" tick={{ fontSize: 10, fill: '#64748b' }} />
        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} domain={['auto', 'auto']} />
        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94a3b8' }} />
        <Area type="monotone" dataKey="price" stroke="#6366f1" strokeWidth={2} fill="url(#priceGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
