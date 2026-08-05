export interface BinanceSymbol {
  symbol:string;
  baseAsset:string;
  quoteAsset:string;
  price:number;
  changePct:number;
  quoteVolume:number;
  volume:number;
}

export async function fetchBinanceUniverse():Promise<BinanceSymbol[]> {
  const res=await fetch('/api/binance-universe?kind=universe',{headers:{accept:'application/json'}});
  if(!res.ok)throw new Error(`Unable to load Binance symbols (${res.status}).`);
  const body=await res.json() as {ok?:boolean;symbols?:BinanceSymbol[];error?:string};
  if(!body.ok)throw new Error(body.error??'Unable to load Binance symbols.');
  return body.symbols??[];
}

export async function fetchBinanceKlines(symbol:string,interval='5m',limit=180):Promise<{ts:number;price:number}[]> {
  const qs=new URLSearchParams({kind:'klines',symbol:symbol.replace('/',''),interval});
  qs.set('limit',String(limit));
  const res=await fetch(`/api/binance-universe?${qs.toString()}`,{headers:{accept:'application/json'}});
  if(!res.ok)throw new Error(`Unable to load Binance price history (${res.status}).`);
  const body=await res.json() as {ok?:boolean;klines?:unknown[][];error?:string};
  if(!body.ok)throw new Error(body.error??'Unable to load Binance price history.');
  return (body.klines??[]).map(row=>({ts:Number(row[0]),price:Number(row[4])})).filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.price)&&x.price>0);
}
