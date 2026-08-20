export interface ValidationFold {
  foldIndex:number;
  trainTrades:number;
  oosTrades:number;
  profitFactor:number;
  expectancyR:number;
  maxDrawdownPct:number;
  returnPct:number;
  status:'PASS'|'FAIL'|'INSUFFICIENT_DATA';
}
export interface ValidationSummary {
  status:'PRODUCTION_CANDIDATE'|'REJECTED'|'INSUFFICIENT_DATA';
  totalOosTrades:number;
  minOosTradesRequired:number;
  folds:ValidationFold[];
  reason:string;
}
export function evaluateWalkForwardValidation(folds:ValidationFold[],minOosTradesPerFold=15,minTotalOosTrades=40,minProfitFactor=1.5,maxDrawdownPct=12):ValidationSummary{
 const totalOosTrades=folds.reduce((s,f)=>s+f.oosTrades,0);
 if(totalOosTrades<minTotalOosTrades)return{status:'INSUFFICIENT_DATA',totalOosTrades,minOosTradesRequired:minTotalOosTrades,folds,reason:`Total OOS trades (${totalOosTrades}) below required minimum (${minTotalOosTrades}). Statistically underpowered.`};
 const allPassed=folds.length>0&&folds.every(f=>f.oosTrades>=minOosTradesPerFold&&f.profitFactor>=minProfitFactor&&f.expectancyR>0&&f.maxDrawdownPct<=maxDrawdownPct&&f.status==='PASS');
 return{status:allPassed?'PRODUCTION_CANDIDATE':'REJECTED',totalOosTrades,minOosTradesRequired:minTotalOosTrades,folds,reason:allPassed?'All OOS folds passed trade-count, PF, expectancy and drawdown gates.':'One or more OOS folds failed the profitability, expectancy, drawdown or sample-size gates.'};
}
