export interface TargetLevel{r:number;fraction:number;moveStopToBreakeven?:boolean;}
/** Fixed production ladder: TP1 0.5R (15%), TP2 1.5R (25%), TP3 3R (60%). 
 * Target: higher asymmetry with tail-end capture */
export const TARGET_LADDER:readonly TargetLevel[]=[
  {r:0.5,fraction:0.15,moveStopToBreakeven:true},
  {r:1.5,fraction:0.25,moveStopToBreakeven:false},
  {r:3.0,fraction:0.60,moveStopToBreakeven:false},
] as const;
export const FINAL_TARGET_R=3;
export function targetPrice(side:1|-1,entry:number,risk:number,r:number):number{return entry+side*risk*r;}
/** TP1 -> breakeven; TP2 -> +0.5R; TP3 closes the remainder. */
export function protectedStopAfterTarget(side:1|-1,entry:number,risk:number,stage:number,currentStop:number):number{
  if(!(risk>0)||!Number.isFinite(entry)||!Number.isFinite(currentStop))return currentStop;
  const lockR=stage>=2?0.5:stage>=1?0:-Infinity;if(!Number.isFinite(lockR))return currentStop;
  const desired=entry+side*risk*lockR;return side===1?Math.max(currentStop,desired):Math.min(currentStop,desired);
}
