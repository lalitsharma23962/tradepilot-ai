import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '@/lib/store';
import * as api from '@/lib/api';
import { STRATEGIES, type ValidationReport } from '@/lib/backtest';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, LoadingState, StatCard } from '@/components/ui';
import { fmtMoney, fmtNum, fmtTime } from '@/lib/format';

export function AnalyticsPage() {
  const { conn, performance, snapshots, account } = useApp();
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | undefined>(undefined);
  const equityCurve = useMemo(() => snapshots.map((s,i)=>({idx:i,equity:s.equity,ts:fmtTime(s.ts)})), [snapshots]);
  const runValidation = async () => {
    setRunning(true); setError(null);
    try {
      const riskPerTradePct=account?.risk_level==='Conservative'?0.15:account?.risk_level==='Aggressive'?0.35:0.25;
      const leverage=Math.max(1,Math.min(10,Number(account?.leverage??1)));
      const maxPositionPct=Math.max(1,Math.min(20,Number(account?.max_allocation_pct??20)));
      const res=await api.validationApi('BTCUSDT','5m',{initialCapital:10000,feeBps:Number(account?.fee_bps??10),slippageBps:Number(account?.slippage_bps??2),maxPositionPct,leverage,riskPerTradePct},selectedStrategyId);
      if(res.ok) {
        setReport(res.data ?? null);
        if(res.data?.walkForward.selectedStrategy) {
          const matched=STRATEGIES.find(s=>s.name===res.data?.walkForward.selectedStrategy);
          if(matched) setSelectedStrategyId(matched.id);
        }
      } else setError(res.error ?? 'Validation failed.');
    } finally { setRunning(false); }
  };
  if (conn==='loading'&&!performance) return <div className="p-6"><LoadingState message="Loading analytics…"/></div>;
  const displayedLeverage=Math.max(1,Math.min(10,Number(account?.leverage??1)));
  return <div className="space-y-6 p-6">
    {performance ? <><div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6"><StatCard label="Equity" value={fmtMoney(performance.equity)} tone="accent"/><StatCard label="Total PnL" value={fmtMoney(performance.total_pnl)} tone={performance.total_pnl>=0?'positive':'negative'}/><StatCard label="Win Rate" value={`${fmtNum(performance.win_rate,1)}%`}/><StatCard label="Wins" value={String(performance.wins)} tone="positive"/><StatCard label="Losses" value={String(performance.losses)} tone="negative"/><StatCard label="Trade Count" value={String(performance.trade_count)}/></div>
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><StatCard label="Best Trade" value={fmtMoney(performance.best_trade)} tone="positive"/><StatCard label="Worst Trade" value={fmtMoney(performance.worst_trade)} tone="negative"/><StatCard label="Avg Trade" value={fmtMoney(performance.avg_trade)} tone={performance.avg_trade>=0?'positive':'negative'}/><StatCard label="Max Drawdown" value={fmtMoney(performance.max_drawdown)} tone="negative"/></div>
    <Card><CardHeader title="Paper Equity Curve" subtitle="Cost-aware paper-trading equity" action={<Badge tone="accent">PAPER</Badge>}/><CardBody>{equityCurve.length<2?<EmptyState title="Not enough history yet" message="Start the paper engine to build snapshots."/>:<ResponsiveContainer width="100%" height={320}><AreaChart data={equityCurve}><defs><linearGradient id="anGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/><stop offset="95%" stopColor="#10b981" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#1e293b"/><XAxis dataKey="ts" tick={{fontSize:10,fill:'#64748b'}}/><YAxis tick={{fontSize:10,fill:'#64748b'}} domain={['auto','auto']}/><Tooltip/><Area type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} fill="url(#anGrad)"/></AreaChart></ResponsiveContainer>}</CardBody></Card></> : <EmptyState title="No paper results yet" message="Run the historical validation first; paper results will appear after the engine trades."/>}

    <Card><CardHeader title="Historical Validation Lab" subtitle="20,000 real Binance candles → fees + slippage → train/validation/test walk-forward → Monte Carlo" action={<Button onClick={runValidation} disabled={running}>{running?'Running…':'Run validation'}</Button>}/><CardBody className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5"><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Data</p><p className="text-sm font-semibold">BTCUSDT · 5m</p></div><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Selected strategy</p><select value={selectedStrategyId ?? ''} onChange={e=>setSelectedStrategyId(e.target.value||undefined)} disabled={running} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm font-semibold text-slate-200"><option value="">Walk-forward auto-select</option>{STRATEGIES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></div><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Fee</p><p className="text-sm font-semibold">{Number(account?.fee_bps??10)} bps/side</p></div><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Slippage</p><p className="text-sm font-semibold">{Number(account?.slippage_bps??2)} bps/side</p></div><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Leverage</p><p className="text-sm font-semibold">≤{displayedLeverage}x</p></div></div>
      {selectedStrategyId&&<p className="text-xs text-slate-400">Manual selection is still subject to the full pre-OOS validation and the unchanged paper-trading gate. The final 50% OOS window is never used to choose the strategy.</p>}
      {error&&<div className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</div>}
      {report&&<>
        <div className={`rounded-lg border px-4 py-3 ${report.gate.status==='VALIDATED'?'border-emerald-800 bg-emerald-950/30':'border-red-800 bg-red-950/30'}`}>
          <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide">Paper-trading gate</p><p className={`mt-1 text-lg font-bold ${report.gate.status==='VALIDATED'?'text-emerald-300':'text-red-300'}`}>{report.gate.status}</p></div><Badge tone={report.gate.status==='VALIDATED'?'positive':'negative'}>{report.gate.status==='VALIDATED'?'READY FOR PAPER':'DO NOT TRADE'}</Badge></div>
          {report.gate.reasons.length>0&&<ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-red-200">{report.gate.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Historical candles</p><p className="mt-1 text-sm font-semibold">{report.candles.toLocaleString()}</p></div><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">History span</p><p className="mt-1 text-sm font-semibold">{report.dataQuality.durationDays.toFixed(1)} days</p></div><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Data gaps</p><p className="mt-1 text-sm font-semibold">{report.dataQuality.gaps}</p></div><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Monte Carlo runs</p><p className="mt-1 text-sm font-semibold">{report.monteCarlo.simulations.toLocaleString()}</p></div></div>
        <div><p className="mb-2 text-xs text-slate-500">Pre-OOS strategy candidates — click a row to select it for the next validation run. These metrics do not include the untouched OOS window.</p><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="px-2 py-2">Strategy</th><th>Trades</th><th>Win %</th><th>PF</th><th>Return</th><th>Max DD</th><th>Score</th></tr></thead><tbody>{report.strategies.map(s=><tr key={s.id} onClick={()=>setSelectedStrategyId(s.id)} className={`cursor-pointer border-t border-slate-800 ${selectedStrategyId===s.id?'bg-sky-950/40':'hover:bg-slate-800/40'}`}><td className="px-2 py-2 font-medium text-slate-200">{s.name}{selectedStrategyId===s.id&&<span className="ml-2 text-[10px] text-sky-300">SELECTED</span>}</td><td>{s.trades}</td><td>{s.winRate.toFixed(1)}%</td><td>{s.profitFactor.toFixed(2)}</td><td className={s.returnPct>=0?'text-emerald-400':'text-red-400'}>{s.returnPct.toFixed(2)}%</td><td className="text-red-300">{s.maxDrawdownPct.toFixed(2)}%</td><td>{s.score.toFixed(2)}</td></tr>)}</tbody></table></div></div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4"><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Walk-forward selected</p><p className="mt-1 text-sm font-semibold">{report.walkForward.selectedStrategy}</p><p className="mt-1 text-xs text-slate-500">Train {report.walkForward.trainBars} · Validation {report.walkForward.validationBars} · Test {report.walkForward.testBars}</p></div><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Validation result</p><p className="mt-1 text-sm font-semibold">{report.walkForward.validation ? `${report.walkForward.validation.returnPct.toFixed(2)}% return · PF ${report.walkForward.validation.profitFactor.toFixed(2)} · ${report.walkForward.validation.trades} trades` : 'Insufficient validation data'}</p></div><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Out-of-sample test</p><p className="mt-1 text-sm font-semibold">{report.walkForward.test ? `${report.walkForward.test.returnPct.toFixed(2)}% return · PF ${report.walkForward.test.profitFactor.toFixed(2)} · ${report.walkForward.test.trades} trades` : 'Insufficient test data'}</p></div><div className="rounded-lg border border-slate-800 p-3"><p className="text-[11px] text-slate-500">Monte Carlo</p><p className="mt-1 text-sm font-semibold">{report.monteCarlo.probabilityOfLoss.toFixed(1)}% loss probability</p><p className="mt-1 text-xs text-slate-500">Median {report.monteCarlo.medianReturnPct.toFixed(2)}% · P05 {report.monteCarlo.p05ReturnPct.toFixed(2)}% · DD P95 {report.monteCarlo.p95MaxDrawdownPct.toFixed(2)}%</p></div></div>
      </>}
      {!report&&!running&&<p className="text-xs text-slate-500">This gate must pass before another $10,000 paper run. A raw profitable backtest is never sufficient on its own.</p>}
    </CardBody></Card>
  </div>;
}
