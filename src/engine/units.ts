/** Trade friction expressed in R units so cost is compared to stop distance. */
export function calculateCostInR(entryPrice:number,stopLossPrice:number,feeBpsPerSide=10,slippageBpsPerSide=2):number{
 const initialRisk=Math.abs(entryPrice-stopLossPrice);
 if(initialRisk<=0||!Number.isFinite(initialRisk)||entryPrice<=0)return Infinity;
 const totalBps=(feeBpsPerSide+slippageBpsPerSide)*2;
 return entryPrice*(totalBps/10000)/initialRisk;
}
export function isCostViable(entryPrice:number,stopLossPrice:number,maxCostR=.15,feeBpsPerSide=10,slippageBpsPerSide=2):boolean{
 return calculateCostInR(entryPrice,stopLossPrice,feeBpsPerSide,slippageBpsPerSide)<=maxCostR;
}
