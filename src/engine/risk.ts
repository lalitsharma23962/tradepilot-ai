export interface SizingParameters{accountEquity:number;riskPct:number;entryPrice:number;stopLossPrice:number;maxPositionPct?:number;maxLeverage?:number;}
export interface SizingResult{requestedRiskPct:number;riskBudgetDollars:number;stopDistance:number;riskPerUnit:number;calculatedQuantity:number;maxNotionalQuantity:number;finalQuantity:number;bindingConstraint:'RISK'|'MAX_NOTIONAL'|'MAX_LEVERAGE'|'INVALID_STOP';effectiveRiskPct:number;effectiveNotional:number;leverageRequired:number;}
export function calculatePositionSize(p:SizingParameters):SizingResult{
 const {accountEquity,riskPct,entryPrice,stopLossPrice,maxPositionPct=1,maxLeverage=10}=p;
 const stopDistance=Math.abs(entryPrice-stopLossPrice);
 if(stopDistance<=0||entryPrice<=0||accountEquity<=0)return{requestedRiskPct:riskPct,riskBudgetDollars:0,stopDistance,riskPerUnit:0,calculatedQuantity:0,maxNotionalQuantity:0,finalQuantity:0,bindingConstraint:'INVALID_STOP',effectiveRiskPct:0,effectiveNotional:0,leverageRequired:0};
 const riskBudgetDollars=accountEquity*riskPct,calculatedQuantity=riskBudgetDollars/stopDistance;
 const maxNotionalDollars=accountEquity*maxPositionPct*maxLeverage,maxNotionalQuantity=maxNotionalDollars/entryPrice;
 const finalQuantity=Math.min(calculatedQuantity,maxNotionalQuantity);
 const bindingConstraint=calculatedQuantity>maxNotionalQuantity?'MAX_NOTIONAL':'RISK';
 const effectiveNotional=finalQuantity*entryPrice,effectiveRiskPct=(finalQuantity*stopDistance)/accountEquity;
 return{requestedRiskPct:riskPct,riskBudgetDollars,stopDistance,riskPerUnit:stopDistance,calculatedQuantity,maxNotionalQuantity,finalQuantity,bindingConstraint,effectiveRiskPct,effectiveNotional,leverageRequired:effectiveNotional/accountEquity};
}
