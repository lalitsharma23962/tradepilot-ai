export interface TargetTier{multipleR:number;allocationPct:number;moveStopToBreakeven:boolean;}
export const DEFAULT_TARGETS:TargetTier[]=[
  {multipleR:0.5,allocationPct:.15,moveStopToBreakeven:true},
  {multipleR:1.0,allocationPct:.25,moveStopToBreakeven:false},
  {multipleR:2.0,allocationPct:.60,moveStopToBreakeven:false}
];
export function calculateTargetPrices(entryPrice:number,stopLossPrice:number,isLong:boolean,targets:TargetTier[]=DEFAULT_TARGETS){const rDistance=Math.abs(entryPrice-stopLossPrice);return targets.map(t=>({multipleR:t.multipleR,allocationPct:t.allocationPct,moveStopToBreakeven:t.moveStopToBreakeven,price:isLong?entryPrice+rDistance*t.multipleR:entryPrice-rDistance*t.multipleR}));}
