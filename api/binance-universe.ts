const BINANCE_BASE='https://data-api.binance.vision/api/v3';

function respond(res:any,body:unknown,status=200){res.status(status).setHeader('content-type','application/json').setHeader('cache-control','public, max-age=30, stale-while-revalidate=60').send(JSON.stringify(body));}
function intervalMs(interval:string){const m=interval.match(/^(\d+)([mhdw])$/i);if(!m)throw new Error(`Unsupported interval: ${interval}`);const n=Number(m[1]),u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:u==='d'?86400000:604800000);}
async function fetchKlines(symbol:string,interval:string,limit:number,startTime?:number,endTime?:number){
  const params=new URLSearchParams({symbol,interval,limit:String(Math.min(1000,Math.max(20,limit)))});
  if(startTime!==undefined)params.set('startTime',String(startTime));
  if(endTime!==undefined)params.set('endTime',String(endTime));
  const r=await fetch(`${BINANCE_BASE}/klines?${params.toString()}`,{headers:{accept:'application/json'}});
  if(!r.ok)throw new Error(`Binance klines request failed (${r.status}).`);
  return await r.json() as unknown[][];
}

export default async function handler(req:any,res:any){
  try{
    if(req.method!=='GET')return respond(res,{error:'Method not allowed.'},405);
    const kind=String(req.query?.kind??'universe');
    if(kind==='klines'||kind==='history'){
      const symbol=String(req.query?.symbol??'').trim().toUpperCase();
      const interval=String(req.query?.interval??'5m').trim();
      if(!/^[A-Z0-9_]+$/.test(symbol))return respond(res,{error:'Invalid symbol.'},400);
      if(kind==='klines'){
        const limit=Math.min(1000,Math.max(20,Number(req.query?.limit??180)));
        const startRaw=Number(req.query?.startTime),endRaw=Number(req.query?.endTime);
        const startTime=Number.isFinite(startRaw)&&startRaw>0?startRaw:undefined;
        const endTime=Number.isFinite(endRaw)&&endRaw>0?endRaw:undefined;
        return respond(res,{ok:true,klines:await fetchKlines(symbol,interval,limit,startTime,endTime)});
      }
      const total=Math.min(40000,Math.max(20000,Number(req.query?.total??20000)));
      const ms=intervalMs(interval);
      const rows:unknown[][]=[];
      let cursor=Math.max(0,Date.now()-total*ms);
      while(rows.length<total){
        const batch=await fetchKlines(symbol,interval,Math.min(1000,total-rows.length),cursor);
        if(!batch.length)break;
        rows.push(...batch);
        const last=Number(batch[batch.length-1]?.[0]);
        if(!Number.isFinite(last))break;
        cursor=last+ms;
        if(batch.length<Math.min(1000,total-rows.length+batch.length))break;
      }
      const seen=new Set<number>();
      const klines=rows.filter(r=>{const t=Number(r?.[0]);if(!Number.isFinite(t)||seen.has(t))return false;seen.add(t);return true;}).slice(-total);
      return respond(res,{ok:true,symbol,interval,requested:total,returned:klines.length,klines});
    }
    const [info,ticker]=await Promise.all([
      fetch(`${BINANCE_BASE}/exchangeInfo`,{headers:{accept:'application/json'}}),
      fetch(`${BINANCE_BASE}/ticker/24hr`,{headers:{accept:'application/json'}}),
    ]);
    if(!info.ok||!ticker.ok)throw new Error(`Binance market metadata request failed (${info.status}/${ticker.status}).`);
    const infoJson=await info.json() as any;
    const tickers=await ticker.json() as any[];
    const bySymbol=new Map(tickers.map(t=>[String(t.symbol),t]));
    const symbols=(infoJson.symbols??[])
      .filter((s:any)=>{
        if(s.status!=='TRADING')return false;
        if(s.isSpotTradingAllowed===true)return true;
        if(Array.isArray(s.permissions))return s.permissions.includes('SPOT');
        return s.isSpotTradingAllowed!==false;
      })
      .map((s:any)=>{const t=bySymbol.get(String(s.symbol));return{
        symbol:String(s.symbol),baseAsset:String(s.baseAsset),quoteAsset:String(s.quoteAsset),
        price:Number(t?.lastPrice??0),changePct:Number(t?.priceChangePercent??0),
        quoteVolume:Number(t?.quoteVolume??0),volume:Number(t?.volume??0),
      };})
      .filter((s:any)=>Number.isFinite(s.price)&&s.price>0)
      .sort((a:any,b:any)=>b.quoteVolume-a.quoteVolume);
    return respond(res,{ok:true,updatedAt:Date.now(),symbols});
  }catch(err){console.error('[binance-universe]',err);return respond(res,{error:err instanceof Error?err.message:'Binance market request failed.'},502);}
}
