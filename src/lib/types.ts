// Shared domain types for the TradePilot AI paper-trading engine.
export type BotStatus='STOPPED'|'RUNNING';
export type Side='LONG'|'SHORT';
export type RiskLevel='Conservative'|'Balanced'|'Aggressive';
export type ThemeMode='Dark'|'Light'|'System';
export interface Account{id:number;cash:number;equity:number;total_pnl:number;realized_pnl:number;bot_status:BotStatus;started_at:string|null;last_tick_at:string|null;max_positions:number;max_strategies:number;max_allocation_pct:number;default_allocation_pct:number;stop_loss_pct:number;take_profit_pct:number;confidence_threshold_pct:number;leverage:number;loss_limit_pct:number;risk_pause_until:string|null;fee_bps:number;slippage_bps:number;risk_level:RiskLevel;theme:ThemeMode;trade_alerts:boolean;pnl_alerts:boolean;risk_alerts:boolean;}
export interface Position{id:string;symbol:string;side:Side;quantity:number;entry_price:number;current_price:number;notional:number;unrealized_pnl:number;stop_loss:number;take_profit:number;strategy:string;status:string;opened_at:string;}
export interface Trade{id:string;symbol:string;side:Side;quantity:number;entry_price:number;exit_price:number;pnl:number;return_pct:number;strategy:string;status:string;opened_at:string;closed_at:string;}
export interface Snapshot{id:string;equity:number;cash:number;open_value:number;unrealized_pnl:number;realized_pnl:number;ts:string;}
export interface Performance{equity:number;total_pnl:number;realized_pnl:number;unrealized_pnl:number;win_rate:number;wins:number;losses:number;trade_count:number;open_positions:number;best_trade:number;worst_trade:number;avg_trade:number;profit_factor:number;max_drawdown:number;max_drawdown_pct:number;}
export interface MarketTick{symbol:string;price:number;change_pct:number;ts:number;}
export interface AiRecommendation{symbol:string;action:'LONG'|'SHORT'|'WAIT';confidence:number;threshold?:number;entry:number;stop_loss:number;take_profit:number;risk_score:number;explanation:string;}
export interface Settings{risk_level:RiskLevel;max_allocation_pct:number;default_allocation_pct:number;stop_loss_pct:number;take_profit_pct:number;confidence_threshold_pct:number;max_strategies:number;leverage:number;loss_limit_pct:number;fee_bps:number;slippage_bps:number;theme:ThemeMode;trade_alerts:boolean;pnl_alerts:boolean;risk_alerts:boolean;}
