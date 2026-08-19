export interface TargetLevel{r:number;fraction:number;moveStopToBreakeven?:boolean;}
/** Asymmetric production ladder: 3R -> protect at breakeven, 5R -> take 50%, 10R -> close the runner. */
export const TARGET_LADDER:readonly TargetLevel[]=[
 {r:3.0,fraction:0.25,moveStopToBreakeven:true},
 {r:5.0,fraction:0.25,moveStopToBreakeven:false},
 {r:10.0,fraction:0.50,moveStopToBreakeven:false},
] as const;
export const FINAL_TARGET_R=10;
export function targetPrice(side:1|-1,entry:number,risk:number,r:number):number{return entry+side*risk*r;}
/** TP1 -> breakeven; TP2 -> lock +1R; TP3 closes the remainder. */
export function protectedStopAfterTarget(side:1|-1,entry:number,risk:number,stage:number,currentStop:number):number{
 if(!(risk>0)||!Number.isFinite(entry)||!Number.isFinite(currentStop))return currentStop;
 const lockR=stage>=2?1:stage>=1?0:-Infinity;if(!Number.isFinite(lockR))return currentStop;
 const desired=entry+side*risk*lockR;return side===1?Math.max(currentStop,desired):Math.min(currentStop,desired);
}
