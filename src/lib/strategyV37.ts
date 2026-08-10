import type { MarketBar } from './marketData';
import { evaluateProductionStrategy as evaluateV38, evaluateResearchStrategy as researchV38, evaluateStrategy as strategyV38 } from './strategyV35';
import type { StrategyConfig, StrategySignal } from './strategyV32';
import { FINAL_TARGET_R, TARGET_LADDER } from './targetLadder';
export type { StrategyConfig, StrategySignal } from './strategyV32';
export interface StrategyTarget{r:number;fraction:number;price:number;moveStopToBreakeven?:boolean;}
export type StrategySignalV37=StrategySignal&{targets?:StrategyTarget[];finalTargetR?:number;};
function normalize(signal:StrategySignal):StrategySignalV37{
 if(signal.action==='WAIT')return signal;const side=signal.action==='LONG'?1:-1,risk=Math.abs(signal.entry-signal.stopLoss);if(!(risk>0)||!Number.isFinite(risk))return signal;
 const targets=TARGET_LADDER.map(level=>({r:level.r,fraction:level.fraction,price:signal.entry+side*risk*level.r,moveStopToBreakeven:level.moveStopToBreakeven}));const finalTarget=targets.at(-1)!.price;
 return{...signal,strategy:'Production Regime Breakout v38',takeProfit:finalTarget,riskReward:FINAL_TARGET_R,targets,finalTargetR:FINAL_TARGET_R,reasons:[...signal.reasons.filter(x=>!x.toLowerCase().includes('dynamic target')),'Fixed 1:2 risk/reward plan','Profit ladder: 1R / 1.5R / 2R','25% exit at TP1, 25% exit at TP2, 50% exit at TP3','Stop management: breakeven after TP1, +0.5R after TP2']};
}
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV37{return normalize(evaluateV38(input,config));}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV37{return normalize(researchV38(input,config));}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV37{return normalize(strategyV38(input,config));}
