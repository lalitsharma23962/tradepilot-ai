export interface TargetTier{multipleR:number;allocationPct:number;moveStopToBreakeven:boolean;}
/** Shared production target model: 3R protect, 5R partial, 10R runner. */
export const DEFAULT_TARGETS:TargetTier[]=[{multipleR:3,allocationPct:.25,moveStopToBreakeven:true},{multipleR:5,allocationPct:.25,moveStopToBreakeven:false},{multipleR:10,allocationPct:.5,moveStopToBreakeven:false}];
export function calculateTargetPrices(entryPrice:number,stopLossPrice:number,isLong:boolean,targets:TargetTier[]=DEFAULT_TARGETS){const rDistance=Math.abs(entryPrice-stopLossPrice);return targets.map(target=>({...target,price:isLong?entryPrice+rDistance*target.multipleR:entryPrice-rDistance*target.multipleR}));}
