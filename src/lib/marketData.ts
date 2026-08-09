export interface MarketBar{openTime:number;open:number;high:number;low:number;close:number;volume:number;}
const CACHE_MS=2500;
const MAX_LIVE_BARS=50000;
const cache=new Map<string,{at:number;bars:MarketBar[]}>();
function normalize(rows:unknown[][]):MarketBar[]{const seen=new Set<number>();return rows.map(r=>({openTime:Number(r?.[0]),open:Number(r?.[1]),high:Number(r?.[2]),low:Number(r?.[3]),close:Number(r?.[4]),volume:Number(r?.[5])})).filter(x=>[x.openTime,x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)&&x.open>0&&x.high>0&&x.low>0&&x.close>0&&!seen.has(x.openTime)&&seen.add(x.openTime)).sort((a,b)=>a.openTime-b.openTime);}
export async function fetchMarketBars(symbol='BTCUSDT',interval='5m',limit=240):Promise<MarketBar[]>{
 const target=Math.min(MAX_LIVE_BARS,Math.max(50,limit)),key=`${symbol}:${interval}:${target}`,old=cache.get(key);
 if(old&&Date.now()-old.at<CACHE_MS)return old.bars;
 const rows:unknown[][]=[];let endTime:number|undefined;
 while(rows.length<target){
  const batchLimit=Math.min(1000,target-rows.length);
  const params=new URLSearchParams({kind:'klines',symbol,interval,limit:String(batchLimit)});
  if(endTime!==undefined)params.set('endTime',String(endTime));
  const res=await fetch(`/api/binance-universe?${params.toString()}`,{headers:{accept:'application/json'},cache:'no-store'});
  if(!res.ok)throw new Error(`Live market data request failed (${res.status}).`);
  const body=await res.json() as {ok?:boolean;error?:string;klines?:unknown[][]};
  if(!body.ok||!Array.isArray(body.klines))throw new Error(body.error??'Live market data response was invalid.');
  const rawBatch=body.klines;
  const batch=normalize(rawBatch).filter(b=>b.openTime+intervalMs(interval)<=Date.now());
  if(!batch.length)break;
  rows.unshift(...rawBatch.filter(r=>Number(r?.[0])+intervalMs(interval)<=Date.now()));
  const earliest=batch[0].openTime;
  if(!Number.isFinite(earliest)||rawBatch.length<batchLimit)break;
  endTime=earliest-1;
 }
 const bars=normalize(rows).slice(-target);
 if(bars.length<50)throw new Error(`Insufficient completed market bars for ${symbol} ${interval}.`);
 cache.set(key,{at:Date.now(),bars});
 return bars;
}
function intervalMs(interval:string){const m=interval.match(/^(\d+)([mhd])$/i);if(!m)throw new Error(`Unsupported interval: ${interval}`);const n=Number(m[1]),u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:86400000);}
export async function fetchLatestBars(symbol='BTCUSDT',interval='5m',limit=240){return fetchMarketBars(symbol,interval,limit);}
