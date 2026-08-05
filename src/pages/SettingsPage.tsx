import { useState } from 'react';
import { Lock, AlertTriangle, RotateCcw, ShieldCheck } from 'lucide-react';
import { useApp } from '@/lib/store';
import * as api from '@/lib/api';
import { Badge, Button, Card, CardBody, CardHeader, LoadingState } from '@/components/ui';
import type { RiskLevel, ThemeMode } from '@/lib/types';

export function SettingsPage() {
  const { settings, refresh } = useApp();
  const [saving, setSaving] = useState(false), [resetting, setResetting] = useState(false), [resetMsg, setResetMsg] = useState<string | null>(null);
  if (!settings) return <div className="p-6"><LoadingState message="Loading settings…" /></div>;
  const update = async (patch: Partial<typeof settings>) => { setSaving(true); await api.updateSettingsApi(patch); refresh(); setSaving(false); };
  const handleReset = async () => { setResetting(true); setResetMsg(null); const res=await api.resetApi(); setResetMsg(res.ok ? (res.data?.message ?? 'Account reset.') : (res.error ?? 'Reset failed.')); refresh(); setResetting(false); };

  return <div className="mx-auto max-w-3xl space-y-6 p-6">
    <Card><CardHeader title="Trading Mode" subtitle="Paper trading is active. Live execution remains disabled." /><CardBody className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3"><div><p className="text-sm font-semibold text-emerald-400">PAPER TRADING</p><p className="text-xs text-slate-500">Cost-aware simulated execution</p></div><Badge tone="positive">Active</Badge></div>
      <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-3 opacity-60"><div><p className="text-sm font-semibold text-slate-400">LIVE TRADING</p><p className="text-xs text-slate-600">Blocked until validation + explicit production gate</p></div><Badge tone="neutral"><Lock className="mr-1 h-3 w-3" />Disabled</Badge></div>
    </CardBody></Card>

    <Card><CardHeader title="Capital & Execution Guardrails" subtitle="Hard server-side limits. Capital has no artificial ceiling; risk exposure does." /><CardBody className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Strategies', `${settings.max_strategies} / 10`], ['Max Position', `${settings.max_allocation_pct}%`], ['Max Leverage', `${settings.leverage}x`], ['Capital', 'Unlimited']].map(([label,value]) => <div key={label} className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">{label}</p><p className="mt-1 text-sm font-semibold text-slate-200">{value}</p></div>)}
      </div>
      <div className="rounded-lg border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />A loss-limit breach closes open paper positions and blocks new entries for 24 hours. The lockout is persisted and survives refresh.</div>
      <div className="flex items-center gap-4"><label className="w-36 text-xs text-slate-400">Leverage ceiling</label><input type="range" min={1} max={10} step={1} value={settings.leverage} onChange={e=>update({leverage:Number(e.target.value)})} disabled={saving} className="flex-1 accent-sky-500"/><span className="w-12 text-right text-sm font-semibold text-sky-400">{settings.leverage}x</span></div>
      <div className="flex items-center gap-4"><label className="w-36 text-xs text-slate-400">Daily loss limit</label><input type="range" min={0.25} max={10} step={0.25} value={settings.loss_limit_pct} onChange={e=>update({loss_limit_pct:Number(e.target.value)})} disabled={saving} className="flex-1 accent-red-500"/><span className="w-12 text-right text-sm font-semibold text-red-400">{settings.loss_limit_pct}%</span></div>
      <p className="text-xs text-slate-500">Position size is hard-capped at 20% of equity. Leverage cannot exceed 10x. The validation suite cannot activate more than 10 strategies.</p>
    </CardBody></Card>

    <Card><CardHeader title="Exchange API Keys / Secure Wallet" subtitle="No secret is stored in the browser or PGlite." /><CardBody className="space-y-3">
      <div className="rounded-lg border border-emerald-900 bg-emerald-950/30 px-4 py-3 text-xs text-emerald-300"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />Server-side vault design: AES-256-GCM encryption, authenticated vault endpoint, Supabase storage with client access revoked, and no API endpoint for withdrawals.</div>
      <p className="text-xs text-slate-500">Before any exchange key is stored, create the exchange key with <strong>withdrawals disabled</strong>. The vault rejects requests that attempt to enable withdrawal permissions. The encryption master key and vault admin token must remain Vercel/server environment secrets.</p>
      <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-slate-800/40 px-3 py-2"><p className="text-[11px] text-slate-500">Encryption</p><p className="text-sm text-slate-200">AES-256-GCM</p></div><div className="rounded-lg bg-slate-800/40 px-3 py-2"><p className="text-[11px] text-slate-500">Withdrawals</p><p className="text-sm text-emerald-400">PROHIBITED</p></div></div>
    </CardBody></Card>

    <Card><CardHeader title="Risk Level" subtitle="Controls trade sizing and signal selectivity." /><CardBody><div className="grid grid-cols-3 gap-2">{(['Conservative','Balanced','Aggressive'] as RiskLevel[]).map(r=><button key={r} onClick={()=>update({risk_level:r})} disabled={saving} className={`rounded-lg px-3 py-2.5 text-sm font-medium ${settings.risk_level===r?'bg-sky-600 text-white':'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>{r}</button>)}</div></CardBody></Card>

    <Card><CardHeader title="Minimum Confidence / Score Threshold" subtitle="60–95. Higher = fewer, more selective entries." /><CardBody className="space-y-3"><div className="flex items-center gap-4"><input type="range" min={60} max={95} step={1} value={settings.confidence_threshold_pct} onChange={e=>update({confidence_threshold_pct:Number(e.target.value)})} disabled={saving} className="flex-1 accent-sky-500"/><span className="w-16 text-right text-sm font-semibold text-sky-400">{settings.confidence_threshold_pct}%</span></div><p className="text-xs text-slate-500">Applied to the paper engine on the next tick. It does not override hard risk limits.</p></CardBody></Card>

    <Card><CardHeader title="Maximum Position Size" subtitle="1%–20% of equity. Hard limit: 20%." /><CardBody className="space-y-3"><div className="flex items-center gap-4"><input type="range" min={1} max={20} step={1} value={settings.max_allocation_pct} onChange={e=>update({max_allocation_pct:Number(e.target.value)})} disabled={saving} className="flex-1 accent-sky-500"/><span className="w-14 text-right text-sm font-semibold text-sky-400">{settings.max_allocation_pct}%</span></div><p className="text-xs text-slate-500">Server-side hard cap remains 20% even if the UI is modified.</p></CardBody></Card>

    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><Card><CardHeader title="Stop Loss" subtitle="Default 2%" /><CardBody><div className="flex items-center gap-4"><input type="range" min={0.1} max={20} step={0.1} value={settings.stop_loss_pct} onChange={e=>update({stop_loss_pct:Number(e.target.value)})} disabled={saving} className="flex-1 accent-red-500"/><span className="w-14 text-right text-sm font-semibold text-red-400">{settings.stop_loss_pct}%</span></div></CardBody></Card><Card><CardHeader title="Take Profit" subtitle="Default 4%" /><CardBody><div className="flex items-center gap-4"><input type="range" min={0.25} max={50} step={0.25} value={settings.take_profit_pct} onChange={e=>update({take_profit_pct:Number(e.target.value)})} disabled={saving} className="flex-1 accent-emerald-500"/><span className="w-14 text-right text-sm font-semibold text-emerald-400">{settings.take_profit_pct}%</span></div></CardBody></Card></div>

    <Card><CardHeader title="Backtest Cost Model" subtitle="Used to prevent gross-PnL illusions." /><CardBody><div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Fee assumption</p><p className="text-sm font-semibold text-slate-200">{settings.fee_bps} bps / side</p></div><div className="rounded-lg bg-slate-800/40 p-3"><p className="text-[11px] text-slate-500">Slippage assumption</p><p className="text-sm font-semibold text-slate-200">{settings.slippage_bps} bps / side</p></div></div><p className="mt-3 text-xs text-slate-500">The historical validation pipeline applies both costs before reporting PnL.</p></CardBody></Card>

    <Card><CardHeader title="Theme" /><CardBody><div className="grid grid-cols-3 gap-2">{(['Dark','Light','System'] as ThemeMode[]).map(t=><button key={t} onClick={()=>update({theme:t})} disabled={saving} className={`rounded-lg px-3 py-2.5 text-sm font-medium ${settings.theme===t?'bg-sky-600 text-white':'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>{t}</button>)}</div></CardBody></Card>

    <Card><CardHeader title="Notifications" /><CardBody className="space-y-3">{[{key:'trade_alerts' as const,label:'Trade Alerts'},{key:'pnl_alerts' as const,label:'PnL Updates'},{key:'risk_alerts' as const,label:'Risk Alerts'}].map(item=><label key={item.key} className="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-3"><span className="text-sm text-slate-300">{item.label}</span><button onClick={()=>update({[item.key]:!settings[item.key]} as Partial<typeof settings>)} disabled={saving} className={`relative h-6 w-11 rounded-full ${settings[item.key]?'bg-sky-600':'bg-slate-700'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white ${settings[item.key]?'translate-x-5':'translate-x-0.5'}`} /></button></label>)}</CardBody></Card>

    <Card><CardHeader title="Development Reset" subtitle="Reset account to $10,000 and clear all history" /><CardBody><div className="flex items-center gap-3"><Button variant="danger" onClick={handleReset} disabled={resetting}><RotateCcw className="h-4 w-4"/>Reset Account</Button>{resetMsg&&<span className="text-xs text-slate-400">{resetMsg}</span>}</div><div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-950/40 px-3 py-2 text-xs text-amber-400"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0"/><span>This clears positions, trades and snapshots and restores $10,000. It does not create or store exchange credentials.</span></div></CardBody></Card>
  </div>;
}
