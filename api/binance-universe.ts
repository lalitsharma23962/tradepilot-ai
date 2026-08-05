const BINANCE_BASE='https://data-api.binance.vision/api/v3';

function respond(res:any,body:unknown,status=200){res.status(status).setHeader('content-type','application/json').setHeader('cache-control','public, max-age=30, stale-while-revalidate=60').send(JSON.stringify(body));}

export default async function handler(req:any,res:any){
  try{
    if(req.method!=='GET')return respond(res,{error:'Method not allowed.'},405);
    const kind=String(req.query?.kind??'universe');
    if(kind==='klines'){
      const symbol=String(req.query?.symbol??'').trim().toUpperCase();
      const interval=String(req.query?.interval??'5m').trim();
      const limit=Math.min(500,Math.max(20,Number(req.query?.limit??180)));
      if(!/^[A-Z0-9_]+$/.test(symbol))return respond(res,{error:'Invalid symbol.'},400);
      const url=`${BINANCE_BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
      const r=await fetch(url,{headers:{accept:'application/json'}});
      if(!r.ok)throw new Error(`Binance klines request failed (${r.status}).`);
      return respond(res,{ok:true,klines:await r.json()});
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
