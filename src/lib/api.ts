import { startEngine, stopEngine, restartEngine, isEngineRunning, getMarketTicks, getAiRecommendation, closePosition, closeAllPositions, resetAccount, getTickCount } from './engineV2';
import { getAccount, getPositions, getTrades, getPerformance, getSnapshots, getSettings, updateSettings } from './repository';
import { getValidationGate, setValidationGate } from './db';
import { runValidation, type BacktestConfig, type ValidationReport } from './backtestV2';

export interface ApiResult<T>{ok:boolean;data?:T;error?:string;}
async function wrap<T>(fn:()=>T|Promise<T>):Promise<ApiResult<T>>{try{return{ok:true,data:await fn()};}catch(err){const message=err instanceof Error?err.message:'Unknown error';console.error('[api] error:',message);return{ok:false,error:message};}}
function normalizeValidationReport(report:ValidationReport):ValidationReport{
 const rename=(value:string)=>value.replace(/Production Breakout v5/g,'Production Breakout v9').replace(/Production Breakout v8/g,'Production Breakout v9');
 return {...report,strategies:report.strategies.map(s=>({...s,name:rename(s.name)})),walkForward:{...report.walkForward,selectedStrategy:rename(report.walkForward.selectedStrategy)},gate:{...report.gate,reasons:report.gate.reasons.map(rename)}};
}
export async function health():Promise<ApiResult<{status:string;engine:boolean;ticks:number;db:string}>>{return wrap(()=>({status:'ok',engine:isEngineRunning(),ticks:getTickCount(),db:'pglite'}));}
export async function botStatus():Promise<ApiResult<{status:string;running:boolean;started_at:string|null;uptime_seconds:number;risk_pause_until:string|null}>>{return wrap(async()=>{const a=await getAccount(),uptime=a.started_at?Math.max(0,Math.round((Date.now()-new Date(a.started_at).getTime())/1000)):0;return{status:a.bot_status,running:a.bot_status==='RUNNING',started_at:a.started_at,uptime_seconds:uptime,risk_pause_until:a.risk_pause_until};});}
export async function validationGateApi():Promise<ApiResult<Awaited<ReturnType<typeof getValidationGate>>>>{return wrap(()=>getValidationGate());}
export async function botStart():Promise<ApiResult<{message:string}>>{return wrap(async()=>{const gate=await getValidationGate();if(gate.status!=='VALIDATED')throw new Error('Paper trading is blocked until the historical validation gate passes. Run validation again after any account reset or validation failure.');const r=await startEngine();if(!r.ok)throw new Error(r.message);return{message:r.message};});}
export async function botStop():Promise<ApiResult<{message:string}>>{return wrap(async()=>{const r=await stopEngine();if(!r.ok)throw new Error(r.message);return{message:r.message};});}
export async function botRestart():Promise<ApiResult<{message:string}>>{return wrap(async()=>{const gate=await getValidationGate();if(gate.status!=='VALIDATED')throw new Error('Paper trading restart is blocked until the historical validation gate passes.');const r=await restartEngine();if(!r.ok)throw new Error(r.message);return{message:r.message};});}
export async function portfolio():Promise<ApiResult<{cash:number;equity:number;total_pnl:number;realized_pnl:number;unrealized_pnl:number;open_value:number;open_positions:number;closed_trades:number;bot_status:string;started_at:string|null;risk_pause_until:string|null}>>{return wrap(async()=>{const a=await getAccount(),ps=await getPositions(),ts=await getTrades(1000),openValue=ps.reduce((x,p)=>x+p.notional,0),unrealized=ps.reduce((x,p)=>x+p.unrealized_pnl,0);return{cash:a.cash,equity:a.equity,total_pnl:a.total_pnl,realized_pnl:a.realized_pnl,unrealized_pnl:unrealized,open_value:openValue,open_positions:ps.length,closed_trades:ts.length,bot_status:a.bot_status,started_at:a.started_at,risk_pause_until:a.risk_pause_until};});}
export async function positions():Promise<ApiResult<import('./types').Position[]>>{return wrap(()=>getPositions());}
export async function trades():Promise<ApiResult<import('./types').Trade[]>>{return wrap(()=>getTrades(500));}
export async function performance():Promise<ApiResult<import('./types').Performance>>{return wrap(()=>getPerformance());}
export async function snapshots():Promise<ApiResult<import('./types').Snapshot[]>>{return wrap(()=>getSnapshots(500));}
export async function market():Promise<ApiResult<import('./types').MarketTick[]>>{return wrap(()=>getMarketTicks());}
export async function getSettingsApi():Promise<ApiResult<import('./types').Settings>>{return wrap(()=>getSettings());}
export async function updateSettingsApi(settings:Partial<import('./types').Settings>):Promise<ApiResult<import('./types').Settings>>{return wrap(()=>updateSettings(settings));}
export async function aiRecommendation(symbol?:string):Promise<ApiResult<import('./types').AiRecommendation>>{return wrap(()=>getAiRecommendation(symbol));}
export async function closePositionApi(positionId:string):Promise<ApiResult<{ok:boolean;message:string}>>{return wrap(()=>closePosition(positionId));}
export async function closeAllApi():Promise<ApiResult<{ok:boolean;message:string}>>{return wrap(()=>closeAllPositions());}
export async function resetApi():Promise<ApiResult<{ok:boolean;message:string}>>{return wrap(()=>resetAccount());}
export async function validationApi(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={}):Promise<ApiResult<ValidationReport>>{return wrap(async()=>{const report=normalizeValidationReport(await runValidation(symbol,interval,cfg));await setValidationGate({status:report.gate.status,symbol,interval,candles:report.candles,testReturnPct:report.walkForward.test?.returnPct??0,testProfitFactor:report.walkForward.test?.profitFactor??0,monteCarloLossPct:report.monteCarlo.probabilityOfLoss});return report;});}
