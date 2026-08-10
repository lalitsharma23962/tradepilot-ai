export interface ValidationFold{foldIndex:number;trainTrades:number;oosTrades:number;profitFactor:number;expectancyR:number;maxDrawdownPct:number;returnPct:number;status:'PASS'|'FAIL'|'INSUFFICIENT_DATA';}
export interface ValidationSummary{status:'PRODUCTION_CANDIDATE'|'REJECTED'|'INSUFFICIENT_DATA';totalOosTrades:number;minOosTradesRequired:number;folds:ValidationFold[];reason:string;}
export function evaluateWalkForwardValidation(folds:ValidationFold[],minOosTradesPerFold=10,minTotalOosTrades=30):ValidationSummary{
 const totalOosTrades=folds.reduce((s,f)=>s+f.oosTrades,0);
 if(totalOosTrades<minTotalOosTrades)return{status:'INSUFFICIENT_DATA',totalOosTrades,minOosTradesRequired:minTotalOosTrades,folds,reason:`Total OOS trades (${totalOosTrades}) below required minimum (${minTotalOosTrades}). Statistically underpowered.`};
 const allPassed=folds.length>0&&folds.every(f=>f.oosTrades>=minOosTradesPerFold&&f.profitFactor>1.05&&f.status==='PASS');
 return{status:allPassed?'PRODUCTION_CANDIDATE':'REJECTED',totalOosTrades,minOosTradesRequired:minTotalOosTrades,folds,reason:allPassed?'All folds passed minimum trade and profitability gates.':'One or more folds failed profitability or minimum trade count thresholds.'};
}
